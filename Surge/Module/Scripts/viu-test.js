/**
 * Viu 解锁检测 —— 独立诊断脚本（临时，仅用于真机验证地区提取，验证后可删）
 *
 * 用途：单独跑 Viu 检测并把「原始响应关键信息」全部打印到面板，方便确认
 * media-check.js 里的地区提取正则在真实节点上是否命中、需不需要微调。
 *
 * 安装：作为 Surge 面板脚本运行（见配套 viu-test-panel.sgmodule），或在
 * 已有模块的 [Panel]/[Script] 里指向本文件。切换到目标节点后点面板刷新。
 *
 * 参考 lmc999/RegionRestrictionCheck：请求 www.viu.com，可用地区会重定向到
 * www.viu.com/ott/{area}/{lang}，不支持的地区落到 no-service 页。
 */

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const TIMEOUT = 8000;
const URL = "https://www.viu.com/";

// 用 $httpClient 原生回调，保留完整 response 对象以便探测 Surge 是否暴露最终 URL
function rawGet(url) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ err: "Timeout", resp: null, data: "" }), TIMEOUT);
    $httpClient.get(
      { url, headers: { "User-Agent": UA, "Accept-Language": "en" } },
      (err, resp, data) => {
        clearTimeout(timer);
        resolve({ err, resp: resp || null, data: data || "" });
      }
    );
  });
}

(async () => {
  try {
    const { err, resp, data } = await rawGet(URL);

    if (err) {
      return $done({
        title: "🟡 Viu 诊断",
        content: `请求失败 / 超时\nerror: ${err}`,
        icon: "questionmark.circle.fill",
        "icon-color": "#DAA520",
      });
    }

    const status = resp ? resp.status : "?";
    const headers = (resp && resp.headers) || {};
    const body = data || "";

    // Surge 是否暴露重定向后的最终 URL？把 response 对象的所有键列出来探测
    const respKeys = resp ? Object.keys(resp).join(",") : "(null)";
    const maybeUrl =
      (resp && (resp.url || resp.finalUrl || resp["url_effective"])) || "(无)";

    // 多个候选提取模式，逐个报告命中结果，便于确定最稳的一个
    const patterns = {
      "ott/xx/ (当前用)": /viu\.com\/ott\/([a-z]{2})\//i,
      "宽松 ott/xx": /\/ott\/([a-z]{2})[\/"']/i,
      "canonical": /<link[^>]+rel=["']canonical["'][^>]+href=["'][^"']*\/ott\/([a-z]{2})\//i,
      "og:url": /og:url["'][^>]+content=["'][^"']*\/ott\/([a-z]{2})\//i,
      "area_id": /area_id["']?\s*[:=]\s*["']?(\w+)/i,
    };
    const hits = Object.entries(patterns).map(([label, re]) => {
      const m = body.match(re);
      return `${m ? "✅" : "❌"} ${label}: ${m ? m[1] : "-"}`;
    });

    // 正文里 "/ott/" 第一次出现处的上下文（截 60 字），直观看到真实结构
    const idx = body.indexOf("/ott/");
    const ottContext = idx >= 0 ? body.slice(idx, idx + 60).replace(/\s+/g, " ") : "(正文无 /ott/)";

    // 关注的头部
    const pick = (k) => headers[k] || headers[k.toLowerCase()] || headers[k.toUpperCase()] || "";
    const loc = pick("Location");
    const cl = pick("Content-Language");
    const sc = (pick("Set-Cookie") || "").slice(0, 120);

    const content = [
      `HTTP: ${status}   body长度: ${body.length}`,
      `resp keys: ${respKeys}`,
      `final url?: ${maybeUrl}`,
      loc ? `Location: ${loc}` : null,
      cl ? `Content-Language: ${cl}` : null,
      sc ? `Set-Cookie: ${sc}` : null,
      `— 提取命中 —`,
      ...hits,
      `— /ott/ 上下文 —`,
      ottContext,
    ].filter(Boolean).join("\n");

    $done({
      title: "🔎 Viu 诊断",
      content,
      icon: "play.circle.fill",
      "icon-color": "#3CB371",
    });
  } catch (e) {
    $done({
      title: "❌ Viu 诊断异常",
      content: String((e && e.message) || e),
      icon: "exclamationmark.triangle.fill",
      "icon-color": "#FF6B6B",
    });
  }
})();
