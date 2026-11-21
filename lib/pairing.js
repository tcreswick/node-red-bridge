'use strict';
const C = require('./crypto');
function makeCode({ url, pub, token, ttlMs }) {
  const exp = Date.now() + (ttlMs || 10 * 60 * 1000);
  return { code: C.b64u(JSON.stringify({ v: 1, url, pub, fp: C.fingerprint(pub), token, exp })), exp };
}
function parseCode(str) {
  let o;
  try { o = JSON.parse(C.unb64u(String(str).trim()).toString('utf8')); } catch (e) { throw new Error('not a valid pairing code'); }
  if (!o || o.v !== 1 || typeof o.url !== 'string' || typeof o.pub !== 'string' || typeof o.token !== 'string') throw new Error('not a valid pairing code');
  if (!/^wss?:\/\//.test(o.url)) throw new Error('pairing code URL must be ws:// or wss://');
  if (typeof o.exp !== 'number' || o.exp < Date.now()) throw new Error('pairing code has expired');
  return o;
}
module.exports = { makeCode, parseCode };
