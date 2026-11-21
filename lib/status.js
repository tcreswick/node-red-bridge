'use strict';
const MAP = {
  online: { fill: 'green', shape: 'dot', text: 'connected' },
  connecting: { fill: 'yellow', shape: 'ring', text: 'connecting' },
  waiting: { fill: 'yellow', shape: 'ring', text: 'waiting for remote' },
  offline: { fill: 'red', shape: 'ring', text: 'offline' },
  'auth-failed': { fill: 'red', shape: 'dot', text: 'auth failed' },
  unpaired: { fill: 'red', shape: 'ring', text: 'not paired' },
  closed: { fill: 'grey', shape: 'ring', text: 'closed' }
};
const nodeStatus = state => MAP[state] || MAP.offline;
const isOnline = s => s === 'online';
module.exports = { nodeStatus, isOnline };
