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
                          platform = 'surge', httpClient, storage, globals = {}} = {}) {
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
  vm.runInNewContext(wrapped, {native, Date: Clock, Uint8Array, ...globals,
    console: {log: (...args) => logs.push(args), warn: (...args) => logs.push(args), error: (...args) => logs.push(args)}}, {timeout: 2000});
  return {outputs, notifications, requests, logs, store, native};
}
const request = (id = 'opaque-request-A', body = 'request-body') => ({
  id, url: 'https://api.example.invalid/gateway', method: 'POST', headers: {'X-Example': 'native'}, body,
});
const responseRequest = value => { const result = {...value}; delete result.body; return result; };
const observedBody = '$done(typeof $request.body === "undefined" ? {} : {body:$request.body});';
function decodingSpy() {
  let calls = 0;
  const constructor = value => String(value);
  Object.setPrototypeOf(constructor, String);
  constructor.fromCodePoint = (...points) => { calls++; return String.fromCodePoint(...points); };
  return {constructor, calls: () => calls};
}

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

test('binary request and response bodies expose exact bytes and UTF-8 text without browser APIs', () => {
  const text = '中文🙂\0' + 'a'.repeat(8191) + '🧪结束', data = Buffer.from(text);
  for (const platform of ['surge', 'stash']) for (const mode of ['request-body', 'response-body']) {
    const padded = new Uint8Array(data.length + 4); padded.set(data, 2);
    const input = padded.subarray(2, padded.length - 2), original = Array.from(padded);
    const target = mode === 'request-body' ? '$request' : '$response';
    const result = execute(`$done({body:JSON.stringify({text:${target}.body,` +
      `bytes:Array.from(new Uint8Array(${target}.bodyBytes)),decoder:typeof TextDecoder})});`,
      {mode, platform, request: {...request(), body: input}, response: mode === 'response-body' ? {body: input} : undefined});
    const actual = JSON.parse(result.outputs[0].body);
    assert.equal(actual.text, text);
    assert.deepEqual(actual.bytes, [...data]);
    assert.equal(actual.decoder, 'undefined');
    assert.deepEqual(Array.from(padded), original);
  }
});

test('host fields remain readable when non-enumerable or inherited from native prototypes', () => {
  for (const shape of ['nonenumerable value', 'nonenumerable getter', 'prototype getter']) {
    const reads = {};
    const host = values => {
      const result = {extra: 'keep'}, fields = {};
      for (const [key, value] of Object.entries(values)) {
        fields[key] = shape === 'nonenumerable value' ? {value, configurable: true} :
          {get() { reads[key] = (reads[key] || 0) + 1; return value; }, configurable: true};
      }
      if (shape === 'prototype getter') Object.setPrototypeOf(result, Object.defineProperties({}, fields));
      else Object.defineProperties(result, fields);
      return result;
    };
    const reqValues = {id: 'host-id', url: 'https://example.invalid/request', method: 'POST',
      sessionIndex: 19, headers: {'X-Request': 'keep'}, body: new Uint8Array(Buffer.from('request 中文'))};
    const resValues = {url: 'https://example.invalid/response', method: 'POST', status: 200,
      statusCode: 201, sessionIndex: 19, headers: {'X-Response': 'keep'}, body: new Uint8Array(Buffer.from('response 🙂'))};
    const req = host(reqValues), res = host(resValues);
    const result = execute('$done({body:JSON.stringify({request:[$request.id,$request.url,$request.method,$request.sessionIndex,' +
      '$request.headers["X-Request"],$request.body,$request.extra],response:[$response.url,$response.method,$response.status,' +
      '$response.statusCode,$response.sessionIndex,$response.headers["X-Response"],$response.body,$response.extra]})});',
      {request: req, response: res});
    assert.deepEqual(JSON.parse(result.outputs[0].body), {
      request: ['host-id', reqValues.url, 'POST', 19, 'keep', 'request 中文', 'keep'],
      response: [resValues.url, 'POST', 200, 201, 19, 'keep', 'response 🙂', 'keep'],
    });
    if (shape !== 'nonenumerable value') assert.equal(reads.body, 2, 'each native body is read once');
    assert.equal(reqValues.headers['X-Request'], 'keep');
    assert.equal(resValues.headers['X-Response'], 'keep');
  }
});

test('throwing native getters do not discard other fields or successful completions', () => {
  const req = {...request(), extra: 'request-meta'};
  Object.defineProperty(req, 'broken', {enumerable: true, get() { throw Error('unavailable extra'); }});
  Object.defineProperty(req, 'headers', {enumerable: false, get() { throw Error('unavailable headers'); }});
  delete req.method;
  Object.setPrototypeOf(req, {get method() { throw Error('unavailable method'); }});
  const res = {extra: 'response-meta', body: new Uint8Array(Buffer.from('readable'))};
  Object.defineProperty(res, 'status', {enumerable: false, get() { throw Error('unavailable status'); }});
  Object.setPrototypeOf(res, {get statusCode() { return 206; }, get headers() { return {'X-Actual': 'keep'}; }});
  const result = execute('$done({body:JSON.stringify([$request.url,$request.extra,$request.method,$request.headers,' +
    '$response.statusCode,$response.headers["X-Actual"],$response.body,$response.extra])});', {request: req, response: res});
  assert.deepEqual(JSON.parse(result.outputs[0].body), [req.url, 'request-meta', null, null, 206, 'keep', 'readable', 'response-meta']);
  const rewritten = execute('$done({body:"rewritten"});', {mode: 'request-body', request: req});
  assert.equal(rewritten.outputs[0].body, 'rewritten');
  assert.equal(rewritten.store.size, 0);
  const unavailable = {};
  for (const key of ['url', 'body', 'headers']) Object.defineProperty(unavailable, key,
    {get() { throw Error('unavailable native field'); }});
  const missing = execute('$done({body:JSON.stringify([$request.url||"missing",typeof $response.body])});',
    {request: unavailable, response: unavailable});
  assert.deepEqual(JSON.parse(missing.outputs[0].body), ['missing', 'undefined']);
});

test('documented host fields can be read even when enumeration and has checks omit them', () => {
  const body = new Uint8Array(Buffer.from('host data'));
  const native = values => new Proxy(values, {ownKeys: () => [], has: () => false,
    get: (target, key) => target[key]});
  const result = execute('$done({body:JSON.stringify([$request.url,$request.method,$request.headers.Example,' +
    '$response.url,$response.statusCode,$response.headers.Result,$response.body])});', {
    request: native({url: 'https://example.invalid/request', method: 'POST', headers: {Example: 'keep'}}),
    response: native({url: 'https://example.invalid/response', status: 202, headers: {Result: 'keep'}, body}),
  });
  assert.deepEqual(JSON.parse(result.outputs[0].body), ['https://example.invalid/request', 'POST', 'keep',
    'https://example.invalid/response', 202, 'keep', 'host data']);
});

test('native getter snapshots preserve string-cache contents without reading them again', () => {
  let bodyReads = 0, methodReads = 0;
  const original = {id: 'getter-cache', url: request().url, headers: {Actual: 'keep'}};
  Object.setPrototypeOf(original, {
    get body() { bodyReads++; return 'original-body'; },
    get method() { methodReads++; return 'POST'; },
  });
  const store = new Map();
  execute('$request.body="facade-only";$done({});', {mode: 'request-body', request: original, store});
  assert.equal(bodyReads, 1); assert.equal(methodReads, 1);
  const later = execute(observedBody, {request: {id: 'getter-cache', url: original.url, method: 'POST'}, store});
  assert.equal(later.outputs[0].body, 'original-body');
});

test('binary-only access never decodes text, including when an old string context exists', () => {
  const store = new Map(), original = request('lazy-context', 'old string');
  execute('$done({});', {mode: 'request-body', request: original, store});
  const spy = decodingSpy(), data = Uint8Array.from([0, 255, 128, 65]);
  const result = execute('$done({bodyBytes:$response.bodyBytes});',
    {request: {...original, body: data}, response: {body: data}, store, globals: {String: spy.constructor}});
  assert.equal(spy.calls(), 0);
  assert.deepEqual(Array.from(result.outputs[0].body), [0, 255, 128, 65]);
});

test('invalid bodyBytes do not prevent restoring the existing string-only request context', () => {
  for (const bodyBytes of ['invalid bytes', {}, null]) for (const explicitBody of [false, true]) {
    const store = new Map(), original = request();
    execute('$done({});', {mode: 'request-body', request: original, store});
    const incoming = {...responseRequest(original), bodyBytes};
    if (explicitBody) incoming.body = undefined;
    const result = execute(observedBody, {request: incoming, store});
    assert.equal(result.outputs[0].body, 'request-body');
  }
});

test('binary text is decoded once and its lazy accessor supports assignment and Object.assign', () => {
  const spy = decodingSpy(), data = new Uint8Array(Buffer.from('中文🙂'));
  const result = execute('const first=$response.body,reads=decodeCalls();' +
    'new Uint8Array($response.bodyBytes).fill(0);const second=$response.body;' +
    'const copied=Object.assign({},$response);Object.assign($response,{body:"override"});' +
    '$done({body:JSON.stringify([first,second,copied.body,$response.body,reads,decodeCalls()])});',
    {response: {body: data}, globals: {String: spy.constructor, decodeCalls: spy.calls}});
  const [first, second, copied, overridden, firstReads, lastReads] = JSON.parse(result.outputs[0].body);
  assert.deepEqual([first, second, copied, overridden], ['中文🙂', '中文🙂', '中文🙂', 'override']);
  assert.ok(firstReads > 0); assert.equal(firstReads, lastReads);
  assert.deepEqual(Array.from(data), [...Buffer.from('中文🙂')]);
  const unaccessed = decodingSpy();
  const setFirst = execute('Object.assign($response,{body:"assigned first"});$done({body:$response.body});',
    {response: {body: data}, globals: {String: unaccessed.constructor}});
  assert.equal(setFirst.outputs[0].body, 'assigned first');
  assert.equal(unaccessed.calls(), 0);
});

test('mutating bodyBytes before the first text read does not change its original text snapshot', () => {
  for (const mode of ['request-body', 'response-body']) {
    const spy = decodingSpy(), data = new Uint8Array(Buffer.from('原始文本🙂'));
    const target = mode === 'request-body' ? '$request' : '$response';
    const result = execute(`new Uint8Array(${target}.bodyBytes).fill(0);` +
      `const before=decodeCalls(),text=${target}.body;$done({body:JSON.stringify([before,text,` +
      `Array.from(new Uint8Array(${target}.bodyBytes))])});`,
      {mode, request: {...request(), body: data}, response: mode === 'response-body' ? {body: data} : undefined,
        globals: {String: spy.constructor, decodeCalls: spy.calls}});
    const [before, text, bytes] = JSON.parse(result.outputs[0].body);
    assert.equal(before, 0); assert.ok(spy.calls() > 0);
    assert.equal(text, '原始文本🙂');
    assert.deepEqual(bytes, new Array(data.length).fill(0));
    assert.deepEqual(Array.from(data), [...Buffer.from('原始文本🙂')]);
  }
});

test('binary views retain their byte ranges and facade mutations never touch native inputs', () => {
  const data = [0, 255, 128, 65, 0, 127, 1, 254];
  const factories = [
    () => Uint8Array.from(data).buffer,
    () => Uint8Array.from([9, ...data, 8]).subarray(1, 9),
    () => new DataView(Uint8Array.from([9, ...data, 8]).buffer, 1, 8),
    () => new Uint16Array(Uint8Array.from([9, 9, ...data, 8, 8]).buffer, 2, 4),
    () => vm.runInNewContext('new Uint8Array(' + JSON.stringify([9, ...data, 8]) + ').subarray(1,9)'),
  ];
  for (const make of factories) {
    const input = make(), raw = ArrayBuffer.isView(input)
      ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input);
    const result = execute('const b=new Uint8Array($response.bodyBytes);' +
      'const before=Array.from(b);b[0]=99;$response.body="changed";' +
      '$done({body:JSON.stringify(before)});', {response: {body: input}});
    assert.deepEqual(JSON.parse(result.outputs[0].body), data);
    assert.deepEqual(Array.from(raw), data);
  }
  const buffer = Uint8Array.from(data).buffer;
  const explicit = execute('$done({body:JSON.stringify({text:$response.body,bytes:Array.from(new Uint8Array($response.bodyBytes))})});',
    {response: {body: 'native-text', bodyBytes: buffer}});
  assert.deepEqual(JSON.parse(explicit.outputs[0].body), {text: 'native-text', bytes: data});
});

test('UTF-8 replacement decoding agrees with the standard while preserving every raw byte', () => {
  const samples = [[239, 187, 191, 65], [239, 187, 191, 239, 187, 191],
    [226, 40, 161], [224, 159, 128], [237, 160, 128], [244, 144, 128, 128],
    [225, 128], [194, 65], [240, 159, 167, 170], [244, 143, 191, 191], []];
  for (let byte = 0; byte < 256; byte++) samples.push([byte]);
  let seed = 123456789;
  for (let index = 0; index < 256; index++) {
    const bytes = [];
    for (let n = 0; n < index % 17; n++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; bytes.push(seed >>> 24); }
    samples.push(bytes);
  }
  const context = {samples, Uint8Array};
  vm.runInNewContext(runtime + '\nglobalThis.results=samples.map(sample=>{' +
    'const bridge=createQxRuntime({response:{body:new Uint8Array(sample)}});' +
    'return {text:bridge.response.body,bytes:Array.from(new Uint8Array(bridge.response.bodyBytes))};});', context);
  const expected = samples.map(sample => ({text: new TextDecoder().decode(Uint8Array.from(sample)), bytes: sample}));
  assert.deepEqual(plain(context.results), expected);
});

test('binary completions normalize ArrayBuffers and sliced views to isolated Uint8Arrays', () => {
  const expressions = ['bytes.buffer.slice(1,5)', 'bytes.subarray(1,5)',
    'new DataView(bytes.buffer,1,4)', 'new Uint16Array(bytes.buffer,2,2)'];
  for (const expression of expressions) for (const mode of ['request-body', 'response-body', 'echo']) {
    const expected = expression.includes('Uint16Array') ? [255, 128, 7, 88] : [0, 255, 128, 7];
    const result = execute('const bytes=new Uint8Array([99,0,255,128,7,88]);' +
      `const value={bodyBytes:${expression}};$done(value);` +
      'if(!Object.prototype.hasOwnProperty.call(value,"bodyBytes"))throw Error("mutated result");' +
      'bytes.fill(42);$done({body:"ignored"});', {mode, request: request()});
    assert.equal(result.outputs.length, 1);
    const actual = mode === 'echo' ? result.outputs[0].response : result.outputs[0];
    assert.equal(Object.prototype.toString.call(actual.body), '[object Uint8Array]');
    assert.deepEqual(Array.from(actual.body), expected);
    assert.equal(Object.prototype.hasOwnProperty.call(actual, 'bodyBytes'), false);
    assert.equal(result.store.size, 0);
  }
  const bytesBody = execute('$done({body:new Uint8Array([0,255]).buffer});');
  assert.equal(Object.prototype.toString.call(bytesBody.outputs[0].body), '[object Uint8Array]');
  assert.deepEqual(Array.from(bytesBody.outputs[0].body), [0, 255]);
  const invalid = execute('$done({bodyBytes:"not an ArrayBuffer"});');
  assert.deepEqual(plain(invalid.outputs), [{}]);
});

test('one binary route can process a JSON text view and leave other bytes untouched', () => {
  const result = execute('const body=JSON.parse($response.body);body.tab_gray=false;' +
    '$done({body:JSON.stringify(body)});', {response: {body: new Uint8Array(Buffer.from('{"tab_gray":true,"label":"中文"}'))}});
  assert.deepEqual(JSON.parse(result.outputs[0].body), {tab_gray: false, label: '中文'});
  const passthrough = execute('$done({});', {response: {body: Uint8Array.from([0, 255, 1])}});
  assert.deepEqual(plain(passthrough.outputs), [{}]);
  const text = execute('if(Object.prototype.hasOwnProperty.call($response,"bodyBytes"))throw Error("added bytes to text");$done({body:$response.body});',
    {response: {body: 'unchanged text'}});
  assert.equal(text.outputs[0].body, 'unchanged text');
});

test('binary request data is never persisted as lossy text in the string-only context cache', () => {
  for (const source of ['$done({});', '$done({bodyBytes:$request.bodyBytes});']) {
    const original = {...request(), body: Uint8Array.from([0, 255, 128, 65])}, store = new Map();
    execute(source, {mode: 'request-body', request: original, store});
    assert.equal(store.size, 0);
    const later = execute(observedBody, {request: responseRequest(original), store});
    assert.deepEqual(plain(later.outputs), [{}]);
  }
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

test('HTTP facade preserves byte slices in both directions and provides a text view', async () => {
  const responseText = '{"label":"中文🙂"}', bytes = new Uint8Array(Buffer.from(responseText));
  const padded = new Uint8Array(bytes.length + 2); padded.set(bytes, 1);
  const httpClient = {post: (options, callback) => {
    assert.equal(Object.prototype.toString.call(options.body), '[object Uint8Array]');
    assert.deepEqual(Array.from(options.body), [0, 255, 128]);
    assert.equal(Object.prototype.hasOwnProperty.call(options, 'bodyBytes'), false);
    callback(null, {status: 200}, new DataView(padded.buffer, 1, bytes.length));
  }};
  const result = execute('const bytes=new Uint8Array([99,0,255,128,88]);' +
    'const options={url:"https://example.invalid",method:"POST",bodyBytes:bytes.subarray(1,4)};' +
    '$task.fetch(options).then(r=>$done({body:JSON.stringify({text:r.body,bytes:Array.from(new Uint8Array(r.bodyBytes))})}));' +
    'if(!Object.prototype.hasOwnProperty.call(options,"bodyBytes"))throw Error("mutated HTTP options");', {mode: 'cron', httpClient});
  await new Promise(resolve => setImmediate(resolve));
  const actual = JSON.parse(result.outputs[0].body);
  assert.equal(actual.text, responseText);
  assert.deepEqual(actual.bytes, [...Buffer.from(responseText)]);
  assert.equal(padded[0], 0); assert.equal(padded[padded.length - 1], 0);
});

test('HTTP reply host fields survive native getters and binary-only consumers never decode text', async () => {
  const spy = decodingSpy(), headers = {Result: 'native'}, bytes = Uint8Array.from([0, 255, 128, 7]);
  let statusReads = 0;
  const reply = {extra: 'keep'};
  Object.defineProperty(reply, 'broken', {enumerable: true, get() { throw Error('unavailable extra'); }});
  Object.setPrototypeOf(reply, {
    get status() { statusReads++; return 207; },
    get headers() { return headers; },
    get url() { return 'https://example.invalid/final'; },
  });
  const result = execute('$task.fetch({url:"https://example.invalid"}).then(r=>{' +
    'r.headers.Result="facade-only";$done({bodyBytes:r.bodyBytes,headers:{Status:r.status+"/"+r.statusCode,' +
    'URL:r.url,Extra:r.extra}});});',
    {mode: 'cron', httpClient: {get: (_, callback) => callback(null, reply, bytes)}, globals: {String: spy.constructor}});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(spy.calls(), 0);
  assert.equal(statusReads, 1);
  assert.deepEqual(Array.from(result.outputs[0].body), [0, 255, 128, 7]);
  assert.deepEqual(plain(result.outputs[0].headers), {
    Status: '207/207', URL: 'https://example.invalid/final', Extra: 'keep',
  });
  assert.equal(headers.Result, 'native');
});

test('HTTP binary text remains an isolated snapshot when bytes change before its first read', async () => {
  const spy = decodingSpy(), bytes = new Uint8Array(Buffer.from('HTTP 原文🙂'));
  const result = execute('$task.fetch({url:"https://example.invalid"}).then(r=>{' +
    'new Uint8Array(r.bodyBytes).fill(0);$done({body:r.body});});',
    {mode: 'cron', httpClient: {get: (_, callback) => callback(null, {status: 200}, bytes)},
      globals: {String: spy.constructor}});
  assert.equal(spy.calls(), 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.outputs[0].body, 'HTTP 原文🙂');
  assert.ok(spy.calls() > 0);
  assert.deepEqual(Array.from(bytes), [...Buffer.from('HTTP 原文🙂')]);
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
