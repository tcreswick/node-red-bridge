'use strict';
// Encrypted, counter-protected session over a ws-like object (send/on/close) with app-level keepalive.
const EventEmitter = require('events');
const C = require('./crypto');

class Session extends EventEmitter {
  constructor(ws, o) {
    super();
    this.ws = ws; this.sendKey = o.sendKey; this.recvKey = o.recvKey;
    this.pingInterval = o.pingInterval == null ? 15000 : o.pingInterval;
    this.pingTimeout = o.pingTimeout == null ? 45000 : o.pingTimeout;
    this.maxSize = o.maxSize || 10 * 1024 * 1024;
    this.sendCounter = 0; this.recvCounter = 0; this.closed = false;
    this.lastSeen = Date.now();
    this.peerPub = o.peerPub; this.since = Date.now();
  }
  decode(frame) { // decrypt one frame (enforces strictly increasing counter = replay protection)
    const { counter, plain } = C.decryptFrame(this.recvKey, frame);
    if (counter <= this.recvCounter) throw new Error('replayed or out-of-order frame');
    this.recvCounter = counter;
    return plain;
  }
  start(pre) {
    this._onMsg = (data, isBinary) => this._frame(data, isBinary);
    this._onClose = () => this.close('connection closed');
    this._onErr = e => this.close('socket error: ' + (e && e.message));
    this.ws.on('message', this._onMsg); this.ws.on('close', this._onClose); this.ws.on('error', this._onErr);
    if (this.pingInterval > 0) {
      this._timer = setInterval(() => {
        if (Date.now() - this.lastSeen > this.pingTimeout) return this.close('keepalive timeout');
        try { this.send({ t: 'ping' }); } catch (e) { /* closed */ }
      }, this.pingInterval);
      if (this._timer.unref) this._timer.unref();
    }
    (pre || []).forEach(p => this._frame(p.data, p.isBinary));
  }
  _frame(data, isBinary) {
    if (this.closed) return;
    let obj;
    try {
      if (isBinary === false || typeof data === 'string') throw new Error('unexpected text frame');
      const plain = this.decode(Buffer.isBuffer(data) ? data : Buffer.from(data));
      if (plain.length > this.maxSize) throw new Error('message too large');
      obj = JSON.parse(plain.toString('utf8'));
    } catch (e) { return this.close('protocol error: ' + e.message); }
    this.lastSeen = Date.now();
    if (obj.t === 'ping') { try { this.send({ t: 'pong' }); } catch (e) { /* closed */ } return; }
    if (obj.t === 'pong') return;
    this.emit('message', obj);
  }
  // obj: object or pre-serialised JSON string
  send(obj) {
    if (this.closed) throw new Error('link is closed');
    const plain = Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj));
    if (plain.length > this.maxSize) throw new Error(`message too large (${plain.length} > ${this.maxSize} bytes)`);
    this.ws.send(C.encryptFrame(this.sendKey, ++this.sendCounter, plain), { binary: true });
  }
  close(reason) {
    if (this.closed) return;
    this.closed = true; clearInterval(this._timer);
    if (this._onMsg) {
      this.ws.removeListener('message', this._onMsg); this.ws.removeListener('close', this._onClose);
    }
    try { this.ws.close(); } catch (e) { /* ignore */ }
    this.emit('close', reason || 'closed');
  }
}
module.exports = Session;
