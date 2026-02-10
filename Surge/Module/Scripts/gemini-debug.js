/**
 * Gemini API Debug Script - 排查 Region Blocked 问题
 *
 * 用法：在 Surge 中作为 Generic Panel 脚本运行
 * argument 传入 geminiapikey=YOUR_KEY
 *
 * 测试内容：
 *   1. GET  v1beta/models          （列模型 - 原方案）
 *   2. POST v1beta/models/gemini-2.0-flash:generateContent （生成内容）
 *   3. GET  v1beta/models/gemini-2.0-flash  （获取单个模型信息）
 *   4. GET  v1/models               （v1 稳定版列模型）
 */

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const TIMEOUT = 10000;

function parseArgs(str) {
  if (!str) return {};
  return Object.fromEntries(str.split("&").map(p => p.split("=")).filter(p => p.length === 2));
}

function request(options) {
  return new Promise((resolve, reject) => {
    const { url, method = "GET", headers = {}, body = null } = options;
    const finalHeaders = { "User-Agent": UA, ...headers };
    const timer = setTimeout(() => reject("Timeout"), TIMEOUT);
    const cb = (err, resp, data) => {
      clearTimeout(timer);
      if (err) return reject(err);
      resolve({ status: resp.status, headers: resp.headers || {}, body: data || "" });
    };
    const reqOpts = { url, headers: finalHeaders, body };
    method === "POST" ? $httpClient.post(reqOpts, cb) : $httpClient.get(reqOpts, cb);
  });
}

function truncate(str, len = 200) {
  if (!str) return "(empty)";
  return str.length > len ? str.substring(0, len) + "..." : str;
}

async function runTest(name, options) {
  const line = [`── ${name} ──`];
  try {
    const res = await request(options);
    line.push(`Status: ${res.status}`);
    // 输出关键响应头
    const interesting = ["content-type", "x-error-code", "x-debug-message", "location"];
    for (const key of interesting) {
      const val = res.headers[key] || res.headers[key.split("-").map((w,i) => i ? w[0].toUpperCase()+w.slice(1) : w).join("-")];
      if (val) line.push(`Header[${key}]: ${val}`);
    }
    line.push(`Body: ${truncate(res.body, 300)}`);
  } catch (e) {
    line.push(`Error: ${e}`);
  }
  return line.join("\n");
}

(async () => {
  const args = parseArgs(typeof $argument !== "undefined" ? $argument : "");
  const apiKey = (args.geminiapikey || "").trim();

  if (!apiKey || apiKey === "null") {
    $done({ title: "Gemini Debug", content: "No API Key provided\nSet geminiapikey in argument", icon: "exclamationmark.triangle.fill" });
    return;
  }

  const keyPreview = apiKey.substring(0, 6) + "..." + apiKey.substring(apiKey.length - 4);
  const results = [`API Key: ${keyPreview}\n`];

  // Test 1: GET v1beta/models (原检测方案)
  const t1 = await runTest("1. GET v1beta/models", {
    url: `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
  });
  results.push(t1);

  // Test 2: POST generateContent (生成方案)
  const t2 = await runTest("2. POST generateContent", {
    url: `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }] })
  });
  results.push(t2);

  // Test 3: GET 单个模型信息
  const t3 = await runTest("3. GET v1beta/models/gemini-2.0-flash", {
    url: `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash?key=${apiKey}`
  });
  results.push(t3);

  // Test 4: GET v1/models (稳定版)
  const t4 = await runTest("4. GET v1/models", {
    url: `https://generativelanguage.googleapis.com/v1/models?key=${apiKey}`
  });
  results.push(t4);

  $done({
    title: "Gemini API Debug",
    content: results.join("\n\n"),
    icon: "ladybug.fill"
  });
})();
