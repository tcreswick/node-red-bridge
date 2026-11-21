'use strict';
const { getRegistry } = require('../lib/registry');
const { bindStatus } = require('../lib/common');

module.exports = function (RED) {
  const reg = getRegistry(RED);
  function BridgeCall(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.bridgeName = (config.bridgeName || config.name || '').trim();
    node.remotes = Array.isArray(config.remotes) ? config.remotes : [];
    node.target = (config.target || '').trim();
    node.timeout = Math.max(100, Number(config.timeout) * 1000 || 10000);
    const remote = RED.nodes.getNode(config.remote);
    reg.outs.add(node); reg.changed();
    const unbind = bindStatus(node, remote);
    node.on('input', async (msg, send, done) => {
      try {
        if (!remote) throw new Error('no bridge remote configured');
        const target = String(msg.bridgeTarget || node.target || '').trim();
        if (!target) throw new Error('no target: set a bridge-in name or msg.bridgeTarget');
        if (!remote.exposes(node)) throw new Error(`this node is not ticked for remote "${remote.label()}"`);
        const res = await remote.call(node.bridgeName || node.id, target, msg, node.timeout);
        delete res._bridge;
        if (msg.req) res.req = msg.req; // local-only properties are not sent: restore them for http response etc.
        if (msg.res) res.res = msg.res;
        send(res); done();
      } catch (e) { done(e); }
    });
    node.on('close', done => { unbind(); reg.outs.delete(node); reg.changed(); done(); });
  }
  RED.nodes.registerType('bridge-call', BridgeCall);
};
