'use strict';
const { getRegistry } = require('../lib/registry');
const { bindStatus } = require('../lib/common');

module.exports = function (RED) {
  const reg = getRegistry(RED);
  function BridgeOut(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.bridgeName = (config.bridgeName || config.name || '').trim();
    node.remotes = Array.isArray(config.remotes) ? config.remotes : [];
    node.target = (config.target || '').trim();
    node.offline = ['error', 'drop', 'queue'].includes(config.offline) ? config.offline : 'error';
    node.queueMax = Math.max(1, parseInt(config.queueMax, 10) || 100);
    node.queueTime = Math.max(1, parseInt(config.queueTime, 10) || 60) * 1000;
    const remote = RED.nodes.getNode(config.remote);
    let queue = [];
    reg.outs.add(node); reg.changed();

    async function transmit(msg, send, done) {
      const target = String(msg.bridgeTarget || node.target || '').trim();
      try {
        if (!target) throw new Error('no target: set a bridge-in name or msg.bridgeTarget');
        if (!remote.exposes(node)) throw new Error(`this node is not ticked for remote "${remote.label()}" (allowed to see this node)`);
        await remote.sendTo(node.bridgeName || node.id, target, msg);
        done();
      } catch (e) { done(e); }
    }
    function flush() {
      const now = Date.now(), q = queue; queue = [];
      q.forEach(it => { if (now - it.ts > node.queueTime) it.done(new Error('queued message expired while remote offline')); else transmit(it.msg, null, it.done); });
    }
    const unbind = bindStatus(node, remote, s => { if (s.state === 'online') flush(); });
    node.on('input', (msg, send, done) => {
      if (!remote) return done(new Error('no bridge remote configured'));
      if (remote.isOnline()) return transmit(msg, send, done);
      const why = `bridge link to "${remote.label()}" is ${remote.state}`;
      if (node.offline === 'drop') { node.warn(why + ': message dropped'); return done(); }
      if (node.offline === 'queue') {
        queue = queue.filter(it => { if (Date.now() - it.ts > node.queueTime) { it.done(new Error('queued message expired')); return false; } return true; });
        if (queue.length >= node.queueMax) { const old = queue.shift(); old.done(new Error('queue full: oldest message discarded')); }
        queue.push({ msg, done, ts: Date.now() });
        return;
      }
      done(new Error(why));
    });
    node.on('close', done => {
      unbind(); reg.outs.delete(node); reg.changed();
      queue.forEach(it => it.done()); queue = []; done();
    });
  }
  RED.nodes.registerType('bridge-out', BridgeOut);
};
