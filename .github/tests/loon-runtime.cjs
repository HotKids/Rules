const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const runtime = fs.readFileSync(path.join(__dirname, '../scripts/loon-runtime.js'), 'utf8');
const createDone = vm.runInNewContext(runtime + '\ncreateLoonDone;', {
  console: {log() { throw Error('Runtime must not log completion data'); }},
});
const plain = value => JSON.parse(JSON.stringify(value));
function capture(mode = 'response-body') {
  const outputs = [];
  return {outputs, done: createDone(value => outputs.push(value), mode)};
}

test('response statuses normalize valid numbers, numeric strings and HTTP status lines', () => {
  for (const [status, expected] of [[100, 100], [404, 404], [599, 599], ['204', 204],
    [' 404 ', 404], ['HTTP/1.1 404 Not Found', 404], ['http/2 200 OK', 200], ['503 Unavailable', 503]]) {
    const {outputs, done} = capture();
    const input = Object.freeze({status, body: 'unchanged'});
    done(input);
    assert.equal(outputs[0].status, expected);
    assert.equal(outputs[0].body, input.body);
    assert.equal(input.status, status);
    assert.notEqual(outputs[0], input);
  }
});

test('response bytes retain exact type, range, identity and original inputs', () => {
  const backing = new Uint8Array([9, 0, 255, 128, 65, 8]);
  const body = backing.subarray(1, 5);
  const headers = Object.freeze({'Content-Type': 'application/octet-stream'});
  const source = Object.freeze({status: 'HTTP/1.1 200 OK', headers, body});
  const {outputs, done} = capture('http-response');
  done(source);
  assert.equal(outputs[0].body, body);
  assert.equal(outputs[0].headers, headers);
  assert.equal(Object.prototype.toString.call(outputs[0].body), '[object Uint8Array]');
  assert.deepEqual([...outputs[0].body], [0, 255, 128, 65]);
  assert.deepEqual([...backing], [9, 0, 255, 128, 65, 8]);
  assert.equal(source.status, 'HTTP/1.1 200 OK');
  assert.equal(source.body.byteOffset, body.byteOffset);
});

test('returning native host fields does not drop non-enumerable or prototype properties', () => {
  const body = new Uint8Array([0, 255, 128]);
  const headers = {'Content-Type': 'application/octet-stream'};
  for (const shape of ['non-enumerable', 'prototype', 'readable without has']) {
    const props = {status: 'HTTP/1.1 206 Partial Content', headers, body};
    let source;
    if (shape === 'non-enumerable') source = Object.defineProperties({}, Object.fromEntries(
      Object.entries(props).map(([key, value]) => [key, {value}])));
    else if (shape === 'prototype') source = Object.create(props);
    else source = new Proxy({}, {get: (_, key) => props[key], has: () => false});
    const {outputs, done} = capture();
    done(source);
    assert.equal(outputs[0].status, 206);
    assert.equal(outputs[0].body, body);
    assert.equal(outputs[0].headers, headers);
    assert.equal(source.status, props.status);
  }
});

test('request stages nest flat mocked responses while preserving their original fields', () => {
  for (const mode of ['request', 'request-body', 'http-request', 'http-request-body']) {
    const body = new Uint8Array([0, 255]);
    const headers = {'Content-Type': 'application/octet-stream'};
    const source = Object.freeze({status: 'HTTP/1.1 404 Not Found', headers, body});
    const {outputs, done} = capture(mode);
    done(source);
    assert.deepEqual(Object.keys(outputs[0]), ['response']);
    assert.equal(outputs[0].response.status, 404);
    assert.equal(outputs[0].response.body, body);
    assert.equal(outputs[0].response.headers, headers);
    assert.notEqual(outputs[0].response, source);
    assert.equal(source.status, 'HTTP/1.1 404 Not Found');
  }
});

test('request rewrites without status stay flat and do not become mock responses', () => {
  const body = new Uint8Array([1, 2, 3]);
  const source = {url: 'https://example.invalid/new', headers: {Keep: 'yes'}, body, policy: 'DIRECT'};
  const {outputs, done} = capture('request-body');
  done(source);
  assert.deepEqual(Object.keys(outputs[0]), ['url', 'headers', 'body', 'policy']);
  assert.equal(outputs[0].body, body);
  assert.equal(outputs[0].headers, source.headers);
  assert.equal(outputs[0].url, source.url);
  assert.equal(outputs[0].response, undefined);
});

test('explicit nested responses normalize independently without mutating caller objects', () => {
  const body = new Uint8Array([5, 6]);
  const response = Object.freeze({status: 'HTTP/1.1 206 Partial Content', body});
  const headers = Object.freeze({Changed: 'request'});
  const source = Object.freeze({response, headers, url: 'https://example.invalid/changed'});
  for (const mode of ['request-body', 'response-body']) {
    const {outputs, done} = capture(mode);
    done(source);
    assert.equal(outputs[0].response.status, 206);
    assert.equal(outputs[0].response.body, body);
    assert.equal(outputs[0].headers, headers);
    assert.equal(outputs[0].url, source.url);
    assert.notEqual(outputs[0], source);
    assert.notEqual(outputs[0].response, response);
  }
  assert.equal(response.status, 'HTTP/1.1 206 Partial Content');
  const {outputs, done} = capture('http-request');
  done({response: {body: 'default status'}});
  assert.deepEqual(plain(outputs), [{response: {body: 'default status'}}]);
});

test('invalid statuses and invalid nested responses complete safely without partial output', () => {
  for (const status of [99, 600, 404.5, NaN, Infinity, null, undefined, true, {}, [],
    '', '404.0', 'HTTP/1.1 error', 'HTTP/1.1 404\r\nInjected: yes']) {
    for (const value of [{status, body: 'private'}, {response: {status, body: 'private'}}]) {
      const {outputs, done} = capture('request');
      done(value);
      assert.deepEqual(plain(outputs), [{}]);
    }
  }
  for (const response of [null, undefined, [], 404, 'private']) {
    const {outputs, done} = capture('request');
    done({response});
    assert.deepEqual(plain(outputs), [{}]);
  }
});

test('empty or primitive completions safely pass through and abort fields are preserved', () => {
  for (const value of [undefined, null, 'finished', 0, true, []]) {
    const {outputs, done} = capture();
    done(value);
    assert.deepEqual(plain(outputs), [{}]);
  }
  const {outputs, done} = capture('request');
  done({abort: true});
  assert.deepEqual(plain(outputs), [{abort: true}]);
});

test('throwing output getters complete safely and never permit a second completion', () => {
  const source = {};
  Object.defineProperty(source, 'status', {enumerable: true, get() { throw Error('private data'); }});
  const {outputs, done} = capture('request');
  done(source);
  done({status: 200});
  assert.deepEqual(plain(outputs), [{}]);
  const nested = {};
  Object.defineProperty(nested, 'body', {enumerable: true, get() { throw Error('private body'); }});
  const other = capture('request');
  other.done({response: nested});
  assert.deepEqual(plain(other.outputs), [{}]);
});

test('completion stays once-only even if a getter or the native callback reenters it', () => {
  const {outputs, done} = capture();
  const source = {};
  Object.defineProperty(source, 'status', {enumerable: true, get() {
    done({status: 201});
    return 'HTTP/1.1 202 Accepted';
  }});
  done(source);
  done({status: 203});
  assert.deepEqual(plain(outputs), [{status: 202}]);
  let calls = 0;
  const failing = createDone(() => { calls++; throw Error('native callback failure'); }, 'request');
  assert.throws(() => failing({status: 404}), /native callback failure/);
  failing({status: 200});
  assert.equal(calls, 1);
});
