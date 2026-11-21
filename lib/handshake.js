'use strict';
// Mutual-authentication handshake (Ed25519 signatures over a transcript, X25519 ephemeral ECDH,
// optional one-time pairing token proven by HMAC). Works over any ws-like object.
const C = require('./crypto');
const Session = require('./session');

function hsErr(code, msg) { const e = new Error(msg); e.code = code; return e; }

class Reader { // queues incoming frames so none are lost between handshake steps
  constructor(ws) {
    this.ws = ws; this.q = []; this.waiter = null; this.dead = null;
    this.onMsg = (data, isBinary) => { this.q.push({ data, isBinary }); this._wake(); };
    this.onClose = () => { this.dead = hsErr('closed', 'connection closed during handshake'); this._wake(); };
    this.onErr = e => { this.dead = hsErr('closed', 'socket error: ' + (e && e.message)); this._wake(); };
    ws.on('message', this.onMsg); ws.on('close', this.onClose); ws.on('error', this.onErr);
  }
  _wake() { if (this.waiter) { const w = this.waiter; this.waiter = null; w(); } }
  next(timeout) {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (this.q.length) { clearTimeout(t); return resolve(this.q.shift()); }
        if (this.dead) { clearTimeout(t); return reject(this.dead); }
        this.waiter = check;
      };
      const t = setTimeout(() => { this.waiter = null; reject(hsErr('timeout', 'handshake timed out')); }, timeout);
      check();
    });
  }
  async json(timeout) {
    const f = await this.next(timeout);
    if (f.isBinary) throw hsErr('protocol', 'unexpected binary frame');
    try { return JSON.parse(f.data.toString()); } catch (e) { throw hsErr('protocol', 'bad handshake frame'); }
  }
  release() {
    this.ws.removeListener('message', this.onMsg); this.ws.removeListener('close', this.onClose);
    this.ws.removeListener('error', this.onErr);
    return this.q.splice(0);
  }
}

const isStr = (v, max = 512) => typeof v === 'string' && v.length > 0 && v.length <= max;

// opts: identity, expectedServerPub (pin), mode 'auth'|'pair', token, timeout, session opts
async function clientHandshake(ws, opts) {
  const timeout = opts.timeout || 10000, mode = opts.mode === 'pair' ? 'pair' : 'auth';
  const rd = new Reader(ws);
  try {
    const eph = C.ephemeral(), nonceC = C.nonce();
    ws.send(JSON.stringify({ t: 'hello', v: 1, mode, pub: opts.identity.pub, eph: eph.pub, nonce: nonceC }));
    const ch = await rd.json(timeout);
    if (ch.t === 'error') throw hsErr(ch.code || 'protocol', ch.msg || 'remote rejected the connection');
    if (ch.t !== 'challenge' || !isStr(ch.pub) || !isStr(ch.eph) || !isStr(ch.nonce) || !isStr(ch.sig)) throw hsErr('protocol', 'bad challenge');
    if (!opts.expectedServerPub || ch.pub !== opts.expectedServerPub) throw hsErr('server-key', 'remote identity key does not match the paired key');
    const tr = C.transcript([opts.identity.pub, eph.pub, nonceC, ch.pub, ch.eph, ch.nonce]);
    if (!C.verify(ch.pub, 'srv|' + tr, ch.sig)) throw hsErr('server-key', 'remote signature invalid');
    const auth = { t: 'auth', sig: C.sign(opts.identity, 'cli|' + tr) };
    if (mode === 'pair') auth.proof = C.proof(opts.token, tr);
    ws.send(JSON.stringify(auth));
    let keys;
    try { keys = C.deriveKeys(C.ecdh(eph.priv, ch.eph), tr); } catch (e) { throw hsErr('protocol', 'bad ephemeral key'); }
    const session = new Session(ws, Object.assign({}, opts.session, { sendKey: keys.c2s, recvKey: keys.s2c, peerPub: ch.pub }));
    const f = await rd.next(timeout);
    if (!f.isBinary) {
      let e; try { e = JSON.parse(f.data.toString()); } catch (x) { e = {}; }
      throw hsErr(e.code || 'protocol', e.msg || 'remote rejected the connection');
    }
    let ready; try { ready = JSON.parse(session.decode(f.data).toString()); } catch (e) { throw hsErr('protocol', 'bad ready frame'); }
    if (ready.t !== 'ready') throw hsErr('protocol', 'expected ready');
    session.start(rd.release());
    return session;
  } catch (e) { rd.release(); throw e; }
}

// opts: identity, lookupPeer(pub)->ctx|null, consumeToken(check(token)->bool, pub)->ctx|null, timeout, session opts
async function serverHandshake(ws, opts) {
  const timeout = opts.timeout || 10000;
  const rd = new Reader(ws);
  const fail = (code, msg) => {
    try { ws.send(JSON.stringify({ t: 'error', code, msg })); } catch (e) { /* ignore */ }
    try { ws.close(); } catch (e) { /* ignore */ }
    return hsErr(code, msg);
  };
  try {
    const h = await rd.json(timeout);
    if (h.t !== 'hello' || h.v !== 1 || (h.mode !== 'auth' && h.mode !== 'pair') || !isStr(h.pub) || !isStr(h.eph) || !isStr(h.nonce)) throw fail('protocol', 'bad hello');
    const eph = C.ephemeral(), nonceS = C.nonce();
    const tr = C.transcript([h.pub, h.eph, h.nonce, opts.identity.pub, eph.pub, nonceS]);
    ws.send(JSON.stringify({ t: 'challenge', pub: opts.identity.pub, eph: eph.pub, nonce: nonceS, sig: C.sign(opts.identity, 'srv|' + tr) }));
    const a = await rd.json(timeout);
    if (a.t !== 'auth' || !isStr(a.sig)) throw fail('protocol', 'bad auth');
    if (!C.verify(h.pub, 'cli|' + tr, a.sig)) throw fail('auth', 'client signature invalid');
    let ctx;
    if (h.mode === 'auth') {
      ctx = opts.lookupPeer(h.pub);
      if (!ctx) throw fail('auth', 'unknown peer: not paired (or unpaired) on the remote side');
    } else {
      if (!isStr(a.proof)) throw fail('token', 'missing pairing proof');
      ctx = opts.consumeToken(token => C.safeEqual(C.proof(token, tr), a.proof), h.pub);
      if (!ctx) throw fail('token', 'pairing code invalid, expired or already used');
    }
    let keys;
    try { keys = C.deriveKeys(C.ecdh(eph.priv, h.eph), tr); } catch (e) { throw fail('protocol', 'bad ephemeral key'); }
    const session = new Session(ws, Object.assign({}, opts.session, { sendKey: keys.s2c, recvKey: keys.c2s, peerPub: h.pub }));
    session.send({ t: 'ready' });
    session.start(rd.release());
    return { session, ctx, mode: h.mode, peerPub: h.pub };
  } catch (e) { rd.release(); throw e; }
}

module.exports = { clientHandshake, serverHandshake, Reader, hsErr };
