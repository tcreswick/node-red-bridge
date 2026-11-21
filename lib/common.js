'use strict';
const { nodeStatus } = require('./status');

// Binds a node's status to a remote config node's state bus; returns unbind function.
function bindStatus(node, remote, extra) {
  if (!remote) { node.status({ fill: 'red', shape: 'ring', text: 'no remote configured' }); return () => {}; }
  const apply = () => node.status(nodeStatus(remote.state));
  const h = s => { apply(); if (extra) extra(s); };
  remote.bus.on('state', h); apply();
  return () => remote.bus.removeListener('state', h);
}
module.exports = { bindStatus };
