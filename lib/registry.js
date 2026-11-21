'use strict';
// Per-runtime registry of bridge nodes and config nodes + exposure (ACL) logic.
// Node-RED hands every node module its own RED object, so shared state must live at module level
// (one runtime per process).
let r = null;

function getRegistry() {
  if (!r) {
    r = { ins: new Set(), outs: new Set(), configs: new Map(), timer: null };
    r.changed = () => { // debounce: deploys register/unregister many nodes at once
      clearTimeout(r.timer);
      r.timer = setTimeout(() => { for (const c of r.configs.values()) c.scheduleCatalog(); }, 150);
      if (r.timer.unref) r.timer.unref();
    };
  }
  return r;
}

// A node is visible to / usable by a remote if shareAll is set or the remote id is ticked on the node.
function exposes(shareAll, remoteId, node) {
  return !!shareAll || (Array.isArray(node.remotes) && node.remotes.includes(remoteId));
}
function exposedNames(nodes, shareAll, remoteId) {
  const names = new Set();
  for (const n of nodes) if (n.bridgeName && exposes(shareAll, remoteId, n)) names.add(n.bridgeName);
  return [...names].sort();
}
module.exports = { getRegistry, exposes, exposedNames };
