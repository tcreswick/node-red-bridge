'use strict';
// Crypto primitives: Ed25519 identity, X25519 ephemeral ECDH, HKDF, AES-256-GCM frames.
const crypto = require('crypto');

const b64u = b => Buffer.from(b).toString('base64url');
const unb64u = s => Buffer.from(String(s), 'base64url');
const sha256 = d => crypto.createHash('sha256').update(d).digest();

function newIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    pub: b64u(publicKey.export({ type: 'spki', format: 'der' })),
    priv: b64u(privateKey.export({ type: 'pkcs8', format: 'der' }))
  };
}
const pubObj = pub => crypto.createPublicKey({ key: unb64u(pub), format: 'der', type: 'spki' });
const privObj = priv => crypto.createPrivateKey({ key: unb64u(priv), format: 'der', type: 'pkcs8' });

function sign(identity, data) { return b64u(crypto.sign(null, Buffer.from(data), privObj(identity.priv))); }
function verify(pub, data, sig) {
  try { return crypto.verify(null, Buffer.from(data), pubObj(pub), unb64u(sig)); } catch (e) { return false; }
}
function fingerprint(pub) {
  return sha256(unb64u(pub)).toString('hex').slice(0, 32).replace(/(.{4})(?=.)/g, '$1 ');
}

function ephemeral() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return { pub: b64u(publicKey.export({ type: 'spki', format: 'der' })), priv: privateKey };
}
function ecdh(priv, peerPub) {
  const publicKey = crypto.createPublicKey({ key: unb64u(peerPub), format: 'der', type: 'spki' });
  return crypto.diffieHellman({ privateKey: priv, publicKey });
}

const nonce = () => b64u(crypto.randomBytes(16));
const newToken = () => b64u(crypto.randomBytes(24));
function transcript(fields) { return b64u(sha256('bridge-v1|' + fields.join('|'))); }
function proof(token, tr) { return b64u(crypto.createHmac('sha256', token).update('pair|' + tr).digest()); }
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function deriveKeys(shared, tr) {
  const k = info => Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.from(tr), info, 32));
  return { c2s: k('bridge-v1 c2s'), s2c: k('bridge-v1 s2c') };
}

// Frame: [8 byte counter][ciphertext][16 byte tag]; IV = 4 zero bytes + counter. Keys are per direction.
function encryptFrame(key, counter, plain) {
  const ctr = Buffer.alloc(8); ctr.writeBigUInt64BE(BigInt(counter));
  const c = crypto.createCipheriv('aes-256-gcm', key, Buffer.concat([Buffer.alloc(4), ctr]));
  c.setAAD(ctr);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([ctr, ct, c.getAuthTag()]);
}
function decryptFrame(key, frame) {
  if (frame.length < 24) throw new Error('short frame');
  const ctr = frame.subarray(0, 8), tag = frame.subarray(frame.length - 16), ct = frame.subarray(8, frame.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.concat([Buffer.alloc(4), ctr]));
  d.setAAD(ctr); d.setAuthTag(tag);
  return { counter: Number(ctr.readBigUInt64BE()), plain: Buffer.concat([d.update(ct), d.final()]) };
}

module.exports = { b64u, unb64u, newIdentity, sign, verify, fingerprint, ephemeral, ecdh, nonce, newToken,
  transcript, proof, safeEqual, deriveKeys, encryptFrame, decryptFrame };
