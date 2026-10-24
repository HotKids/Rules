const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {convertBatch} = require('../scripts/convert-loon.cjs');

const source = (id, body = '#!name=Example\n[Rule]\nDOMAIN,example.invalid,REJECT') => ({id, body});

test('bridge uses official local-text parameters and isolates source order', async () => {
  const parser = `
    var count = (globalThis.count || 0) + 1;
    const query = new URL($request.url).searchParams;
    if (!$request.url.includes('/_start_/http://local.text/_end_/')) throw Error('wrong source URL');
    for (const [key, value] of Object.entries({type:'loon-plugin',target:'surge-module',sni:'DOMAIN',pm:'DOMAIN'})) {
      if (query.get(key) !== value) throw Error('wrong parameter: ' + key);
    }
    $done({response:{status:200,body:count + ':' + query.get('localtext')}});
  `;
  const input = [source('one'), source('two', '#!name=Two & 100% + =')];
  const {results} = await convertBatch(parser, {sources:input});
  assert.deepEqual(results.map(r => [r.id, r.text]), input.map(s => [s.id, '1:' + s.body]));
  assert.ok(results.every(r => !r.unsupported && !r.error));
});

test('unsupported notifications remain visible with all diagnostic URLs redacted', async () => {
  const {results:[result]} = await convertBatch(`
    console.warn('surge不支持以下内容: request https://example.invalid/private.lpx');
    $notification.post('Script Hub', '转换提示', '无法等价转换 https://another.invalid/private');
    $done({response:{status:200,body:'[Rule]\\nDOMAIN,example.invalid,REJECT'}});
  `, {sources:[source('warning')]});
  assert.equal(result.unsupported, true);
  assert.equal(result.diagnostics.length, 2);
  assert.ok(result.diagnostics.every(d => d.level === 'warning'));
  assert.doesNotMatch(JSON.stringify(result.diagnostics), /https?:/);
  assert.match(JSON.stringify(result.diagnostics), /不支持以下内容/);
});

test('parser errors, malformed results, and timeouts do not stop later sources', async () => {
  const parser = `
    const text = new URL($request.url).searchParams.get('localtext');
    if (text === 'failure') throw Error('failure https://example.invalid/private');
    if (text === 'http') $done({response:{status:500,body:'failed https://example.invalid/private\\nmore details'}});
    else if (text === 'empty') $done({});
    else if (text !== 'timeout') setTimeout(() => $done({body:'converted'}), 1);
  `;
  const {results} = await convertBatch(parser, {sources:['failure','http','empty','timeout','ok'].map(s => source(s,s))}, {timeoutMs:30});
  assert.ok(results.slice(0,4).every(r => r.error && r.text === ''));
  assert.doesNotMatch(JSON.stringify(results), /https?:/);
  assert.equal(results[4].text, 'converted');
});

test('remote dependencies require supplied bodies rather than an empty successful response', async () => {
  const parser = `
    $httpClient.get({url:'https://example.invalid/filter.jq'}, (error, response, body) => {
      $done({response:{status:error ? 500 : response.status,body:error || body}});
    });
  `;
  const missing = await convertBatch(parser, {sources:[source('missing')]});
  assert.match(missing.results[0].error, /dependency/);
  const supplied = await convertBatch(parser, {sources:[source('supplied')], httpBodies:{'https://example.invalid/filter.jq':'del(.ads)'}});
  assert.equal(supplied.results[0].text, 'del(.ads)');
});

const parserPath = process.env.SCRIPT_HUB_PARSER;
test('pinned official parser preserves native Script options and Rewrite actions', {skip:!parserPath}, async () => {
  const body = [
    '#!name=Native fixture',
    '[Rule]',
    'DOMAIN,example.invalid,REJECT',
    '[Rewrite]',
    'request if ${url} ~= /^https:\\/\\/example\\.invalid\\/dict/ then reject_dict(200)',
    'request if ${url} ~= /^https:\\/\\/example\\.invalid\\/array/ then reject_array(200)',
    '[Script]',
    'response if ${url} ~= /^https:\\/\\/example\\.invalid\\/script/ then script("https://example.invalid/filter.js", "a=1&b=2") with tag="Native", requires_body=true, binary_body_mode=true, timeout=17',
    '[MITM]',
    'hostname = example.invalid',
  ].join('\n');
  const {results:[result]} = await convertBatch(fs.readFileSync(parserPath,'utf8'), {sources:[source('native',body)]});
  assert.equal(result.error, undefined, JSON.stringify(result.diagnostics));
  assert.equal(result.unsupported, false, JSON.stringify(result.diagnostics));
  assert.match(result.text, /\[Map Local\]/);
  assert.match(result.text, /data="\{\}"/);
  assert.match(result.text, /data="\[\]"/);
  assert.match(result.text, /requires-body=true/);
  assert.match(result.text, /binary-body-mode=true/);
  assert.match(result.text, /timeout=17/);
  assert.match(result.text, /argument="a=1&b=2"/);
  assert.match(result.text, /extended-matching/);
  assert.match(result.text, /pre-matching/);
  assert.doesNotMatch(result.text, /https:\/\/example\.invalid\/.*\.lpx/);
});
