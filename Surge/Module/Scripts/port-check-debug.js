/**
 * Email Port Check - Debug Version
 *
 * 检测 SMTP 端口（25/465/587）是否被封锁
 * 原理：向 SMTP 服务器发 HTTP 请求
 *   - 端口开放 → TCP 连通 → SMTP banner → httpClient 快速报错（<2s）
 *   - 端口封锁 → TCP 超时 → httpClient 慢超时（≥4s）
 *
 * @author HotKids&Claude
 * @version debug-0.1
 */

const TARGETS = [
  // 每个端口测两个服务器做交叉验证
  { label: "Port 25",  tests: [
    { url: "http://smtp.gmail.com:25/",    tag: "Gmail" },
    { url: "http://smtp-mail.outlook.com:25/", tag: "Outlook" },
  ]},
  { label: "Port 465", tests: [
    { url: "https://smtp.gmail.com:465/",  tag: "Gmail" },
    { url: "https://smtp.office365.com:465/", tag: "Outlook" },
  ]},
  { label: "Port 587", tests: [
    { url: "http://smtp.gmail.com:587/",   tag: "Gmail" },
    { url: "http://smtp-mail.outlook.com:587/", tag: "Outlook" },
  ]},
];

const TIMEOUT = 6000;       // 总超时
const THRESHOLD = 3000;     // 快/慢分界（ms）

// ─── HTTP 探测 ─────────────────────────────────────────────

function probe(url, timeout) {
  return new Promise(resolve => {
    const start = Date.now();
    const timer = setTimeout(() => {
      resolve({ elapsed: timeout, error: "hard_timeout", response: null, body: null });
    }, timeout);

    $httpClient.get({ url, timeout: timeout / 1000 }, (err, resp, body) => {
      clearTimeout(timer);
      const elapsed = Date.now() - start;
      resolve({ elapsed, error: err, response: resp, body: body?.substring(0, 200) });
    });
  });
}

// ─── 判定 ─────────────────────────────────────────────────

function judge(elapsed, error, response) {
  // 有 HTTP 响应 → 端口肯定开放（不太可能但处理）
  if (response && response.status) return "open";
  // 快速返回错误 → TCP 连通，协议不匹配 → 端口开放
  if (elapsed < THRESHOLD) return "open";
  // 慢超时 → 端口被封
  return "blocked";
}

// ─── 主流程 ─────────────────────────────────────────────────

(async () => {
  const results = [];
  const debugLines = [];

  for (const group of TARGETS) {
    let openCount = 0;
    let blockedCount = 0;

    for (const t of group.tests) {
      console.log(`[probe] ${t.tag} ${t.url}`);
      const r = await probe(t.url, TIMEOUT);
      const verdict = judge(r.elapsed, r.error, r.response);

      if (verdict === "open") openCount++;
      else blockedCount++;

      // debug 详情
      const errStr = r.error ? String(r.error).substring(0, 80) : "null";
      const status = r.response?.status || "N/A";
      debugLines.push(
        `${group.label} [${t.tag}] ${r.elapsed}ms → ${verdict}`,
        `  err: ${errStr}`,
        `  status: ${status}  body: ${(r.body || "").substring(0, 60)}`
      );
      console.log(`[result] ${t.tag} ${r.elapsed}ms → ${verdict} | err=${errStr}`);
    }

    // 综合判定：两个服务器中任一 open → 端口 open
    const final = openCount > 0 ? "✅ Open" : "❌ Blocked";
    results.push(`${group.label}: ${final}`);
  }

  const title = "📮 Email Port Check";
  const content = results.join("\n")
    + "\n\n── Debug Detail ──\n"
    + debugLines.join("\n");

  console.log("=== Done ===\n" + content);

  $done({
    title,
    content,
    icon: "envelope.fill",
    "icon-color": "#4A90D9"
  });
})();
