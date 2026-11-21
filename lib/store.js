'use strict';
// Persists the instance identity and trusted peer keys (0600) in userDir/bridge-identity.json.
const fs = require('fs');
const path = require('path');
const C = require('./crypto');

class Store {
  constructor(dir) { this.file = path.join(dir || process.cwd(), 'bridge-identity.json'); this.data = null; }
  _load() {
    if (this.data) return this.data;
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) { this.data = {}; }
    if (!this.data.peers) this.data.peers = {};
    if (!this.data.identity) { this.data.identity = C.newIdentity(); this._save(); }
    return this.data;
  }
  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  identity() { return this._load().identity; }
  getPeer(id) { return this._load().peers[id] || null; }
  setPeer(id, peer) { this._load().peers[id] = Object.assign({ pairedAt: new Date().toISOString() }, peer); this._save(); }
  deletePeer(id) { const d = this._load(); if (d.peers[id]) { delete d.peers[id]; this._save(); return true; } return false; }
}
module.exports = Store;
