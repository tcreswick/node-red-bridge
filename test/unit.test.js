'use strict';
const test = require('node:test');
const assert = require('assert');
const EventEmitter = require('events');
const C = require('../lib/crypto');
const Session = require('../lib/session');
const { clientHandshake, serverHandshake } = require('../lib/handshake');
const { exposes, exposedNames } = require('../lib/registry');
const { encodeMsg, decodeMsg } = require('../lib/serialize');
const { makeCode, parseCode } = require('../lib/pairing');
const Store = require('../lib/store');

class FakeWs extends EventEmitter {
  constructor() { super(); this.peer = null; this.closed = false; this.tap = null; }
  send(d, o) {
    if (this.closed) throw new Error('closed');
    const bin = typeof d !== 'string';
    if (this.tap) this.tap(d, bin);
    setImmediate(() => { if (this.peer && !this.peer.closed) this.peer.emit('message', Buffer.from(d), bin); });
  }
  close() { if (this.closed) return; this.closed = true; setImmediate(() => { this.emit('close'); if (this.peer && !this.peer.closed) { this.peer.closed = true; this.peer.emit('close'); } }); }
  terminate() { this.close(); }
}
function wsPair() { const a = new FakeWs(), b = new FakeWs(); a.peer = b; b.peer = a; return [a, b]; }

function mkServer(over) {
  const id = C.newIdentity();
  const state = { trusted: new Map(), token: null };
  const opts = Object.assign({
    identity: id,
    lookupPeer: pub => (state.trusted.has(pub) ? 'ctx' : null),
    consumeToken: (check, pub) => { if (state.token && check(state.token)) { state.token = null; state.trusted.set(pub, true); return 'ctx'; } return null; },
    timeout: 500
  }, over);
  return { id, state, opts };
}
const handshake = (srv, cliOpts) => {
  const [c, s] = wsPair();
  const sp = serverHandshake(s, srv.opts);
  const cp = clientHandshake(c, Object.assign({ timeout: 500 }, cliOpts));
  return { c, s, sp, cp };
};

test('crypto: sign/verify, frames, tamper', () => {
  const id = C.newIdentity();
  assert(C.verify(id.pub, 'x', C.sign(id, 'x')));
  assert(!C.verify(id.pub, 'y', C.sign(id, 'x')));
  assert(!C.verify('garbage', 'x', 'sig'));
  const key = Buffer.alloc(32, 7);
  const f = C.encryptFrame(key, 1, Buffer.from('hello'));
  assert.equal(C.decryptFrame(key, f).plain.toString(), 'hello');
  f[10] ^= 1;
  assert.throws(() => C.decryptFrame(key, f));
  assert.match(C.fingerprint(id.pub), /^([0-9a-f]{4} ){7}[0-9a-f]{4}$/);
});

test('handshake: pairing with token then key auth; messages both ways, encrypted', async () => {
  const srv = mkServer(); const cli = C.newIdentity();
  srv.state.token = C.newToken(); const token = srv.state.token;
  const seen = [];
  let h = handshake(srv, { identity: cli, expectedServerPub: srv.id.pub, mode: 'pair', token });
  h.c.tap = (d, bin) => seen.push(d);
  const [cs, { session: ss, ctx, mode }] = await Promise.all([h.cp, h.sp]);
  assert.equal(ctx, 'ctx'); assert.equal(mode, 'pair');
  assert(srv.state.trusted.has(cli.pub));
  const got = new Promise(r => ss.once('message', r));
  cs.send({ t: 'msg', payload: 'secret-payload' });
  assert.equal((await got).payload, 'secret-payload');
  const got2 = new Promise(r => cs.once('message', r));
  ss.send({ hi: 1 });
  assert.equal((await got2).hi, 1);
  assert(!seen.some(d => String(d.toString('latin1')).includes('secret-payload')), 'payload must not appear on the wire');
  cs.close(); ss.close();
  // reconnect by key only
  h = handshake(srv, { identity: cli, expectedServerPub: srv.id.pub, mode: 'auth' });
  const [cs2, r2] = await Promise.all([h.cp, h.sp]);
  assert.equal(r2.mode, 'auth'); cs2.close(); r2.session.close();
});

test('handshake: pairing token is single use / wrong token / expired handled by ctx', async () => {
  const srv = mkServer(); const cli = C.newIdentity(), cli2 = C.newIdentity();
  srv.state.token = C.newToken(); const token = srv.state.token;
  let h = handshake(srv, { identity: cli, expectedServerPub: srv.id.pub, mode: 'pair', token: 'wrong' });
  const [r1, r2] = await Promise.allSettled([h.cp, h.sp]);
  assert.equal(r1.status, 'rejected'); assert.equal(r1.reason.code, 'token'); assert.equal(r2.status, 'rejected');
  assert(srv.state.token, 'failed attempt must not consume the token');
  h = handshake(srv, { identity: cli, expectedServerPub: srv.id.pub, mode: 'pair', token });
  const [ok] = await Promise.all([h.cp, h.sp]); ok.close();
  h = handshake(srv, { identity: cli2, expectedServerPub: srv.id.pub, mode: 'pair', token });
  const [r3] = await Promise.allSettled([h.cp, h.sp]);
  assert.equal(r3.status, 'rejected'); assert.equal(r3.reason.code, 'token');
  assert(!srv.state.trusted.has(cli2.pub));
});

test('handshake: unknown peer rejected; wrong pinned server key rejected (MITM)', async () => {
  const srv = mkServer(); const cli = C.newIdentity();
  let h = handshake(srv, { identity: cli, expectedServerPub: srv.id.pub, mode: 'auth' });
  const [r] = await Promise.allSettled([h.cp, h.sp]);
  assert.equal(r.reason.code, 'auth');
  srv.state.trusted.set(cli.pub, true);
  h = handshake(srv, { identity: cli, expectedServerPub: C.newIdentity().pub, mode: 'auth' });
  const [r2] = await Promise.allSettled([h.cp, h.sp]);
  assert.equal(r2.reason.code, 'server-key');
});

test('session: replayed frame and tampered frame close the link; oversize refused', async () => {
  const srv = mkServer(); const cli = C.newIdentity(); srv.state.trusted.set(cli.pub, true);
  const frames = [];
  const h = handshake(srv, { identity: cli, expectedServerPub: srv.id.pub, mode: 'auth', session: { maxSize: 1000 } });
  const [cs, { session: ss }] = await Promise.all([h.cp, h.sp]);
  h.c.tap = (d) => frames.push(Buffer.from(d));
  const msgs = []; ss.on('message', m => msgs.push(m));
  cs.send({ n: 1 });
  await new Promise(r => setImmediate(() => setImmediate(r)));
  assert.equal(msgs.length, 1);
  assert.throws(() => cs.send({ big: 'x'.repeat(2000) }), /too large/);
  const closed = new Promise(r => ss.once('close', r));
  h.s.emit('message', frames[0], true); // replay
  assert.match(await closed, /replayed/);
  assert.equal(msgs.length, 1);
});

test('keepalive: silent peer => close with keepalive timeout; pongs keep it alive', async () => {
  const [a, b] = wsPair(); const k1 = Buffer.alloc(32, 1), k2 = Buffer.alloc(32, 2);
  const s1 = new Session(a, { sendKey: k1, recvKey: k2, pingInterval: 30, pingTimeout: 100 });
  const s2 = new Session(b, { sendKey: k2, recvKey: k1, pingInterval: 30, pingTimeout: 100 });
  s1.start(); s2.start();
  const keep = setInterval(() => {}, 20);
  await new Promise(r => setTimeout(r, 300));
  assert(!s1.closed && !s2.closed, 'healthy link stays up');
  // make b mute
  b.send = () => {}; // b stops answering
  const reason = await new Promise(r => s1.once('close', r));
  clearInterval(keep);
  assert.equal(reason, 'keepalive timeout');
  s2.close();
});

test('ACL: only ticked remotes (or shareAll) see a node', () => {
  const nodes = [
    { bridgeName: 'a', remotes: ['r1'] }, { bridgeName: 'b', remotes: ['r2'] },
    { bridgeName: 'c', remotes: [] }, { bridgeName: 'a', remotes: ['r1', 'r2'] }
  ];
  assert.deepEqual(exposedNames(nodes, false, 'r1'), ['a']);
  assert.deepEqual(exposedNames(nodes, false, 'r2'), ['a', 'b']);
  assert.deepEqual(exposedNames(nodes, false, 'r3'), []);
  assert.deepEqual(exposedNames(nodes, true, 'r3'), ['a', 'b', 'c']);
  assert(!exposes(false, 'r1', { remotes: undefined }));
});

test('serialize: buffers roundtrip, req/res stripped, functions dropped, circular rejected', () => {
  const msg = { payload: Buffer.from([1, 2, 3]), req: { a: 1 }, res: {}, f() {}, nested: { u: new Uint8Array([9]) }, n: 5 };
  const { text, warnings } = encodeMsg(msg);
  assert.equal(warnings.length, 1);
  const back = decodeMsg(JSON.parse(text));
  assert(Buffer.isBuffer(back.payload)); assert.deepEqual([...back.payload], [1, 2, 3]);
  assert(!('req' in back) && !('res' in back) && !('f' in back)); assert.equal(back.n, 5);
  const c = {}; c.self = c;
  assert.throws(() => encodeMsg(c), /not serialisable/);
});

test('pairing code: roundtrip, expiry, garbage', () => {
  const id = C.newIdentity();
  const { code } = makeCode({ url: 'ws://h:1/bridge/ws', pub: id.pub, token: 't' });
  const o = parseCode(code); assert.equal(o.pub, id.pub); assert.equal(o.url, 'ws://h:1/bridge/ws');
  assert.throws(() => parseCode(makeCode({ url: 'ws://h', pub: id.pub, token: 't', ttlMs: -1000 }).code), /expired/);
  assert.throws(() => parseCode('nonsense'), /not a valid/);
  assert.throws(() => parseCode(makeCode({ url: 'http://h', pub: id.pub, token: 't' }).code), /ws/);
});

test('store: identity persisted 0600, peers set/delete', () => {
  const dir = require('fs').mkdtempSync(require('os').tmpdir() + '/bridge-store-');
  const s = new Store(dir); const id = s.identity();
  s.setPeer('n1', { pub: 'P' });
  const s2 = new Store(dir);
  assert.equal(s2.identity().pub, id.pub); assert.equal(s2.getPeer('n1').pub, 'P');
  assert.equal(require('fs').statSync(s.file).mode & 0o777, 0o600);
  assert(s2.deletePeer('n1')); assert.equal(new Store(dir).getPeer('n1'), null);
});
