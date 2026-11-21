'use strict';
// Whole-msg JSON transport. Buffers/typed arrays are tagged base64; req/res and non-serialisable values dropped.
function encodeMsg(msg) {
  const warnings = [];
  let text;
  try {
    text = JSON.stringify(msg, function (key, value) {
      const orig = this[key];
      if (this === msg && (key === 'req' || key === 'res')) return undefined;
      if (Buffer.isBuffer(orig)) return { __bridge: 'buffer', data: orig.toString('base64') };
      if (ArrayBuffer.isView(orig)) return { __bridge: 'buffer', data: Buffer.from(orig.buffer, orig.byteOffset, orig.byteLength).toString('base64') };
      if (typeof orig === 'function' || typeof orig === 'symbol') { warnings.push(`dropped non-serialisable property "${key}"`); return undefined; }
      if (typeof orig === 'bigint') return orig.toString();
      return value;
    });
  } catch (e) {
    const err = new Error('message is not serialisable: ' + e.message); err.code = 'serialize'; throw err;
  }
  return { text, warnings };
}
function revive(v) {
  if (Array.isArray(v)) return v.map(revive);
  if (v && typeof v === 'object') {
    if (v.__bridge === 'buffer' && typeof v.data === 'string') return Buffer.from(v.data, 'base64');
    for (const k of Object.keys(v)) v[k] = revive(v[k]);
  }
  return v;
}
const decodeMsg = obj => revive(obj);
module.exports = { encodeMsg, decodeMsg };
