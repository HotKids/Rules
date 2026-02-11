/**
 * Surge IP Security Check Script
 *
 * 功能概述：
 * - 检测并显示本地/入口/出口 IP 信息
 * - 评估 IP 风险等级和类型
 * - 显示地理位置和运营商信息
 * - 支持网络变化自动检测和通知
 *
 * 数据来源：
 * ① 本地 IP: bilibili API (DIRECT)
 * ② 出口 IP: ip.sb API (IPv4/IPv6)
 * ③ 入口 IP: Surge /v1/requests/recent → remoteAddress(Proxy)
 * ④ 代理策略: Surge /v1/requests/recent
 * ⑤ 风险评分: IPQualityScore (可选，需 API Key) → ProxyCheck → IPPure → Scamalytics (兜底)
 * ⑥ IP 类型: IPPure API
 * ⑦ 地理: 本地 IP → local_geoapi=bilibili bilibili / local_geoapi=ipsb ip.sb | 入口/出口 IP 地区 → remote_geoapi=ipinfo ipinfo.io / remote_geoapi=ipapi ip-api.com(en) / remote_geoapi=ipapi-zh ip-api.com(zh)
 * ⑧ 运营商: 入口/出口 IP 始终使用 ipinfo.io
 * ⑨ DNS 泄露: edns.ip-api.com（检测 DNS 解析器是否泄露到本地 ISP）
 * ⑩ 反向 DNS: ipinfo.io hostname 字段
 * ⑪ 流量统计: Surge /v1/traffic API
 *
 * 参数说明：
 * - TYPE: 设为 EVENT 表示网络变化触发（自动判断，无需手动设置）
 * - ipqs_key: IPQualityScore API Key（可选，仅 risk_api=ipqs 或回落模式需要）
 * - risk_api: 风险评分数据源，ipqs / proxycheck / ippure / scamalytics（可选，不填则四级回落）
 * - local_geoapi: 本地 IP 地理数据源，bilibili(默认)=bilibili(中文)，ipsb=ip.sb(英文)
 * - remote_geoapi: 入口/出口地理数据源，ipinfo(默认)=ipinfo.io，ipapi=ip-api.com(英文)，ipapi-zh=ip-api.com(中文)
 * - mask_ip: IP 打码，1=开启，0=关闭，默认 0
 * - tw_flag: 台湾地区旗帜，cn(默认)=🇨🇳，tw=🇹🇼
 * - event_delay: 网络变化后延迟检测（秒），默认 2 秒
 *
 * 配置示例：
 * [Panel]
 * ip-security-panel = script-name=ip-security-panel,update-interval=600
 *
 * [Script]
 * # 手动触发（面板）- ipqs_key 可选，不填自动回落
 * ip-security-panel = type=generic,timeout=10,script-path=ip-security.js,argument=ipqs_key=YOUR_API_KEY
 *
 * # 网络变化自动触发
 * ip-security-event = type=event,event-name=network-changed,timeout=10,script-path=ip-security.js,argument=TYPE=EVENT&ipqs_key=YOUR_API_KEY&event_delay=2
 *
 * @author HotKids&Claude
 * @version 6.0.0
 * @date 2026-02-11
 */

// ==================== 全局配置 ====================
const CONFIG = {
  name: "ip-security",
  timeout: 10000,
  storeKeys: {
    lastEvent: "lastNetworkInfoEvent",
    lastPolicy: "lastProxyPolicy",
    riskCache: "riskScoreCache",
    maskToggle: "ipMaskToggle",
    lastRun: "ipLastRunTime"
  },
  urls: {
    localIP: "https://api.bilibili.com/x/web-interface/zone",
    outboundIP: "https://api-ipv4.ip.sb/geoip",
    outboundIPv6: "https://api-ipv6.ip.sb/geoip",
    ipType: "https://my.ippure.com/v1/info",
    ipTypeCard: "https://my.ippure.com/v1/card",
    ipSbGeo: (ip) => `https://api.ip.sb/geoip/${ip}`,
    ipInfo: (ip) => `https://ipinfo.io/${ip}/json`,
    ipApi: (ip, lang) => `http://ip-api.com/json/${ip}?lang=${lang}&fields=status,country,countryCode,regionName,city,isp,org`,
    ipqs: (key, ip) => `https://ipqualityscore.com/api/json/ip/${key}/${ip}?strictness=1`,
    proxyCheck: (ip) => `https://proxycheck.io/v2/${ip}?risk=1&vpn=1`,
    scamalytics: (ip) => `https://scamalytics.com/ip/${ip}`,
    dnsLeak: () => {
      const c = "abcdefghijklmnopqrstuvwxyz0123456789";
      let id = "";
      for (let i = 0; i < 32; i++) id += c[Math.floor(Math.random() * c.length)];
      return `http://${id}.edns.ip-api.com/json`;
    }
  },
  ipv6Timeout: 3000,
  policyRetryDelay: 500,
  riskLevels: [
    { max: 15, label: "极度纯净", color: "#0D6E3D" },
    { max: 25, label: "纯净",     color: "#2E9F5E" },
    { max: 40, label: "一般",     color: "#8BC34A" },
    { max: 50, label: "微风险",   color: "#FFC107" },
    { max: 70, label: "一般风险", color: "#FF9800" },
    { max: 100, label: "极度风险", color: "#F44336" }
  ]
};

// ==================== 参数解析 ====================
function parseArguments() {
  let arg = {};

  if (typeof $argument !== "undefined") {
    arg = Object.fromEntries($argument.split("&").map(i => {
      const idx = i.indexOf("=");
      return idx === -1 ? [i, ""] : [i.slice(0, idx), i.slice(idx + 1)];
    }));
  }

  const storedArg = $persistentStore.read(CONFIG.name);
  if (storedArg) {
    try { arg = { ...JSON.parse(storedArg), ...arg }; } catch (e) {}
  }

  const isPanel = typeof $input !== "undefined" && $input.purpose === "panel";
  const isRequest = typeof $request !== "undefined";
  if (!isPanel && !isRequest) {
    arg.TYPE = "EVENT";
  }

  return {
    isEvent: arg.TYPE === "EVENT",
    ipqsKey: (arg.ipqs_key && arg.ipqs_key !== "null") ? arg.ipqs_key : "",
    riskApi: (arg.risk_api && arg.risk_api !== "null") ? arg.risk_api.toLowerCase() : "",
    localGeoApi: (arg.local_geoapi && arg.local_geoapi !== "null") ? arg.local_geoapi : "bilibili",
    remoteGeoApi: (arg.remote_geoapi && arg.remote_geoapi !== "null") ? arg.remote_geoapi : "ipinfo",
    maskIP: arg.mask_ip === "1" || arg.mask_ip === "true",
    twFlag: (arg.tw_flag && arg.tw_flag !== "null") ? arg.tw_flag : "cn",
    eventDelay: parseFloat(arg.event_delay) || 2
  };
}

const args = parseArguments();
console.log("触发类型: " + (args.isEvent ? "EVENT" : "MANUAL") + ", risk_api: " + (args.riskApi || "fallback") + ", 本地: " + args.localGeoApi);

// ==================== 全局状态控制 ====================
let finished = false;

function done(o) {
  if (finished) return;
  finished = true;
  $done(o);
}

setTimeout(() => {
  done({ title: "检测超时", content: "API 请求超时", icon: "leaf", "icon-color": "#9E9E9E" });
}, CONFIG.timeout);

// ==================== HTTP 工具 ====================
function httpJSON(url, policy) {
  return new Promise(r => {
    $httpClient.get(policy ? { url, policy } : { url }, (_, __, d) => {
      try { r(JSON.parse(d)); } catch { r(null); }
    });
  });
}

function httpRaw(url) {
  return new Promise(r => {
    $httpClient.get({ url }, (_, __, d) => r(d || null));
  });
}

function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function surgeAPI(method, path) {
  return new Promise(r => {
    $httpAPI(method, path, null, res => r(res));
  });
}

// IPPure 请求去重：getIPType 和 tryIPPure 共享同一个请求
let _ippureInfoP = null, _ippureCardP = null;
function getIPPureInfo() { return _ippureInfoP || (_ippureInfoP = httpJSON(CONFIG.urls.ipType)); }
function getIPPureCard() { return _ippureCardP || (_ippureCardP = httpRaw(CONFIG.urls.ipTypeCard)); }

// ==================== 数据处理工具 ====================
function flag(cc) {
  if (!cc || cc.length !== 2) return "";
  cc = cc.toUpperCase();
  if (cc === "TW" && args.twFlag !== "tw") cc = "CN";
  const b = 0x1f1e6;
  return String.fromCodePoint(b + cc.charCodeAt(0) - 65, b + cc.charCodeAt(1) - 65);
}

function riskText(score) {
  const level = CONFIG.riskLevels.find(l => score <= l.max) || CONFIG.riskLevels.at(-1);
  return { label: level.label, color: level.color };
}

function maskIP(ip) {
  if (!ip) return ip;
  if (ip.includes(":")) {
    const parts = ip.split(":");
    if (parts.length <= 2) return ip;
    return parts[0] + ":" + parts.slice(1, -1).map(() => "**").join(":") + ":" + parts.at(-1);
  }
  const parts = ip.split(".");
  if (parts.length !== 4) return ip;
  return parts[0] + ".***.***." + parts[3];
}

function formatGeo(countryCode, ...parts) {
  const unique = parts.filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
  return flag(countryCode) + " " + unique.join(", ");
}

function normalizeIpSb(data) {
  if (!data || !data.country_code) return null;
  return {
    country_code: data.country_code,
    country_name: data.country,
    city: data.city,
    region: data.region,
    org: data.organization
  };
}

function normalizeIpInfo(data) {
  if (!data || !data.country) return null;
  return {
    country_code: data.country,
    country_name: data.country,
    city: data.city,
    region: data.region,
    org: data.org ? data.org.replace(/^AS\d+\s*/, "") : ""
  };
}

/**
 * 将 ip-api.com 返回字段归一化为内部格式
 * ip-api.com: { status:"success", country, countryCode, regionName, city, isp, org }
 */
function normalizeIpApi(data) {
  if (!data || data.status !== "success") return null;
  return {
    country_code: data.countryCode,
    country_name: data.country,
    city: data.city,
    region: data.regionName,
    org: data.isp || data.org || ""
  };
}

function normalizeBilibili(data) {
  const d = data?.data;
  if (!d || !d.country) return null;
  let isp = d.isp || "";
  if (/^(移动|联通|电信|广电)$/.test(isp)) isp = "中国" + isp;
  return {
    country_code: null,
    country_name: d.country,
    city: d.city || "",
    region: d.province,
    org: isp
  };
}

function parseScamalyticsScore(html) {
  const m = html?.match(/Fraud Score[^0-9]*([0-9]{1,3})/i);
  return m ? Number(m[1]) : null;
}

// ==================== 代理策略与入口 IP 获取 ====================
/**
 * 从 Surge 最近请求中同时获取代理策略和入口 IP
 * 入口 IP 通过 remoteAddress 的 (Proxy) 后缀识别
 */
async function getPolicyAndEntrance() {
  const pattern = /(api(-ipv4)?\.ip\.sb|ipinfo\.io|ip-api\.com)/i;

  async function findInRecent(limit) {
    const res = await surgeAPI("GET", "/v1/requests/recent");
    return (res?.requests || []).slice(0, limit).find(i => pattern.test(i.URL));
  }

  let hit = await findInRecent(50);
  if (!hit) {
    console.log("未找到策略记录，等待后重试 (1/2)");
    await wait(CONFIG.policyRetryDelay);
    hit = await findInRecent(50);
  }
  if (!hit) {
    console.log("未找到策略记录，等待后重试 (2/2)");
    await wait(CONFIG.policyRetryDelay * 2);
    hit = await findInRecent(100);
  }

  if (!hit) {
    const lastPolicy = $persistentStore.read(CONFIG.storeKeys.lastPolicy);
    console.log(lastPolicy ? "使用上次保存的策略: " + lastPolicy : "无法找到任何策略信息");
    return { policy: lastPolicy || "Unknown", entranceIP: null };
  }

  const policy = hit.policyName || "Unknown";
  $persistentStore.write(policy, CONFIG.storeKeys.lastPolicy);
  console.log("找到代理策略: " + policy);

  let entranceIP = null;
  if (/\(Proxy\)/.test(hit.remoteAddress)) {
    entranceIP = hit.remoteAddress.replace(/\s*\(Proxy\)\s*/, "").replace(/:\d+$/, "");
    console.log("找到入口 IP: " + entranceIP);
  }

  return { policy, entranceIP };
}

// ==================== 风险评分获取 ====================
// risk_api 参数：ipqs / proxycheck / ippure / scamalytics → 指定单一数据源
// 不填或其他值 → 四级回落（IPQS → ProxyCheck → IPPure → Scamalytics）
async function getRiskScore(ip) {
  const api = args.riskApi;
  const cached = $persistentStore.read(CONFIG.storeKeys.riskCache);
  if (cached) {
    try {
      const c = JSON.parse(cached);
      if (c.ip === ip && (c.api || "") === api) {
        console.log("风险评分命中缓存: " + c.score + "% (" + c.source + ")");
        return { score: c.score, source: c.source };
      }
    } catch (e) {}
  }

  function saveAndReturn(score, source) {
    $persistentStore.write(JSON.stringify({ ip, score, source, api }), CONFIG.storeKeys.riskCache);
    console.log("风险评分已缓存: " + score + "% (" + source + ")");
    return { score, source };
  }

  async function tryIPQS() {
    if (!args.ipqsKey) return null;
    const data = await httpJSON(CONFIG.urls.ipqs(args.ipqsKey, ip));
    if (data?.success && data?.fraud_score !== undefined) return saveAndReturn(data.fraud_score, "IPQS");
    console.log("IPQS 失败: " + (data ? "success=" + data.success + " message=" + (data.message || "") : "请求失败"));
    return null;
  }

  async function tryProxyCheck() {
    const data = await httpJSON(CONFIG.urls.proxyCheck(ip));
    if (data?.[ip]?.risk !== undefined) return saveAndReturn(data[ip].risk, "ProxyCheck");
    console.log("ProxyCheck 失败: " + (data ? JSON.stringify(data).slice(0, 100) : "请求失败"));
    return null;
  }

  async function tryIPPure() {
    const info = await getIPPureInfo();
    if (info?.fraudScore !== undefined) return saveAndReturn(info.fraudScore, "IPPure");
    console.log("IPPure /v1/info 无 fraudScore，回落到 /v1/card");
    const html = await getIPPureCard();
    if (html) {
      const m = html.match(/(\d+)\s*%\s*(极度纯净|纯净|一般|微风险|一般风险|极度风险)/);
      if (m) return saveAndReturn(Number(m[1]), "IPPure");
    }
    console.log("IPPure 风险评分获取失败");
    return null;
  }

  async function tryScamalytics() {
    const html = await httpRaw(CONFIG.urls.scamalytics(ip));
    const score = parseScamalyticsScore(html);
    if (score !== null) return saveAndReturn(score, "Scamalytics");
    console.log("Scamalytics 失败: " + (html ? "解析失败" : "请求失败"));
    return null;
  }

  const tryMap = { ipqs: tryIPQS, proxycheck: tryProxyCheck, ippure: tryIPPure, scamalytics: tryScamalytics };

  // 指定数据源 → 优先使用
  if (tryMap[api]) {
    const r = await tryMap[api]();
    if (r) return r;
  }

  // 回落：指定了 risk_api → 只回落非 IPQS 的剩余源（避免 IPQS key 抢结果）
  //       未指定 → 完整四级含 IPQS
  const fallback = api
    ? ["proxycheck", "ippure", "scamalytics"].filter(k => k !== api)
    : ["ipqs", "proxycheck", "ippure", "scamalytics"];
  for (const key of fallback) {
    const r = await tryMap[key]();
    if (r) return r;
  }

  return saveAndReturn(50, "Default");
}

// ==================== IP 类型检测（二级回落） ====================
async function getIPType() {
  const info = await getIPPureInfo();
  if (info && info.isResidential !== undefined) {
    console.log("IPPure /v1/info 返回 IP 类型数据");
    return {
      ipType: info.isResidential ? "住宅 IP" : "机房 IP",
      ipSrc: info.isBroadcast ? "广播 IP" : "原生 IP"
    };
  }
  console.log("IPPure /v1/info 未返回 IP 类型，回落到 /v1/card");

  const html = await getIPPureCard();
  if (html) {
    const ipType = /住宅|[Rr]esidential/.test(html) ? "住宅 IP" : "机房 IP";
    const ipSrc = /广播|[Bb]roadcast|[Aa]nnounced/.test(html) ? "广播 IP" : "原生 IP";
    console.log("IPPure /v1/card 抓取结果: " + ipType + " | " + ipSrc);
    return { ipType, ipSrc };
  }

  console.log("IPPure 所有接口均失败");
  return { ipType: "未知", ipSrc: "未知" };
}

// ==================== DNS 泄露检测 ====================
async function checkDNSLeak() {
  const data = await httpJSON(CONFIG.urls.dnsLeak());
  if (!data || !data.dns) {
    console.log("DNS 泄露检测失败");
    return { leaked: null, resolver: null, geo: null };
  }

  const geo = data.dns.geo || "";
  const resolver = data.dns.ip || "";
  const chinaISP = geo.match(/(China Telecom|China Unicom|China Mobile|CMCC|ChinaNet|中国电信|中国联通|中国移动)/i);
  const leaked = !!chinaISP;

  console.log("DNS 解析器: " + resolver + " (" + geo + ") 泄露: " + leaked);
  return { leaked, resolver, geo };
}

// ==================== 流量统计 ====================
function formatBytes(bytes) {
  if (!bytes || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0) + " " + units[i];
}

function formatDuration(seconds) {
  if (!seconds || seconds < 0) return "0s";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return h + "h " + m + "m";
  if (m > 0) return m + "m " + s + "s";
  return s + "s";
}

async function getTrafficStats() {
  const data = await surgeAPI("GET", "/v1/traffic");
  if (!data) {
    console.log("流量统计获取失败");
    return null;
  }
  console.log("流量统计原始数据: " + JSON.stringify(data).slice(0, 200));

  const iface = data.interface || data.connector || data;
  const upload = iface.out ?? iface.outboundTraffic ?? 0;
  const download = iface.in ?? iface.inboundTraffic ?? 0;
  const rawStart = data.startTime;
  const startMs = rawStart
    ? (typeof rawStart === "number" && rawStart < 1e12 ? rawStart * 1000 : new Date(rawStart).getTime())
    : null;
  const duration = startMs ? Math.floor((Date.now() - startMs) / 1000) : null;

  return { upload, download, duration };
}

// ==================== IP 获取 ====================
async function fetchIPs() {
  const [local, exit, exit6] = await Promise.all([
    httpJSON(CONFIG.urls.localIP, "DIRECT"),
    httpJSON(CONFIG.urls.outboundIP),
    Promise.race([
      httpJSON(CONFIG.urls.outboundIPv6),
      wait(CONFIG.ipv6Timeout).then(() => null)
    ])
  ]);

  const v6ip = exit6?.ip;
  const hasIPv6 = v6ip && v6ip.includes(":");

  return {
    localIP: local?.data?.addr || null,
    outIP: exit?.ip || null,
    outIPv6: hasIPv6 ? v6ip : null,
    localRaw: local,
    outRaw: exit
  };
}

// ==================== 网络变化检测 ====================
function checkIPChange(localIP, outIP, outIPv6) {
  if (!args.isEvent) return true;

  const lastEvent = $persistentStore.read(CONFIG.storeKeys.lastEvent);
  let lastData = {};
  if (lastEvent) {
    try { lastData = JSON.parse(lastEvent); } catch (e) {}
  }

  if (localIP === lastData.localIP && outIP === lastData.outIP && outIPv6 === lastData.outIPv6) {
    console.log("网络信息未变化，跳过");
    return false;
  }

  console.log("网络信息已变化");
  $persistentStore.write(JSON.stringify({ localIP, outIP, outIPv6 }), CONFIG.storeKeys.lastEvent);
  return true;
}

// ==================== 面板内容构建 ====================
function geoLabel(info) {
  // ip-api.com(zh): country_name="香港"(非 ASCII) → 显示中文国名
  // ip-api.com(en): country_name="Hong Kong" / ipinfo.io: country_name="HK" → 显示 country_code
  return (info?.country_name && /[^\x00-\x7F]/.test(info.country_name)) ? info.country_name : info?.country_code;
}

function buildOutboundSection(outIP, outIPv6, outInfo, isMask, reverseDNS) {
  const lines = [];
  const m = (ip) => isMask ? maskIP(ip) : ip;

  if (outIPv6) {
    lines.push("出口 IP⁴：" + m(outIP));
    lines.push("出口 IP⁶：" + m(outIPv6));
  } else {
    lines.push("出口 IP：" + m(outIP));
  }
  lines.push("地区：" + formatGeo(outInfo?.country_code, outInfo?.city, outInfo?.region, geoLabel(outInfo)));
  lines.push("运营商：" + (outInfo?.org || "Unknown"));
  if (reverseDNS) lines.push("rDNS：" + reverseDNS);

  return lines;
}

function buildPanelContent({ useBilibili, isMask, riskInfo, riskResult, ipType, ipSrc, localIP, localInfo, entranceIP, entranceInfo, outIP, outIPv6, outInfo, dnsLeak, reverseDNS, traffic }) {
  const m = (ip) => isMask ? maskIP(ip) : ip;
  const lines = [
    "IP 风控值：" + riskInfo.score + "% " + riskResult.label + " (" + riskInfo.source + ")",
  ];

  // DNS 泄露检测
  if (dnsLeak) {
    if (dnsLeak.leaked === null) {
      lines.push("DNS 检测：检测失败");
    } else if (dnsLeak.leaked) {
      lines.push("DNS 检测：泄露! " + dnsLeak.geo);
    } else {
      const dnsName = dnsLeak.geo.includes(" - ") ? dnsLeak.geo.split(" - ").pop().trim() : dnsLeak.geo;
      lines.push("DNS 检测：无泄露 (" + dnsName + ")");
    }
  }

  lines.push(
    "",
    "IP 类型：" + ipType + " | " + ipSrc,
    "",
    "本地 IP：" + m(localIP),
    "地区：" + formatGeo(localInfo?.country_code, localInfo?.city, localInfo?.region, useBilibili ? localInfo?.country_name : localInfo?.country_code),
    "运营商：" + (localInfo?.org || "Unknown"),
  );

  if (entranceInfo) {
    lines.push(
      "",
      "入口 IP：" + m(entranceIP),
      "地区：" + formatGeo(entranceInfo?.country_code, entranceInfo?.city, entranceInfo?.region, geoLabel(entranceInfo)),
      "运营商：" + (entranceInfo?.org || "Unknown")
    );
  }

  lines.push("", ...buildOutboundSection(outIP, outIPv6, outInfo, isMask, reverseDNS));

  // 流量统计
  if (traffic) {
    lines.push(
      "",
      "流量统计：↑ " + formatBytes(traffic.upload) + "  ↓ " + formatBytes(traffic.download)
        + (traffic.duration ? " | ⏱ " + formatDuration(traffic.duration) : "")
    );
  }

  return lines.join("\n");
}

// ==================== 通知内容构建 ====================
function sendNetworkChangeNotification({ useBilibili, policy, localIP, outIP, entranceIP, localInfo, entranceInfo, outInfo, riskInfo, riskResult, ipType, ipSrc, isMask, dnsLeak }) {
  const m = (ip) => isMask ? maskIP(ip) : ip;
  const title = "🔄 网络已切换 | " + policy;
  const subtitle = "Ⓓ " + m(localIP) + " 🅟 " + m(outIP);
  const bodyLines = [
    "Ⓓ " + formatGeo(localInfo?.country_code, localInfo?.city, useBilibili ? localInfo?.country_name : localInfo?.country_code) + " · " + (localInfo?.org || "Unknown"),
  ];
  if (entranceInfo) {
    bodyLines.push("Ⓔ " + m(entranceIP) + " " + formatGeo(entranceInfo?.country_code, entranceInfo?.city, geoLabel(entranceInfo)) + " · " + (entranceInfo?.org || "Unknown"));
  }
  bodyLines.push(
    "🅟 " + formatGeo(outInfo?.country_code, outInfo?.city, geoLabel(outInfo)) + " · " + (outInfo?.org || "Unknown"),
    "🅟 风控：" + riskInfo.score + "% " + riskResult.label + " | 类型：" + ipType + " · " + ipSrc
  );
  if (dnsLeak && dnsLeak.leaked) {
    bodyLines.push("⚠️ DNS 泄露! " + dnsLeak.geo);
  }

  $notification.post(title, subtitle, bodyLines.join("\n"));
  console.log("=== 已发送通知 ===");
}

// ==================== 主执行函数 ====================
(async () => {
  try {
  console.log("=== IP 安全检测开始 ===");

  // 1. EVENT 触发时延迟等待网络稳定
  if (args.isEvent && args.eventDelay > 0) {
    console.log("等待网络稳定 " + args.eventDelay + " 秒");
    await wait(args.eventDelay * 1000);
  }

  // 2. 获取本地/出口 IP
  const { localIP, outIP, outIPv6, localRaw, outRaw } = await fetchIPs();

  if (!localIP || !outIP) {
    console.log("IP 获取失败");
    return done({ title: "IP 获取失败", content: "无法获取本地或出口 IPv4", icon: "leaf", "icon-color": "#9E9E9E" });
  }
  console.log("本地 IP: " + localIP + ", 出口 IP: " + outIP);

  // 3. EVENT 模式下检查 IP 是否变化
  if (!checkIPChange(localIP, outIP, outIPv6)) {
    return done({});
  }

  // 4. 并行获取：代理策略+入口 IP、风险评分、IP 类型、地理信息
  const useBilibili = args.localGeoApi === "bilibili";

  // 入口/出口地理数据源：remote_geoapi=ipinfo → ipinfo.io, ipapi → ip-api.com(en), ipapi-zh → ip-api.com(zh-CN)
  const useIpApi = args.remoteGeoApi.startsWith("ipapi");
  const ipApiLang = args.remoteGeoApi === "ipapi-zh" ? "zh-CN" : "en";
  function geoUrl(ip) {
    return useIpApi ? CONFIG.urls.ipApi(ip, ipApiLang) : CONFIG.urls.ipInfo(ip);
  }
  function normalizeGeo(data) {
    return useIpApi ? normalizeIpApi(data) : normalizeIpInfo(data);
  }

  // 先并行发起所有 API 请求，确保 ip.sb/ipinfo/ip-api 请求完成后再查策略
  // 这样 getPolicyAndEntrance 能在 recent 里找到刚完成的请求，避免 Unknown
  const [riskInfo, ipTypeResult, localSbRaw, outGeoRaw, outOrgRaw, dnsLeakResult, trafficResult] = await Promise.all([
    getRiskScore(outIP),                     // 0
    getIPType(),                             // 1
    httpJSON(CONFIG.urls.ipSbGeo(localIP)),  // 2: ip.sb 本地（en 地理 / zh country_code）
    httpJSON(geoUrl(outIP)),                 // 3: 出口地理
    useIpApi ? httpJSON(CONFIG.urls.ipInfo(outIP)) : null,  // 4: 出口运营商（仅 ip-api 模式）+ hostname
    checkDNSLeak(),                          // 5: DNS 泄露检测
    getTrafficStats(),                       // 6: 流量统计
  ]);

  // API 请求已完成，此时 recent 里一定有匹配记录
  const { policy, entranceIP } = await getPolicyAndEntrance();

  // 本地 IP 地理信息：zh 用 bilibili（默认中国），en 用 ip.sb
  let localInfo;
  if (useBilibili) {
    const bili = normalizeBilibili(localRaw);
    const sb = normalizeIpSb(localSbRaw);
    localInfo = bili
      ? { ...bili, country_code: sb?.country_code || "CN" }
      : sb;
  } else {
    localInfo = normalizeIpSb(localSbRaw);
  }

  // 出口 IP 地理信息：remote_geoapi 决定地区来源，运营商始终用 ipinfo.io（回落 ip.sb）
  // IPv6 只显示 IP 地址，不单独查询地区和运营商
  let outInfo = normalizeGeo(outGeoRaw) || normalizeIpSb(outRaw);
  // 反向 DNS：从 ipinfo.io 响应中提取 hostname
  // ipinfo 模式: outGeoRaw 来自 ipinfo.io; ipapi 模式: outOrgRaw 来自 ipinfo.io
  const ipinfoRaw = useIpApi ? outOrgRaw : outGeoRaw;
  const reverseDNS = ipinfoRaw?.hostname || null;
  if (reverseDNS) console.log("反向 DNS: " + reverseDNS);
  if (useIpApi && outInfo) {
    const orgData = normalizeIpInfo(outOrgRaw);
    if (orgData?.org) outInfo.org = orgData.org;
  }

  // 入口 IP 地理信息：与出口不同时才查询
  let entranceInfo = null;
  if (entranceIP && entranceIP !== outIP) {
    console.log("入口 IP: " + entranceIP + " 与出口 IP 不同，查询入口地理信息");
    const entrQueries = [httpJSON(geoUrl(entranceIP))];
    if (useIpApi) entrQueries.push(httpJSON(CONFIG.urls.ipInfo(entranceIP)));
    const [entrGeoRaw, entrOrgRaw] = await Promise.all(entrQueries);
    entranceInfo = normalizeGeo(entrGeoRaw);
    if (useIpApi && entranceInfo && entrOrgRaw) {
      const orgData = normalizeIpInfo(entrOrgRaw);
      if (orgData?.org) entranceInfo.org = orgData.org;
    }
  }

  const riskResult = riskText(riskInfo.score);
  const { ipType, ipSrc } = ipTypeResult;

  // 5. IP 打码切换：手动点击切换，自动刷新和 EVENT 保持当前状态
  const maskStored = $persistentStore.read(CONFIG.storeKeys.maskToggle);
  let isMask = maskStored !== null ? maskStored === "1" : args.maskIP;
  if (!args.isEvent) {
    const now = Math.floor(Date.now() / 1000);
    const lastRun = parseInt($persistentStore.read(CONFIG.storeKeys.lastRun), 10) || 0;
    $persistentStore.write(String(now), CONFIG.storeKeys.lastRun);
    const elapsed = now - lastRun;
    const interval = 600; // 需与 sgmodule update-interval 一致
    const tolerance = 15;
    const remainder = elapsed % interval;
    const isAutoRefresh = lastRun > 0 && elapsed > tolerance
      && (remainder <= tolerance || remainder >= interval - tolerance);
    if (!isAutoRefresh) {
      isMask = !isMask;
      $persistentStore.write(isMask ? "1" : "0", CONFIG.storeKeys.maskToggle);
    }
  }
  const dnsLeak = dnsLeakResult;
  const traffic = trafficResult;
  const context = { useBilibili, isMask, policy, riskInfo, riskResult, ipType, ipSrc, localIP, localInfo, entranceIP, entranceInfo, outIP, outIPv6, outInfo, dnsLeak, reverseDNS, traffic };

  if (args.isEvent) {
    sendNetworkChangeNotification(context);
    done({});
  } else {
    console.log("=== 面板显示 ===");
    done({
      title: "代理策略：" + policy,
      content: buildPanelContent(context),
      icon: "leaf.fill",
      "icon-color": riskResult.color
    });
  }
  } catch (e) {
    console.log("未捕获异常: " + (e.message || e));
    done({ title: "检测异常", content: e.message || String(e), icon: "leaf", "icon-color": "#9E9E9E" });
  }
})();
