const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const runtime = fs.readFileSync(path.join(__dirname, '../scripts/qx-runtime.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function execute(source, {mode = 'response-body', request, response, store = new Map(),
                          namespace = 'test-source', now = 2000000000000,
                          platform = 'surge', httpClient, storage} = {}) {
  const outputs = [], notifications = [], requests = [], logs = [];
  class Clock extends Date { static now() { return now; } }
  const native = {request, response, platform,
    persistentStore: storage || {
      read: key => store.get(key) ?? null,
      write: (value, key) => { if (value === '' || value == null) store.delete(key); else store.set(key, value); return true; },
    },
    notification: {post: (...args) => notifications.push(args)},
    httpClient: httpClient || {get: (...args) => requests.push(args), post: (...args) => requests.push(args)},
    done: value => outputs.push(value),
  };
  const wrapped = `(function(native) {\n${runtime}\nconst bridge = createQxRuntime(native, ${JSON.stringify(mode)}, ${JSON.stringify(namespace)});\n` +
    `(function($request,$response,$prefs,$notify,$task,$done){\n${source}\n}).call(this,bridge.request,bridge.response,bridge.prefs,bridge.notify,bridge.task,bridge.done);\n})(native);`;
  vm.runInNewContext(wrapped, {native, Date: Clock, Uint8Array,
    console: {log: (...args) => logs.push(args), warn: (...args) => logs.push(args), error: (...args) => logs.push(args)}}, {timeout: 2000});
  return {outputs, notifications, requests, logs, store, native};
}
const request = (id = 'opaque-request-A', body = 'request-body') => ({
  id, url: 'https://api.example.invalid/gateway', method: 'POST', headers: {'X-Example': 'native'}, body,
});
const responseRequest = value => { const result = {...value}; delete result.body; return result; };
const observedBody = '$done(typeof $request.body === "undefined" ? {} : {body:$request.body});';

test('request context restores a body by the full opaque native ID without mutating inputs', () => {
  const req = request(), store = new Map();
  execute('$done({});', {mode: 'request-body', request: req, store});
  const incoming = responseRequest(req), before = plain(incoming);
  const result = execute(observedBody, {request: incoming, response: {status: 200, headers: {}}, store});
  assert.deepEqual(plain(result.outputs), [{body: 'request-body'}]);
  assert.deepEqual(incoming, before);
  assert.equal(store.size, 0);
  assert.equal(result.logs.length, 0);
});

test('only missing fields are restored and existing body, headers, method and status survive', () => {
  const req = request(), store = new Map();
  execute('$done({});', {mode: 'request', request: req, store});
  const incoming = {...req, body: 'already-present', headers: {'X-Actual': 'keep'}};
  const res = {status: 204, statusCode: 299, headers: {'X-Response': 'keep'}, body: 'untouched'};
  const result = execute('$done({body:JSON.stringify({request:$request,response:$response})});',
    {request: incoming, response: res, store});
  const actual = JSON.parse(result.outputs[0].body);
  assert.equal(actual.request.body, 'already-present');
  assert.deepEqual(actual.request.headers, {'X-Actual': 'keep'});
  assert.equal(actual.request.method, 'POST');
  assert.equal(actual.response.status, 204);
  assert.equal(actual.response.statusCode, 299);
  assert.deepEqual(res, {status: 204, statusCode: 299, headers: {'X-Response': 'keep'}, body: 'untouched'});
});

test('the cached context reflects returned request changes rather than facade mutations', () => {
  const req = request(), store = new Map();
  execute('$request.body="ignored-mutation";$done({body:"sent-body",headers:{"X-Sent":"yes"}});',
    {mode: 'request-body', request: req, store});
  const incoming = responseRequest(req); delete incoming.headers;
  const result = execute('$done({body:JSON.stringify({body:$request.body,headers:$request.headers})});',
    {request: incoming, store});
  assert.deepEqual(JSON.parse(result.outputs[0].body), {body: 'sent-body', headers: {'X-Sent': 'yes'}});
  assert.equal(req.body, 'request-body');
});

test('same URL and method never associate different full request IDs', () => {
  const store = new Map(), req = request();
  execute('$done({});', {mode: 'request', request: req, store});
  const result = execute(observedBody, {request: responseRequest(request('different-ID')), store});
  assert.deepEqual(plain(result.outputs), [{}]);
});

test('slot collisions lose the older context safely instead of assigning it to another request', () => {
  let pair;
  const slots = new Map();
  for (let i = 0; i < 40 && !pair; i++) {
    const store = new Map(), req = request('collision-' + i, 'body-' + i);
    execute('$done({});', {mode: 'request', request: req, store});
    const key = [...store.keys()][0];
    if (slots.has(key)) pair = [slots.get(key), req]; else slots.set(key, req);
  }
  assert.ok(pair);
  const store = new Map();
  for (const req of pair) execute('$done({});', {mode: 'request', request: req, store});
  assert.equal(store.size, 1);
  assert.deepEqual(plain(execute(observedBody, {request: responseRequest(pair[0]), store}).outputs), [{}]);
  assert.equal(execute(observedBody, {request: responseRequest(pair[1]), store}).outputs[0].body, pair[1].body);
});

test('an interleaved colliding write cannot supply a different request body', () => {
  const req = request(), store = new Map();
  execute('$done({});', {mode: 'request', request: req, store});
  const key = [...store.keys()][0], original = store.get(key);
  const other = JSON.stringify({...JSON.parse(original), id: 'id:different-request', body: 'wrong-body'});
  let swapped = false;
  const storage = {read: name => {
    const value = store.get(name) ?? null;
    if (name === key && !swapped) { store.set(key, other); swapped = true; }
    return value;
  }, write: (value, name) => { if (value == null || value === '') store.delete(name); else store.set(name, value); return true; }};
  const result = execute(observedBody, {request: responseRequest(req), store, storage});
  assert.equal(result.outputs[0].body, req.body);
  assert.notEqual(result.outputs[0].body, 'wrong-body');
});

test('conflicting platform request and response session IDs prevent restoration', () => {
  const req = {...request(), sessionIndex: 19}, store = new Map();
  execute('$done({});', {mode: 'request', request: req, store});
  const result = execute(observedBody, {request: responseRequest(req), response: {status: 200, sessionIndex: 20}, store});
  assert.deepEqual(plain(result.outputs), [{}]);
});

test('request contexts expire and future or malformed records are not consumed as data', () => {
  for (const offset of [180000, -1]) {
    const store = new Map(), req = request();
    execute('$done({});', {mode: 'request', request: req, store, now: 1000});
    const result = execute(observedBody, {request: responseRequest(req), store, now: 1000 + offset});
    assert.deepEqual(plain(result.outputs), [{}]);
  }
  const store = new Map(), req = request();
  execute('$done({});', {mode: 'request', request: req, store});
  const key = [...store.keys()][0]; store.set(key, '{bad-json');
  assert.deepEqual(plain(execute(observedBody, {request: responseRequest(req), store}).outputs), [{}]);
});

test('source namespace, URL and method must all match', () => {
  for (const changed of [{namespace: 'other-source'},
                         {request: {...responseRequest(request()), url: 'https://api.example.invalid/other'}},
                         {request: {...responseRequest(request()), method: 'GET'}}]) {
    const req = request(), store = new Map();
    execute('$done({});', {mode: 'request', request: req, store});
    const result = execute(observedBody, {request: responseRequest(req), store, ...changed});
    assert.deepEqual(plain(result.outputs), [{}]);
  }
});

test('missing stable IDs, undocumented platform IDs and oversized data never enter storage', () => {
  for (const changed of [{request: {...request(), id: undefined}}, {platform: 'stash'},
                         {request: request('large', 'x'.repeat(1048577))},
                         {request: {...request(), headers: {Huge: 'x'.repeat(65537)}}}]) {
    const store = new Map();
    execute('$done({});', {mode: 'request', request: request(), store, ...changed});
    assert.equal(store.size, 0);
  }
});

test('platform numeric session IDs are retained and opaque Surge IDs are never invented numbers', () => {
  for (const [req, expected] of [[{...request(), sessionIndex: 19}, 19], [request(), 'opaque-request-A']]) {
    const result = execute('$done({body:JSON.stringify([$request.sessionIndex,$response.sessionIndex])});',
      {request: req, response: {status: 200}});
    assert.deepEqual(JSON.parse(result.outputs[0].body), [expected, expected]);
  }
});

test('QX preference and notification interfaces map without logging values', () => {
  const result = execute('$prefs.setValueForKey("local-value","example");' +
    '$notify("title","subtitle","message",{"open-url":"app://open"});' +
    '$done({body:$prefs.valueForKey("example")});$prefs.removeValueForKey("example");', {mode: 'cron'});
  assert.equal(result.outputs[0].body, 'local-value');
  assert.equal(result.store.size, 0);
  assert.equal(result.notifications[0][3].url, 'app://open');
  assert.deepEqual(result.logs, []);
});

test('echo responses are nested with numeric status and response rewrites stay flat', () => {
  const source = '$done({status:"HTTP/1.1 200 OK",headers:{"Content-Type":"application/json"},body:"{}"});';
  const echoed = execute(source, {mode: 'echo', request: request()});
  assert.deepEqual(plain(echoed.outputs), [{response: {status: 200, headers: {'Content-Type': 'application/json'}, body: '{}'}}]);
  const response = execute(source, {mode: 'response', request: request()});
  assert.equal(response.outputs[0].status, 200);
  assert.equal(response.outputs[0].response, undefined);
});

test('request mocks do not capture bodies and done completes only once', () => {
  const result = execute('$done({status:"HTTP/1.1 503 Service Unavailable",body:"{}"});$done({body:"ignored"});',
    {mode: 'request', request: request()});
  assert.equal(result.outputs.length, 1);
  assert.equal(result.outputs[0].response.status, 503);
  assert.equal(result.store.size, 0);
});

test('HTTP facade dispatches methods, resolves response status and rejects network failures', async () => {
  const original = {url: 'https://example.invalid', method: 'PUT', headers: {Example: 'keep'}};
  const httpClient = {put: (options, callback) => {
    assert.equal(options.headers.Example, 'keep');
    callback(null, {status: 201, headers: {Result: 'yes'}}, 'response-text');
  }};
  const result = execute('$task.fetch(' + JSON.stringify(original) + ').then(r=>$done({body:JSON.stringify(r)}));',
    {mode: 'cron', httpClient});
  await new Promise(resolve => setImmediate(resolve));
  const actual = JSON.parse(result.outputs[0].body);
  assert.equal(actual.statusCode, 201);
  assert.equal(actual.status, 201);
  assert.equal(actual.body, 'response-text');
  const failed = execute('$task.fetch({url:"https://example.invalid"}).catch(e=>$done({body:e.error}));',
    {mode: 'cron', httpClient: {get: (_, callback) => callback('offline')}});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(failed.outputs[0].body, 'offline');
});

const fixture = process.env.QX_RUNTIME_UPSTREAM;
test('unchanged upstream source handles opaque-ID body recovery, AES key capture and template echo',
  {skip: !fixture}, () => {
    const source = fs.readFileSync(fixture, 'utf8');
    const req = {...request('native-AF-opaque'), url: 'https://api.hellobike.com/api',
      body: JSON.stringify({action: 'homepage.module.newdata'})};
    const store = new Map();
    execute(source, {mode: 'request-body', request: req, store});
    const res = {status: 200, headers: {}, body: JSON.stringify({code: 0,
      data: {moduleList: [{moduleKey: 'homepage_feeds_module'}, {moduleKey: 'keep'}]}})};
    const actual = execute(source, {request: responseRequest(req), response: res, store});
    assert.deepEqual(JSON.parse(actual.outputs[0].body).data.moduleList, [{moduleKey: 'keep'}]);
    const key = Buffer.from('0199bec97dfa5e0d');
    const payload = {code: 0, data: {key: 'test-dyn-key1234', 'key-version': 'test-v',
      'fingerprint-hash': 'test-f', expired: 2000003600}};
    const cipher = crypto.createCipheriv('aes-128-cbc', key, key);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]).toString('base64');
    const captured = execute(source, {request: {id: 'opaque-key', method: 'POST', headers: {},
      url: 'https://api.hellobike.com/secretkey'}, response: {status: 200, headers: {}, body: encrypted}});
    assert.equal(JSON.parse(captured.store.get('HelloBikeQXKeyCacheV1')).records[0].secret, payload.data.key);
    assert.equal(captured.notifications.length, 1);
    function encrypt(value) {
      const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(payload.data.key), Buffer.from(payload.data.key));
      return Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]).toString('base64');
    }
    const encryptedReq = {...req, id: 'opaque-encrypted', headers: {'key-version': 'test-v', 'fingerprint-hash': 'test-f'},
      body: encrypt({action: 'homepage.module.newdata'})};
    execute(source, {mode: 'request-body', request: encryptedReq, store: captured.store});
    const encryptedResponse = execute(source, {request: responseRequest(encryptedReq),
      response: {...res, body: encrypt(JSON.parse(res.body))}, store: captured.store});
    const decipher = crypto.createDecipheriv('aes-128-cbc', Buffer.from(payload.data.key), Buffer.from(payload.data.key));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(encryptedResponse.outputs[0].body, 'base64')), decipher.final()]).toString();
    assert.deepEqual(JSON.parse(decrypted).data.moduleList, [{moduleKey: 'keep'}]);
    const echoed = execute(source, {mode: 'echo', request: {id: 'opaque-echo', method: 'GET', headers: {},
      url: 'https://resource.51downapp.cn/f414fbc17c411b4e986ba8891c738a49.json?md5=e5230c919f7e3f3af3256161fbfaa0e2&hbe_qx_ui=1.3'}});
    assert.equal(echoed.outputs[0].response.status, 200);
    assert.ok(echoed.outputs[0].response.body.length > 1000);
    assert.equal(echoed.logs.length, 0);
  });
