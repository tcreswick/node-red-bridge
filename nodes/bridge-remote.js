'use strict';
const EventEmitter = require('events');
const crypto = require('crypto');
const WebSocket = require('ws');
const Store = require('../lib/store');
const C = require('../lib/crypto');
const { clientHandshake } = require('../lib/handshake');
const { getListener } = require('../lib/listener');
const { getRegistry, exposes, exposedNames } = require('../lib/registry');
const { encodeMsg, decodeMsg } = require('../lib/serialize');
const { makeCode, parseCode } = require('../lib/pairing');
const { nodeStatus } = require('../lib/status');

const ACK_TIMEOUT = 30000;

module.exports = function (RED) {
  const reg = getRegistry(RED);
  let store = null;
  const getStore = () => store || (store = new Store(RED.settings.userDir));

  function BridgeRemote(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.role = config.role === 'listen' ? 'listen' : 'connect';
    node.url = (config.url || '').trim();
    node.publicUrl = (config.publicUrl || '').trim();
    node.path = (config.path || '/bridge/ws').trim() || '/bridge/ws';
    if (node.path[0] !== '/') node.path = '/' + node.path;
    const num = (v, d, min) => { const n = Number(v); return Number.isFinite(n) && n >= min ? n : d; };
    node.pingInterval = num(config.pingInterval, 15, 0) * 1000;
    node.pingTimeout = num(config.pingTimeout, 45, 1) * 1000;
    node.backoffMin = num(config.backoffMin, 1, 0.05) * 1000;
    node.backoffMax = Math.max(node.backoffMin, num(config.backoffMax, 60, 0.05) * 1000);
    node.maxSize = Math.round(num(config.maxSize, 10, 0.001) * 1024 * 1024);
    node.shareAll = !!config.shareAll;
    node.bus = new EventEmitter(); node.bus.setMaxListeners(0);
    node.state = node.role === 'listen' ? 'waiting' : 'connecting';
    node.reason = ''; node.since = Date.now();
    node.session = null; node.remoteCatalog = { ins: [], outs: [] };
    node.pairing = null;
    const pendingAcks = new Map(), pendingCalls = new Map();
    let closed = false, retryTimer = null, attempt = 0, dialing = false, lastCatalog = '', catTimer = null, activeWs = null;

    reg.configs.set(node.id, node);

    node.setState = function (state, reason) {
      if (node.state === state && (reason || '') === node.reason) return;
      const prev = node.state;
      node.state = state; node.reason = reason || ''; node.since = Date.now();
      node.status(nodeStatus(state));
      if (state === 'online') node.log('bridge link online' + (node.name ? ' (' + node.name + ')' : ''));
      else if (prev === 'online') node.warn('bridge link ' + state + (reason ? ': ' + reason : ''));
      else if (reason) node.log(`bridge ${state}: ${reason}`);
      node.bus.emit('state', { state, reason: node.reason, since: node.since, previous: prev });
    };
    node.status(nodeStatus(node.state));
    node.label = () => node.name || node.id;
    node.isOnline = () => node.state === 'online' && !!node.session && !node.session.closed;
    node.exposes = n => exposes(node.shareAll, node.id, n);
    node.peer = () => getStore().getPeer(node.id);
    node.trusts = pub => { const p = getStore().getPeer(node.id); return !!p && p.pub === pub; };
    node.consumeToken = (check, pub) => {
      const p = node.pairing;
      if (!p || p.exp < Date.now()) return false;
      if (!check(p.token)) return false;
      node.pairing = null; // single use
      getStore().setPeer(node.id, { pub });
      node.log('paired with new peer ' + C.fingerprint(pub));
      return true;
    };
    node.info = () => {
      const p = node.peer();
      return { role: node.role, state: node.state, reason: node.reason, since: node.since,
        paired: !!p, peerFingerprint: p ? C.fingerprint(p.pub) : null, localFingerprint: C.fingerprint(getStore().identity().pub),
        ins: node.remoteCatalog.ins, outs: node.remoteCatalog.outs, pairingExpires: node.pairing ? node.pairing.exp : null };
    };

    // ---- catalog / discovery ----
    node.localCatalog = () => ({
      t: 'catalog',
      ins: exposedNames(reg.ins, node.shareAll, node.id),
      outs: exposedNames(reg.outs, node.shareAll, node.id)
    });
    node.scheduleCatalog = () => { clearTimeout(catTimer); catTimer = setTimeout(sendCatalog, 20); };
    function sendCatalog(force) {
      if (!node.isOnline()) return;
      const c = JSON.stringify(node.localCatalog());
      if (c === lastCatalog && force !== true) return;
      lastCatalog = c;
      try { node.session.send(c); } catch (e) { /* link dropping */ }
    }

    // ---- session handling ----
    function adopt(session) {
      if (node.session && !node.session.closed) node.session.close('replaced by new connection');
      node.session = session; attempt = 0; lastCatalog = '';
      node.remoteCatalog = { ins: [], outs: [] };
      session.on('message', m => onFrame(session, m));
      session.on('close', reason => {
        if (node.session !== session) return;
        node.session = null;
        node.remoteCatalog = { ins: [], outs: [] };
        failPending(new Error('bridge link lost: ' + reason));
        if (closed) return;
        node.setState(node.role === 'listen' ? 'waiting' : 'offline', reason);
        if (node.role === 'connect' && node.peer()) scheduleRetry();
      });
      node.setState('online');
      sendCatalog(true);
    }
    node.accept = session => adopt(session); // listen side

    function failPending(err) {
      for (const [, p] of pendingAcks) { clearTimeout(p.timer); p.reject(err); }
      pendingAcks.clear();
      for (const [, p] of pendingCalls) { clearTimeout(p.timer); p.reject(err); }
      pendingCalls.clear();
    }

    function onFrame(session, m) {
      switch (m.t) {
        case 'catalog':
          node.remoteCatalog = { ins: Array.isArray(m.ins) ? m.ins.filter(x => typeof x === 'string') : [], outs: Array.isArray(m.outs) ? m.outs.filter(x => typeof x === 'string') : [] };
          node.bus.emit('catalog');
          break;
        case 'msg': handleMsg(session, m); break;
        case 'ack': {
          const p = pendingAcks.get(m.id);
          if (!p) break;
          pendingAcks.delete(m.id); clearTimeout(p.timer);
          if (m.ok) p.resolve(); else { p.reject(new Error(m.reason || 'rejected by remote')); const c = pendingCalls.get(p.callId); if (c) { pendingCalls.delete(p.callId); clearTimeout(c.timer); c.reject(new Error(m.reason || 'rejected by remote')); } }
          break;
        }
        case 'reply': {
          const c = pendingCalls.get(m.callId);
          if (!c) break;
          pendingCalls.delete(m.callId); clearTimeout(c.timer);
          try { c.resolve(decodeMsg(m.msg)); } catch (e) { c.reject(e); }
          break;
        }
        case 'unpair':
          node.log('remote requested unpair');
          getStore().deletePeer(node.id);
          session.close('unpaired by remote');
          if (node.role === 'connect') node.setState('unpaired', 'unpaired by remote');
          break;
        default: break;
      }
    }

    function handleMsg(session, m) {
      const ack = (ok, reason) => { try { session.send({ t: 'ack', id: m.id, ok, reason }); } catch (e) { /* ignore */ } };
      const targets = [...reg.ins].filter(n => n.bridgeName === m.to && node.exposes(n));
      if (!targets.length) return ack(false, `no bridge-in named "${m.to}" is visible to this remote`);
      let msg;
      try { msg = decodeMsg(m.msg); if (!msg || typeof msg !== 'object') throw new Error('msg is not an object'); } catch (e) { return ack(false, 'bad message: ' + e.message); }
      ack(true);
      targets.forEach((t, i) => {
        const copy = i === 0 ? msg : RED.util.cloneMessage(msg);
        copy._bridge = { remote: node.label(), remoteId: node.id, from: typeof m.from === 'string' ? m.from : '' };
        if (m.callId) copy._bridge.callId = String(m.callId);
        t.deliver(copy);
      });
    }

    // ---- sending API used by out/call/reply nodes ----
    function sendFrame(header, msg) {
      if (!node.isOnline()) throw new Error('bridge link to "' + node.label() + '" is ' + node.state);
      const { text, warnings } = encodeMsg(msg);
      warnings.forEach(w => node.warn(w));
      node.session.send(JSON.stringify(header).slice(0, -1) + ',"msg":' + text + '}');
    }
    node.sendTo = function (from, to, msg, callId) {
      const id = crypto.randomBytes(8).toString('hex');
      const header = { t: 'msg', id, to, from };
      if (callId) header.callId = callId;
      return new Promise((resolve, reject) => {
        try { sendFrame(header, msg); } catch (e) { return reject(e); }
        const timer = setTimeout(() => { pendingAcks.delete(id); reject(new Error('no acknowledgement from remote')); }, ACK_TIMEOUT);
        pendingAcks.set(id, { resolve, reject, timer, callId });
      });
    };
    node.call = function (from, to, msg, timeoutMs) {
      const callId = crypto.randomBytes(8).toString('hex');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pendingCalls.delete(callId); reject(new Error('bridge call timed out')); }, timeoutMs);
        pendingCalls.set(callId, { resolve, reject, timer });
        node.sendTo(from, to, msg, callId).catch(e => { if (pendingCalls.delete(callId)) { clearTimeout(timer); reject(e); } });
      });
    };
    node.reply = function (callId, msg) {
      sendFrame({ t: 'reply', callId }, msg);
    };

    // ---- connect side ----
    function scheduleRetry(authFailed) {
      if (closed || node.role !== 'connect') return;
      clearTimeout(retryTimer);
      const exp = Math.min(node.backoffMax, node.backoffMin * Math.pow(2, attempt++));
      const delay = authFailed ? node.backoffMax : Math.round(exp * (0.8 + Math.random() * 0.4));
      retryTimer = setTimeout(connectNow, delay);
    }
    function connectNow() {
      if (closed || dialing || node.role !== 'connect') return;
      const peer = node.peer();
      if (!peer) return node.setState('unpaired', 'not paired: paste a pairing code from the remote');
      const url = node.url || peer.url; // URL from the pairing code is remembered in the key store
      if (!url) return node.setState('offline', 'no remote URL configured');
      dial({ mode: 'auth', url, expected: peer.pub }).catch(() => {});
    }
    function dial(o) {
      dialing = true;
      if (!node.isOnline()) node.setState('connecting', '');
      return new Promise((resolve, reject) => {
        let ws;
        try { ws = new WebSocket(o.url, { maxPayload: node.maxSize + 1024, handshakeTimeout: 10000 }); } catch (e) { return reject(e); }
        activeWs = ws;
        ws.once('error', reject); // before open
        ws.once('open', () => {
          ws.removeListener('error', reject);
          clientHandshake(ws, { identity: getStore().identity(), expectedServerPub: o.expected, mode: o.mode, token: o.token,
            session: { maxSize: node.maxSize, pingInterval: node.pingInterval, pingTimeout: node.pingTimeout } })
            .then(resolve, e => { try { ws.terminate(); } catch (x) { /* ignore */ } reject(e); });
        });
      }).then(session => {
        dialing = false; activeWs = null;
        if (closed) return session.close('node closed');
        if (o.mode === 'pair') { node.url = o.url; getStore().setPeer(node.id, { pub: o.expected, url: o.url }); }
        adopt(session);
        return session;
      }, err => {
        dialing = false; activeWs = null;
        if (closed) return;
        const authFail = err.code === 'auth' || err.code === 'server-key' || err.code === 'token';
        if (!node.isOnline()) node.setState(authFail ? 'auth-failed' : 'offline', err.message);
        if (o.mode === 'auth') scheduleRetry(authFail);
        throw err;
      });
    }
    node.pair = function (code) {
      if (node.role !== 'connect') throw new Error('this remote is configured as "listen": create a pairing code instead');
      const c = parseCode(code);
      clearTimeout(retryTimer);
      return dial({ mode: 'pair', url: c.url, expected: c.pub, token: c.token }).then(() => node.info(), e => { if (getStore().getPeer(node.id) && !node.isOnline()) scheduleRetry(); throw e; });
    };
    node.createPairingCode = function (urlOverride) {
      if (node.role !== 'listen') throw new Error('pairing codes are created on the "listen" side');
      const url = (urlOverride || node.publicUrl || '').trim();
      if (!/^wss?:\/\//.test(url)) throw new Error('set the public URL (ws:// or wss://) this instance is reachable on');
      const token = C.newToken();
      const r = makeCode({ url, pub: getStore().identity().pub, token });
      node.pairing = { token, exp: r.exp };
      return r;
    };
    node.unpair = function () {
      const s = node.session;
      if (s && !s.closed) { try { s.send({ t: 'unpair' }); } catch (e) { /* ignore */ } }
      getStore().deletePeer(node.id);
      node.pairing = null;
      clearTimeout(retryTimer);
      if (s) s.close('unpaired');
      if (activeWs) { try { activeWs.terminate(); } catch (e) { /* ignore */ } }
      node.setState(node.role === 'listen' ? 'waiting' : 'unpaired', node.role === 'listen' ? '' : 'unpaired');
    };

    // ---- start ----
    if (node.role === 'listen') {
      try { getListener(RED, getStore).register(node.path, node); node.listening = true; } catch (e) { node.setState('offline', e.message); node.error(e.message); }
    } else {
      setImmediate(connectNow);
    }
    reg.changed();

    node.on('close', function (removed, done) {
      closed = true;
      clearTimeout(retryTimer); clearTimeout(catTimer);
      reg.configs.delete(node.id);
      if (node.listening) getListener(RED, getStore).unregister(node.path, node);
      failPending(new Error('bridge config closed'));
      if (activeWs) { try { activeWs.terminate(); } catch (e) { /* ignore */ } }
      if (node.session) node.session.close('node closed');
      node.bus.emit('state', { state: 'closed', reason: 'closed', since: Date.now(), previous: node.state });
      node.bus.removeAllListeners();
      done();
    });
  }
  RED.nodes.registerType('bridge-remote', BridgeRemote);

  // ---- admin endpoints ----
  const perm = p => RED.auth.needsPermission(p);
  const withNode = (req, res, fn) => {
    const n = reg.configs.get(req.params.id);
    if (!n) return res.status(404).json({ error: 'remote not deployed yet: deploy first' });
    try { Promise.resolve(fn(n)).catch(e => res.status(400).json({ error: e.message })); } catch (e) { res.status(400).json({ error: e.message }); }
  };
  RED.httpAdmin.get('/bridge/:id/state', perm('bridge-remote.read'), (req, res) => withNode(req, res, n => res.json(n.info())));
  RED.httpAdmin.post('/bridge/:id/code', perm('bridge-remote.write'), (req, res) => withNode(req, res, n => {
    const r = n.createPairingCode(req.body && req.body.url); res.json({ code: r.code, expires: r.exp });
  }));
  RED.httpAdmin.post('/bridge/:id/pair', perm('bridge-remote.write'), (req, res) => withNode(req, res, async n => {
    const info = await n.pair(req.body && req.body.code); res.json(Object.assign({ url: n.url }, info));
  }));
  RED.httpAdmin.post('/bridge/:id/unpair', perm('bridge-remote.write'), (req, res) => withNode(req, res, n => { n.unpair(); res.json(n.info()); }));
};
