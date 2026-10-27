// Generic QX API facade. The original script is appended unchanged by the compiler.
// Request context is local-only, bounded, and matched by the platform's real ID.
function createQxRuntime(native, mode, namespace) {
  'use strict';
  const own = (value, key) => value != null && Object.prototype.hasOwnProperty.call(value, key);
  const clone = value => value && typeof value === 'object' ? Object.assign({}, value) : value;
  const copyBytes = value => {
    if (value == null || typeof value !== 'object') return null;
    try {
      let view;
      if (ArrayBuffer.isView(value)) view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      else if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') view = new Uint8Array(value);
      else return null;
      return new Uint8Array(view);
    } catch (_) { return null; }
  };
  function utf8Text(value) {
    // Follow UTF-8 replacement decoding without depending on browser TextDecoder.
    // The separate byte view always retains the original, potentially non-text data.
    let code = 0, needed = 0, seen = 0, lower = 128, upper = 191, chunk = '';
    const parts = [];
    const append = point => {
      chunk += String.fromCodePoint(point);
      if (chunk.length >= 8192) { parts.push(chunk); chunk = ''; }
    };
    for (let index = 0; index < value.length; index++) {
      const byte = value[index];
      if (needed === 0) {
        if (byte < 128) append(byte);
        else if (byte >= 194 && byte <= 223) { needed = 1; code = byte & 31; }
        else if (byte >= 224 && byte <= 239) {
          needed = 2; code = byte & 15;
          if (byte === 224) lower = 160;
          if (byte === 237) upper = 159;
        } else if (byte >= 240 && byte <= 244) {
          needed = 3; code = byte & 7;
          if (byte === 240) lower = 144;
          if (byte === 244) upper = 143;
        } else append(65533);
        continue;
      }
      if (byte < lower || byte > upper) {
        code = needed = seen = 0; lower = 128; upper = 191;
        append(65533); index--;
        continue;
      }
      lower = 128; upper = 191;
      code = (code << 6) | (byte & 63);
      if (++seen === needed) { append(code); code = needed = seen = 0; }
    }
    if (needed) append(65533);
    parts.push(chunk);
    const text = parts.join('');
    return text.charCodeAt(0) === 65279 ? text.slice(1) : text;
  }
  const exposeBody = value => {
    if (!value || typeof value !== 'object') return value;
    const data = copyBytes(value.bodyBytes) || copyBytes(value.body);
    if (data) {
      value.bodyBytes = data.buffer;
      if (typeof value.body !== 'string') value.body = utf8Text(data);
    }
    return value;
  };
  const nativeBody = value => {
    if (!own(value, 'body') && own(value, 'bodyBytes')) {
      const data = copyBytes(value.bodyBytes);
      if (!data) throw new TypeError('Invalid binary body');
      value.body = data;
    } else if (own(value, 'body')) {
      const data = copyBytes(value.body);
      if (data) value.body = data;
    }
    delete value.bodyBytes;
    return value;
  };
  const stage = String(mode || '').replace(/-body$/, '');
  const request = exposeBody(clone(native.request));
  const response = exposeBody(clone(native.response));
  if (request && request.headers) request.headers = clone(request.headers);
  if (response && response.headers) response.headers = clone(response.headers);
  const store = native.persistentStore;
  const contextPrefix = 'HotKidsQxRequestContextV1_';
  const slots = 16;
  const ttl = 180000;
  const maxBody = 1048576;
  const maxHeaders = 65536;
  const maxRecord = maxBody + maxHeaders + 32768;
  const read = key => {
    try { return store && typeof store.read === 'function' ? store.read(key) : null; }
    catch (_) { return null; }
  };
  const write = (value, key) => {
    try { return !!(store && typeof store.write === 'function' && store.write(value, key)); }
    catch (_) { return false; }
  };
  const remove = key => {
    const first = write('', key);
    if (read(key) == null || read(key) === '') return first;
    const second = write(null, key);
    return (read(key) == null || read(key) === '') && second;
  };
  const bytes = text => {
    let size = 0;
    for (const char of text) {
      const value = char.codePointAt(0);
      size += value < 128 ? 1 : value < 2048 ? 2 : value < 65536 ? 3 : 4;
    }
    return size;
  };
  const numericSession = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    || typeof value === 'string' && /^\d{1,24}$/.test(value);
  let stableId = null;
  if (request && numericSession(request.sessionIndex)) {
    stableId = 'session:' + String(request.sessionIndex);
  } else if (native.platform === 'surge' && request && typeof request.id === 'string'
             && request.id.length > 0 && request.id.length <= 512) {
    stableId = 'id:' + request.id;
    if (!own(request, 'sessionIndex')) request.sessionIndex = request.id;
  }
  if (response) {
    if (!own(response, 'statusCode') && own(response, 'status')) response.statusCode = response.status;
    if (!own(response, 'sessionIndex') && request && own(request, 'sessionIndex')) {
      response.sessionIndex = request.sessionIndex;
    }
  }
  const scope = typeof namespace === 'string' && namespace.length > 0 && namespace.length <= 256 ? namespace : null;
  let contextKey = null;
  const consistentIds = !response || !own(response, 'sessionIndex') || !request
    || !own(request, 'sessionIndex') || String(response.sessionIndex) === String(request.sessionIndex);
  if (scope && stableId && consistentIds && request && typeof request.url === 'string' && request.url.length <= 8192) {
    // This chooses a storage slot, never a synthetic public sessionIndex.
    let slot = 0;
    for (const char of scope + '\0' + stableId) slot = (slot * 31 + char.codePointAt(0)) % slots;
    contextKey = contextPrefix + slot;
  }
  function restoreContext() {
    if (!contextKey) return;
    const raw = read(contextKey);
    if (typeof raw !== 'string' || raw.length > maxRecord) return;
    let record;
    try { record = JSON.parse(raw); } catch (_) { return; }
    if (!record || record.version !== 1 || record.namespace !== scope || record.id !== stableId) return;
    remove(contextKey);
    const age = Date.now() - record.time;
    if (!Number.isFinite(record.time) || !Number.isFinite(age) || age < 0 || age >= ttl || record.url !== request.url
        || typeof record.method !== 'string' || !record.method
        || own(request, 'method') && String(request.method).toUpperCase() !== record.method
        || typeof record.body !== 'string' || bytes(record.body) > maxBody
        || !record.headers || typeof record.headers !== 'object' || Array.isArray(record.headers)
        || bytes(JSON.stringify(record.headers)) > maxHeaders) return;
    if (typeof request.body === 'undefined') request.body = record.body;
    if (typeof request.headers === 'undefined') request.headers = record.headers;
    if (typeof request.method === 'undefined') request.method = record.method;
  }
  if (stage === 'response') restoreContext();
  function rememberContext(result) {
    if (!contextKey || !native.request || result.response || result.abort) return;
    const original = native.request;
    const body = own(result, 'body') ? result.body : original.body;
    const headers = own(result, 'headers') ? result.headers : original.headers;
    const url = own(result, 'url') ? result.url : original.url;
    const method = String(original.method || '').toUpperCase();
    if (typeof body !== 'string' || bytes(body) > maxBody || typeof url !== 'string' || url.length > 8192
        || !method || !headers || typeof headers !== 'object' || Array.isArray(headers)) return;
    try {
      if (bytes(JSON.stringify(headers)) > maxHeaders) return;
      const value = JSON.stringify({version: 1, namespace: scope, id: stableId,
        time: Date.now(), url, method, body, headers});
      if (value.length <= maxRecord) write(value, contextKey);
    } catch (_) {}
  }
  const status = value => {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599) return value;
    if (typeof value === 'string') {
      const match = /^(?:HTTP\/\d(?:\.\d)?\s+)?([1-5]\d\d)(?:\s|$)/i.exec(value.trim());
      if (match) return Number(match[1]);
    }
    return null;
  };
  const normalize = value => {
    const result = nativeBody(value && typeof value === 'object' ? clone(value) : {});
    if (own(result, 'status')) {
      const number = status(result.status);
      if (number == null) return {};
      result.status = number;
    }
    return result;
  };
  let completed = false;
  function done(value) {
    if (completed) return;
    completed = true;
    let result;
    try {
      result = normalize(value);
      if (stage === 'echo' && Object.keys(result).length && !result.response
          || stage === 'request' && own(result, 'status') && !result.response) {
        if (!own(result, 'status')) result.status = 200;
        result = {response: result};
      } else if (result.response && typeof result.response === 'object') {
        result.response = normalize(result.response);
      }
      if (stage === 'request') rememberContext(result);
    } catch (_) { result = {}; }
    native.done(result);
  }
  const prefs = {
    valueForKey: read,
    setValueForKey: write,
    removeValueForKey: remove,
  };
  function notify(title, subtitle, message, options) {
    if (!native.notification || typeof native.notification.post !== 'function') return;
    let mapped = options;
    if (typeof options === 'string') mapped = {url: options};
    else if (options && typeof options === 'object') {
      mapped = clone(options);
      const url = options.url || options.openUrl || options['open-url'];
      if (url) mapped.url = url;
    }
    native.notification.post(title || '', subtitle || '', message || '', mapped);
  }
  const task = {fetch: options => new Promise((resolve, reject) => {
    const outgoing = typeof options === 'string' ? {url: options} : clone(options);
    if (!outgoing || typeof outgoing.url !== 'string') return reject({error: 'Invalid HTTP request'});
    if (outgoing.headers) outgoing.headers = clone(outgoing.headers);
    try { nativeBody(outgoing); }
    catch (_) { return reject({error: 'Invalid binary body'}); }
    if (outgoing.opts && typeof outgoing.opts === 'object') {
      if (!own(outgoing, 'policy') && own(outgoing.opts, 'policy')) outgoing.policy = outgoing.opts.policy;
      if (!own(outgoing, 'auto-redirect') && own(outgoing.opts, 'redirection')) outgoing['auto-redirect'] = outgoing.opts.redirection;
    }
    const method = String(outgoing.method || 'GET').toLowerCase();
    if (!native.httpClient || typeof native.httpClient[method] !== 'function') return reject({error: 'Unsupported HTTP method'});
    try {
      native.httpClient[method](outgoing, (error, reply, data) => {
        if (error || !reply) return reject({error: String(error || 'No HTTP response')});
        const result = clone(reply);
        if (!own(result, 'statusCode')) result.statusCode = result.status;
        if (!own(result, 'status')) result.status = result.statusCode;
        if (typeof data === 'string') result.body = data;
        else if (data != null) {
          const binary = copyBytes(data);
          if (binary) {
            result.bodyBytes = binary.buffer;
            result.body = utf8Text(binary);
          } else if (!own(result, 'body')) result.body = '';
        } else if (!own(result, 'body')) result.body = '';
        resolve(result);
      });
    } catch (error) { reject({error: String(error)}); }
  })};
  return {request, response, prefs, notify, task, done};
}
