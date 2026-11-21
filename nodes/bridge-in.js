'use strict';
const { getRegistry } = require('../lib/registry');

module.exports = function (RED) {
  const reg = getRegistry(RED);
  function BridgeIn(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.bridgeName = (config.bridgeName || config.name || '').trim();
    node.remotes = Array.isArray(config.remotes) ? config.remotes : [];
    if (!node.bridgeName) node.warn('bridge-in has no name: it can not be addressed by a remote');
    node.deliver = msg => { node.send(msg); };
    reg.ins.add(node); reg.changed();
    // status: show how many ticked remotes are online
    const remotes = () => node.remotes.map(id => reg.configs.get(id)).filter(Boolean);
    const upd = () => {
      const r = remotes();
      if (!r.length) return node.status({ fill: 'grey', shape: 'ring', text: 'not visible to any remote' });
      const on = r.filter(x => x.isOnline()).length;
      node.status(on ? { fill: 'green', shape: 'dot', text: `${on}/${r.length} remote(s) online` } : { fill: 'red', shape: 'ring', text: 'remote offline' });
    };
    const unbinds = [];
    setImmediate(() => { remotes().forEach(r => { r.bus.on('state', upd); unbinds.push(() => r.bus.removeListener('state', upd)); }); upd(); });
    node.on('close', done => { unbinds.forEach(u => u()); reg.ins.delete(node); reg.changed(); done(); });
  }
  RED.nodes.registerType('bridge-in', BridgeIn);
};
