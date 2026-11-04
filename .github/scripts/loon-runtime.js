// Generic Loon completion adapter. Native request/response objects stay intact.
function createLoonDone(nativeDone, mode) {
  'use strict';
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const statusCode = value => {
    if (typeof value === 'number') {
      return Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
    }
    if (typeof value !== 'string') return null;
    const match = /^(?:HTTP\/\d+(?:\.\d+)?[ \t]+)?([1-5]\d\d)(?:[ \t]+[^\r\n]*)?$/i.exec(value.trim());
    return match ? Number(match[1]) : null;
  };
  const normalize = value => {
    if (!isObject(value)) throw new TypeError('Invalid completion object');
    const result = Object.assign({}, value);
    // A source can return a native response object directly. Documented fields
    // remain readable even when the host does not enumerate them as own keys.
    for (const key of ['url', 'headers', 'body', 'status', 'response', 'abort', 'policy']) {
      if (own(result, key)) continue;
      const item = value[key];
      if (typeof item !== 'undefined' || key in value) result[key] = item;
    }
    if (own(result, 'status')) {
      const code = statusCode(result.status);
      if (code === null) throw new TypeError('Invalid response status');
      result.status = code;
    }
    return result;
  };
  const request = /^(?:http-)?request(?:-body)?$/.test(String(mode || ''));
  let completed = false;
  return function done(value) {
    if (completed) return;
    completed = true;
    let result;
    try {
      result = isObject(value) ? normalize(value) : {};
      if (own(result, 'response')) {
        result.response = normalize(result.response);
      } else if (request && own(result, 'status')) {
        result = {response: result};
      }
    } catch (_) { result = {}; }
    nativeDone(result);
  };
}
