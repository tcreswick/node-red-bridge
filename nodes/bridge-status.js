'use strict';
const { getRegistry } = require('../lib/registry');

module.exports = function (RED) {
  const reg = getRegistry(RED);
  function BridgeStatus(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const only = config.remote && config.remote !== '_all' ? config.remote : null;
    const emitOnDeploy = !!config.emitOnDeploy;
    const attached = new Map();
    const emit = (remote, s) => {
      const online = s.state === 'online';
      node.send({ payload: online ? 'online' : 'offline', remote: remote.label(), remoteId: remote.id, state: s.state, reason: s.reason || (online ? '' : s.state), since: s.since });
    };
    const show = () => {
      const rs = [...attached.keys()];
      const on = rs.filter(r => r.isOnline()).length;
      node.status(!rs.length ? { fill: 'grey', shape: 'ring', text: 'no remotes' } : on === rs.length ? { fill: 'green', shape: 'dot', text: 'online' } : { fill: on ? 'yellow' : 'red', shape: 'ring', text: `${on}/${rs.length} online` });
    };
    setImmediate(() => {
      for (const r of reg.configs.values()) {
        if (only && r.id !== only) continue;
        const h = s => {
          if (s.state === 'closed') return;
          if (s.state === 'online' || s.previous === 'online' || s.state === 'auth-failed') emit(r, s);
          show();
        };
        r.bus.on('state', h); attached.set(r, h);
        if (emitOnDeploy) emit(r, { state: r.state, reason: r.reason, since: r.since });
      }
      show();
    });
    node.on('close', done => { attached.forEach((h, r) => r.bus.removeListener('state', h)); done(); });
  }
  RED.nodes.registerType('bridge-status', BridgeStatus);
};
