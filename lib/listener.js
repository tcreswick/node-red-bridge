'use strict';
// Shared WebSocket endpoint(s) on Node-RED's own HTTP server for `listen` config nodes.
const { WebSocketServer } = require('ws');
const { serverHandshake } = require('./handshake');

let l = null;

function getListener(RED, getStore) {
  if (l) return l;
  const paths = new Map(); // pathname -> {wss, nodes:Set}
  const server = RED.server;
  const onUpgrade = (req, socket, head) => {
    let p; try { p = new URL(req.url, 'http://x').pathname; } catch (e) { return; }
    const e = paths.get(p);
    if (!e) return;
    e.wss.handleUpgrade(req, socket, head, ws => onConnection(e, ws));
  };
  function onConnection(e, ws) {
    ws.on('error', () => {});
    const nodes = [...e.nodes];
    const maxSize = Math.max(...nodes.map(n => n.maxSize));
    serverHandshake(ws, {
      identity: getStore().identity(),
      session: { maxSize, pingInterval: Math.min(...nodes.map(n => n.pingInterval)), pingTimeout: Math.max(...nodes.map(n => n.pingTimeout)) },
      lookupPeer: pub => nodes.find(n => n.trusts(pub)) || null,
      consumeToken: (check, pub) => nodes.find(n => n.consumeToken(check, pub)) || null
    }).then(({ session, ctx, mode }) => {
      session.maxSize = ctx.maxSize; session.pingInterval = ctx.pingInterval;
      ctx.accept(session, mode);
    }).catch(err => RED.log.warn(`[bridge] incoming connection rejected: ${err.message}`));
  }
  l = {
    register(path, node) {
      if (!server) throw new Error('Node-RED HTTP server not available (is httpNodeRoot/httpAdminRoot disabled?)');
      let e = paths.get(path);
      if (!e) {
        e = { wss: new WebSocketServer({ noServer: true, maxPayload: node.maxSize + 1024 }), nodes: new Set() };
        paths.set(path, e);
        if (paths.size === 1) server.on('upgrade', onUpgrade);
      }
      e.nodes.add(node);
    },
    unregister(path, node) {
      const e = paths.get(path);
      if (!e) return;
      e.nodes.delete(node);
      if (!e.nodes.size) { e.wss.close(); paths.delete(path); }
      if (!paths.size && server) server.removeListener('upgrade', onUpgrade);
    }
  };
  return l;
}
module.exports = { getListener };
