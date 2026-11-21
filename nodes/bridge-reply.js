'use strict';
const { getRegistry } = require('../lib/registry');

module.exports = function (RED) {
  const reg = getRegistry(RED);
  function BridgeReply(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.on('input', (msg, send, done) => {
      const b = msg._bridge;
      if (!b || !b.callId) return done(new Error('msg._bridge.callId missing: the msg must originate from a bridge-in that received a bridge-call'));
      const remote = reg.configs.get(b.remoteId);
      if (!remote) return done(new Error('bridge remote for this call no longer exists'));
      try { const out = Object.assign({}, msg); delete out._bridge; remote.reply(b.callId, out); done(); } catch (e) { done(e); }
    });
  }
  RED.nodes.registerType('bridge-reply', BridgeReply);
};
