/**
 * Surge IP Security Check Script
 * 
 * 功能概述：
 * - 检测并显示入口/出口 IP 信息
 * - 评估 IP 风险等级和类型  
 * - 显示地理位置和运营商信息
 * 
 * 数据来源：
 * ① 入口 IP: bilibili API (DIRECT)
 * ② 出口 IP: ip.sb API
 * ③ 代理策略: Surge /v1/requests/recent
 * ④ 风险评分: IPQualityScore (主，需 API) → ProxyCheck (备) → Scamalytics (兜底)
 * ⑤ IP 类型: IPPure API
 * ⑥ 地理信息: ip.sb ip-api.com API
 * 
 * 参数说明：
 * - ipqs_key: IPQualityScore API Key (可选)
 * 
 * 配置示例：
 * [Script]
 * 
 * # 使用 IPQualityScore API Key（更准确）
 * IP-Security = type=generic,timeout=10,script-path=ip-security.js,argument=ipqs_key=YOUR_API_KEY
 * 
 * @author HotKids&Claude
 * @version 2.2.9
 * @date 2025-12-12
 */

// ============= 配置解析 =============
// 从 Surge argument 获取 IPQualityScore API Key
const args = $argument ? Object.fromEntries($argument.split("&").map(i => i.split("="))) : {};
const IPQS_API_KEY = (args.ipqs_key && args.ipqs_key !== "null") ? args.ipqs_key : "";

// ============= 全局状态 =============
// 防止重复调用 $done
let finished = false;
function done(o) {
  if (finished) return;
  finished = true;
  $done(o);
}

// 设置 9 秒超时保护
setTimeout(() => {
  done({
    title: "检测超时",
    content: "API 请求超时",
    icon: "xmark.shield.fill",
    "icon-color": "#CD5C5C"
  });
}, 9000);

// ============= HTTP 请求工具 =============
/**
 * 通用 HTTP JSON 请求
 * @param {string} url - 请求地址
 * @param {string} [policy] - 可选的代理策略
 * @returns {Promise<Object|null>} JSON 对象或 null
 */
function httpJSON(url, policy) {
  return new Promise(r => {
    $httpClient.get(policy ? { url, policy } : { url }, (_, __, d) => {
      try { r(JSON.parse(d)); } catch { r(null); }
    });
  });
}

/**
 * HTTP 原始内容请求
 * @param {string} url - 请求地址
 * @returns {Promise<string|null>} 原始响应文本或 null
 */
function httpRaw(url) {
  return new Promise(r => {
    $httpClient.get({ url }, (_, __, d) => r(d || null));
  });
}

// ============= Surge API 交互 =============
/**
 * 从 Surge 最近请求中获取实际使用的代理策略
 * 通过查找最近的 ipapi.co 请求来确定使用的策略
 * @returns {Promise<string>} 代理策略名称
 */
function getPolicy() {
  return new Promise(r => {
    $httpAPI("GET", "/v1/requests/recent", null, res => {
      const hit = res?.requests
        ?.slice(0, 10)
        .find(i => /(api\.ip\.sb|ip-api\.com)/i.test(i.URL));
      r(hit?.policyName || "DIRECT");
    });
  });
}

// ============= 数据处理工具 =============
/**
 * 将国家代码转换为国旗 emoji
 * @param {string} cc - ISO 3166-1 alpha-2 国家代码
 * @returns {string} 国旗 emoji 或空字符串
 */
function flag(cc) {
  if (!cc || cc.length !== 2) return "";
  
  // 台湾地区回落到中国国旗（国行设备兼容）
  if (cc.toUpperCase() === "TW") cc = "CN";
  
  const b = 0x1f1e6;
  return String.fromCodePoint(
    b + cc.charCodeAt(0) - 65, 
    b + cc.charCodeAt(1) - 65
  );
}

/**
 * 根据风险分数返回对应的描述和颜色
 * @param {number} s - 风险分数 (0-100)
 * @returns {Array} [描述文本, 颜色代码]
 */
function riskText(s) {
  if (s <= 15) return ["极度纯净 IP", "#006400"];
  if (s <= 25) return ["纯净 IP", "#3CB371"];
  if (s <= 40) return ["一般 IP", "#9ACD32"];
  if (s <= 50) return ["微风险 IP", "#FFD700"];
  if (s <= 70) return ["一般风险 IP", "#FF8C00"];
  return ["极度风险 IP", "#CD5C5C"];
}

/**
 * 从 Scamalytics HTML 中解析风险分数
 * @param {string} html - HTML 内容
 * @returns {number|null} 风险分数或 null
 */
function parseScore(html) {
  const m = html?.match(/Fraud Score[^0-9]*([0-9]{1,3})/i);
  return m ? Number(m[1]) : null;
}

// ============= 风险评分获取（三级回落） =============
/**
 * 获取 IP 风险分数（三级回落策略）
 * 优先级：IPQualityScore → ProxyCheck → Scamalytics
 * @param {string} ip - 要检测的 IP
 * @returns {Promise<Object>} 包含分数和来源的对象
 */
async function getRiskScore(ip) {
  let score = null;
  let source = "";
  
  // 1. 尝试 IPQualityScore（需要 API Key）
  if (IPQS_API_KEY) {
    try {
      const ipqs = await httpJSON(
        `https://ipqualityscore.com/api/json/ip/${IPQS_API_KEY}/${ip}?strictness=1`
      );
      if (ipqs?.success && ipqs?.fraud_score !== undefined) {
        score = ipqs.fraud_score;
        source = "IPQS";
      }
    } catch (e) {
      console.log("IPQS failed:", e);
    }
  }
  
  // 2. 回落到 ProxyCheck.io（免费）
  if (score === null) {
    try {
      const proxycheck = await httpJSON(
        `https://proxycheck.io/v2/${ip}?risk=1&vpn=1`
      );
      if (proxycheck?.[ip]?.risk !== undefined) {
        score = proxycheck[ip].risk;
        source = "ProxyCheck";
      }
    } catch (e) {
      console.log("ProxyCheck failed:", e);
    }
  }
  
  // 3. 兜底使用 Scamalytics（免费）
  if (score === null) {
    try {
      const html = await httpRaw(`https://scamalytics.com/ip/${ip}`);
      score = parseScore(html);
      if (score !== null) {
        source = "Scamalytics";
      }
    } catch (e) {
      console.log("Scamalytics failed:", e);
    }
  }
  
  // 如果全部失败，返回默认值
  return { 
    score: score ?? 50, 
    source: source || "Default" 
  };
}

// ============= 主执行函数 =============
(async () => {
  // ========== 1. 获取入口 IP（直连）==========
  const enter = await httpJSON(
    "https://api.bilibili.com/x/web-interface/zone",
    "DIRECT"
  );
  const inIP = enter?.data?.addr;

  // ========== 2. 获取出口 IP（代理）==========
  // 出口 IPv4
  const exit = await httpJSON("https://api.ip.sb/geoip");
  const outIP = exit?.ip;
  // 出口 IPv6
  const exit6 = await Promise.race([httpJSON("https://api64.ip.sb/geoip"), new Promise(r => setTimeout(() => r(null), 1500))]);
  const outIP6 = exit6?.ip;

  // 验证 IP 获取成功
  if (!inIP || !outIP) {
    return done({
      title: "出口 IP 获取失败",
      content: "无法获取入口或出口 IPv4",
      icon: "xmark.shield.fill",
      "icon-color": "#CD5C5C"
    });
  }

  // ========== 3. 获取真实代理策略 ==========
  const policy = await getPolicy();

  // ========== 4. 获取 IP 风险评分（三级回落）==========
  const riskInfo = await getRiskScore(outIP);
  const [riskLabel, color] = riskText(riskInfo.score);
  
  // ========== 5. 获取 IP 类型（IPPure）==========
  const ippure = await httpJSON("https://my.ippure.com/v1/info");
  const ipType = ippure?.isResidential ? "住宅 IP" : "机房 IP";
  const ipSrc = ippure?.isBroadcast ? "广播 IP" : "原生 IP";

  // ========== 6. 获取地理位置和运营商信息 ==========
  const [inGeo, outGeo, inISP, outISP] = await Promise.all([
  httpJSON(`http://ip-api.com/json/${inIP}?fields=countryCode,regionName,city`),
  httpJSON(`http://ip-api.com/json/${outIP}?fields=countryCode,regionName,city`),
  httpJSON(`https://api.ip.sb/geoip/${inIP}`),
  httpJSON(`https://api.ip.sb/geoip/${outIP}`)
]);
  
  // ========== 7. 构建显示内容 ==========
  const content = [
    `IP 风控值：${riskInfo.score}% ${riskLabel} (${riskInfo.source})`,
    ``,
    `IP 类型：${ipType} | ${ipSrc}`,
    ``,
    `入口 IP：${inIP}`,
    `地区：${flag(inGeo?.countryCode)} ${[inGeo?.city, inGeo?.regionName, inGeo?.countryCode].filter(Boolean).join(", ")}`,
    `运营商：${inISP?.organization || "Unknown"}`,
    ``,

    ...(outIP6 ? (() => {
      const same =
        outGeo?.countryCode === exit6?.country_code &&
        outISP?.organization === exit6?.organization;

      if (same) {
        return [
          `出口 IP⁴：${outIP}`,
          `出口 IP⁶：${outIP6}`,
          `地区：${flag(outGeo?.countryCode)} ${[outGeo?.city, outGeo?.regionName, outGeo?.countryCode].filter(Boolean).join(", ")}`,
          `运营商：${outISP?.organization || "Unknown"}`
        ];
      }

      return [
        `出口 IP⁴：${outIP}`,
        `地区⁴：${flag(outGeo?.countryCode)} ${[outGeo?.city, outGeo?.regionName, outGeo?.countryCode].filter(Boolean).join(", ")}`,
        `运营商⁴：${outISP?.organization || "Unknown"}`,
        ``,
        `出口 IP⁶：${outIP6}`,
        `地区⁶：${flag(exit6?.country_code)} ${[exit6?.city, exit6?.region, exit6?.country_code].filter(Boolean).join(", ")}`,
        `运营商⁶：${exit6?.organization || "Unknown"}`
      ];
    })() : [
      `出口 IP：${outIP}`,
      `地区：${flag(outGeo?.countryCode)} ${[outGeo?.city, outGeo?.regionName, outGeo?.countryCode].filter(Boolean).join(", ")}`,
      `运营商：${outISP?.organization || "Unknown"}`
    ])
  ].join("\n");

  done({
    title: `代理策略：${policy}`,
    content,
    icon: "shield.lefthalf.filled",
    "icon-color": color
  });
})();
