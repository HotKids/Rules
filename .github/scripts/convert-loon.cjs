#!/usr/bin/env node
'use strict';

// Execute the official Script-Hub Beta parser using its own tests' Surge VM
// environment. The caller fetches and verifies the pinned parser before use.
// https://github.com/Script-Hub-Org/Script-Hub/blob/761f7864785d032cd1d1d616e5a298a0c07aae7d/tests/loon-v2-parser.test.cjs
// stdin: {sources: [{id, body}], httpBodies?: {url: body}}
// stdout: {results: [{id, text, diagnostics, unsupported, error?}]}
const fs = require('node:fs');
const vm = require('node:vm');

const UNSUPPORTED = /不支持|未支持|无法(?:完全|等价|无损|可靠|由|处理|识别)|不能|unsupported|not supported/i;
const WARNING = /转换提示|不是.*内置策略|警告|warning/i;

function redact(value) {
  // Error notifications can contain the entire request URL, including localtext.
  // Diagnostics must never expose source addresses or repeat a whole plugin.
  return String(value)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .replace(/https?(?::|%(?:25)*3a)(?:\\?\/|%(?:25)*2f){2}[^\s<>"']*/gi, '[URL]')
    .replace(/[^\s<>"'=]*_remove_ads\.lpx[^\s<>"']*/gi, '[URL]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;"'<>]+/gi, '[CREDENTIAL]')
    .replace(/(\b(?:proxy-authorization|authorization|set-cookie|cookie)\b["']?\s*[:=]\s*)[^\r\n]+/gi, '$1[REDACTED]')
    .replace(/([?&;][^?&;=\s]{1,100}=)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^&#\s]*)/g, '$1[REDACTED]')
    .replace(/(\b[\w-]*(?:password|passwd|token|secret|api[-_]?key|psk|localtext)\b["']?\s*(?:[:=]|%(?:25)*3[ad])\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/gi, '$1[REDACTED]');
}

async function convertSource(parser, source, {httpBodies = {}, timeoutMs = 10000} = {}) {
  const diagnostics = [];
  const seen = new Set();
  const timers = new Set();
  let unsupported = false;
  let completed = false;
  let failure;
  let finish;
  const finished = new Promise(resolve => { finish = resolve; });
  const addDiagnostic = (level, value) => {
    const message = redact(value);
    if (UNSUPPORTED.test(message)) {
      unsupported = true;
      level = 'warning';
    } else if (WARNING.test(message) && level === 'info') level = 'warning';
    const key = `${level}\0${message}`;
    if (message && !seen.has(key)) {
      seen.add(key);
      diagnostics.push({level, message});
    }
  };
  const fail = error => {
    if (completed) return;
    failure = redact(error?.message || error);
    completed = true;
    finish(undefined);
  };

  try {
    if (!source || typeof source.id !== 'string' || typeof source.body !== 'string') {
      throw new Error('Each source requires a string id and body');
    }
    if (!source.body.trim()) throw new Error('Source is empty');
    // Script-Hub decodes with decodeURIComponent rather than form decoding;
    // URLSearchParams would turn spaces into literal '+' in the source text.
    const query = Object.entries({
      type: 'loon-plugin', target: 'surge-module', localtext: source.body,
      sni: 'DOMAIN', pm: 'DOMAIN',
    }).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
    const requestUrl = `https://script.hub/file/_start_/http://local.text/_end_/?${query}`;
    const request = (options, callback) => {
      const url = typeof options === 'string' ? options : options?.url;
      if (!Object.prototype.hasOwnProperty.call(httpBodies, url)) {
        // An empty successful response would silently erase remote JQ content.
        addDiagnostic('error', 'Parser requested an unavailable remote dependency');
        callback('Remote dependency was not supplied', {status: 502, statusCode: 502, headers: {}}, '');
        return;
      }
      const body = httpBodies[url];
      if (typeof body !== 'string') {
        callback('Remote dependency body must be a string', {status: 502, statusCode: 502, headers: {}}, '');
        return;
      }
      callback(null, {status: 200, statusCode: 200, headers: {}}, body);
    };
    const context = {
      console: Object.fromEntries(['log', 'info', 'warn', 'error'].map(level => [level,
        (...args) => addDiagnostic(level === 'warn' ? 'warning' : level === 'error' ? 'error' : 'info', args.join(' ')),
      ])),
      Date, Error, JSON, Math, RegExp, String, Number, Object, Array, Map, Set,
      URL, URLSearchParams, Promise, Uint8Array, TextEncoder, TextDecoder,
      encodeURIComponent, decodeURIComponent, parseInt, parseFloat, isFinite,
      setTimeout: (callback, delay, ...args) => {
        const timer = setTimeout(() => {
          timers.delete(timer);
          try { callback(...args); } catch (error) { fail(error); }
        }, delay);
        timers.add(timer);
        return timer;
      },
      clearTimeout: timer => { timers.delete(timer); clearTimeout(timer); },
      $request: {url: requestUrl, method: 'GET', headers: {}},
      $response: {body: ''},
      $done: value => {
        if (completed) return;
        completed = true;
        finish(value);
      },
      $argument: '',
      $environment: {'surge-version': 'local-conversion'},
      $persistentStore: {read: () => null, write: () => true},
      $notification: {post: (title, subtitle, body) => {
        addDiagnostic('info', [title, subtitle, body].filter(Boolean).join('\n'));
      }},
      $httpClient: {get: request, post: request},
    };
    context.globalThis = context;
    const deadline = setTimeout(() => fail(new Error('Script-Hub conversion timed out')), timeoutMs);
    timers.add(deadline);
    parser.runInNewContext(context, {timeout: Math.min(timeoutMs, 2000)});
    const value = await finished;
    if (failure) throw new Error(failure);
    const response = value?.response ?? value;
    if (Number(response?.status ?? response?.statusCode ?? 200) >= 400) {
      // The parser formats errors into a response body. Keep only the first
      // useful line; its trailing notification URL can contain all localtext.
      throw new Error(String(response?.body || 'Script-Hub conversion failed').split(/\r?\n/)[0]);
    }
    const text = response?.body;
    if (typeof text !== 'string' || !text.trim()) throw new Error('Script-Hub returned empty conversion output');
    if (diagnostics.some(d => d.level === 'error')) throw new Error('Script-Hub reported a conversion error');
    return {id: source.id, text, diagnostics, unsupported};
  } catch (error) {
    const message = redact(error?.message || error);
    addDiagnostic('error', message);
    return {id: source?.id ?? null, text: '', diagnostics, unsupported, error: message};
  } finally {
    for (const timer of timers) clearTimeout(timer);
  }
}

async function convertBatch(parserText, input, options = {}) {
  if (!input || !Array.isArray(input.sources)) throw new Error('Input requires a sources array');
  if (input.httpBodies !== undefined && (!input.httpBodies || typeof input.httpBodies !== 'object' || Array.isArray(input.httpBodies))) {
    throw new Error('httpBodies must be an object of URL to response body');
  }
  const parser = new vm.Script(parserText, {filename: 'Rewrite-Parser.beta.js'});
  const results = [];
  // The official parser uses mutable global state. Each item receives a fresh
  // context, and batch order is identical to the configured source order.
  for (const source of input.sources) {
    results.push(await convertSource(parser, source, {...options, httpBodies: input.httpBodies ?? {}}));
  }
  return {results};
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--parser') {
    throw new Error('Usage: convert-loon.cjs --parser /path/to/verified/Rewrite-Parser.beta.js');
  }
  const parserText = fs.readFileSync(args[1], 'utf8');
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  process.stdout.write(JSON.stringify(await convertBatch(parserText, input)) + '\n');
}

module.exports = {convertBatch, redact};
if (require.main === module) main().catch(error => {
  process.stderr.write(`Loon conversion bridge: ${redact(error?.message || error)}\n`);
  process.exitCode = 1;
});
