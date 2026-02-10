/**
 * Surge IP Security Check Script
 *
 * 功能概述：
 * - 检测并显示入口/出口 IP 信息
 * - 评估 IP 风险等级和类型
 * - 显示地理位置和运营商信息
 * - 支持网络变化自动检测和通知
 *
 * 数据来源：
 * ① 入口 IP: bilibili API (DIRECT)
 * ② 出口 IP: ip.sb API (IPv4/IPv6)
 * ③ 代理策略: Surge /v1/requests/recent
 * ④ 风险评分: IPQualityScore (主，需 API) → ProxyCheck (备) → Scamalytics (兜底)
 * ⑤ IP 类型: IPPure API
 * ⑥ 地理/运营商: lang=en → ipinfo.io + ip.sb | lang=zh → bilibili (中文, ip.sb 兜底)
 *
 * 参数说明：
 * - TYPE: 设为 EVENT 表示网络变化触发（自动判断，无需手动设置）
 * - ipqs_key: IPQualityScore API Key (可选)
 * - lang: 地理信息语言，en(默认)=英文(ipinfo.io)，zh=中文(bilibili)
 * - event_delay: 网络变化后延迟检测（秒），默认 2 秒
 *
 * 配置示例：
 * [Panel]
 * ip-security-panel = script-name=ip-security-panel,update-interval=600
 *
 * [Script]
 * # 手动触发（面板）
 * ip-security-panel = type=generic,timeout=10,script-path=ip-security.js,argument=ipqs_key=YOUR_API_KEY
 *
 * # 网络变化自动触发
 * ip-security-event = type=event,event-name=network-changed,timeout=10,script-path=ip-security.js,argument=TYPE=EVENT&ipqs_key=YOUR_API_KEY&event_delay=2
 *
 * @author HotKids&Claude
 * @version 4.0.0
 * @date 2026-02-09
 */

// ==================== 全局配置 ====================
const CONFIG = {
  name: "ip-security",
  timeout: 10000,
  storeKeys: {
    lastEvent: "lastNetworkInfoEvent",
    lastPolicy: "lastProxyPolicy",
    riskCache: "riskScoreCache"
  },
  urls: {
    inboundIP: "https://api.bilibili.com/x/web-interface/zone",
    outboundIP: "https://api-ipv4.ip.sb/geoip",
    outboundIPv6: "https://api-ipv6.ip.sb/geoip",
    ipType: "https://my.ippure.com/v1/info",
    ipTypeCard: "https://my.ippure.com/v1/card",
    inboundInfo: (ip) => `https://api.ip.sb/geoip/${ip}`,
    biliGeo: (ip) => `https://api.live.bilibili.com/ip_service/v1/ip_service/get_ip_addr?ip=${ip}`,
    ipInfo: (ip) => `https://ipinfo.io/${ip}/json`,
    ipqs: (key, ip) => `https://ipqualityscore.com/api/json/ip/${key}/${ip}?strictness=1`,
    proxyCheck: (ip) => `https://proxycheck.io/v2/${ip}?risk=1&vpn=1`,
    scamalytics: (ip) => `https://scamalytics.com/ip/${ip}`
  },
  ipv6Timeout: 3000,
  policyRetryDelay: 500,
  riskLevels: [
    { max: 15, label: "极度纯净 IP", color: "#0D6E3D" },
    { max: 25, label: "纯净 IP",     color: "#2E9F5E" },
    { max: 40, label: "一般 IP",     color: "#8BC34A" },
    { max: 50, label: "微风险 IP",   color: "#FFC107" },
    { max: 70, label: "一般风险 IP", color: "#FF9800" },
    { max: 100, label: "极度风险 IP", color: "#F44336" }
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
    try { arg = { ...arg, ...JSON.parse(storedArg) }; } catch (e) {}
  }

  const isPanel = typeof $input !== "undefined" && $input.purpose === "panel";
  const isRequest = typeof $request !== "undefined";
  if (!isPanel && !isRequest) {
    arg.TYPE = "EVENT";
  }

  return {
    isEvent: arg.TYPE === "EVENT",
    ipqsKey: (arg.ipqs_key && arg.ipqs_key !== "null") ? arg.ipqs_key : "",
    lang: (arg.lang && arg.lang !== "null") ? arg.lang : "en",
    eventDelay: parseFloat(arg.event_delay) || 2
  };
}

const args = parseArguments();
console.log("触发类型: " + (args.isEvent ? "EVENT" : "MANUAL") + ", 语言: " + args.lang);

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

// ==================== 数据处理工具 ====================
/**
 * 将国家代码转换为国旗 emoji
 */
function flag(cc) {
  if (!cc || cc.length !== 2) return "";
  if (cc.toUpperCase() === "TW") cc = "CN";
  const b = 0x1f1e6;
  return String.fromCodePoint(b + cc.charCodeAt(0) - 65, b + cc.charCodeAt(1) - 65);
}

/**
 * 根据风险分数返回对应的描述和颜色
 */
function riskText(score) {
  const level = CONFIG.riskLevels.find(l => score <= l.max) || CONFIG.riskLevels.at(-1);
  return { label: level.label, color: level.color };
}

/**
 * 格式化地理位置文本：🇺🇸 + 自定义部分
 * 面板用法：formatGeo(country_code, city, region, country_code) → 🇺🇸 City, Region, US
 * 通知用法：formatGeo(country_code, city, country_name) → 🇺🇸 City, United States
 */
function formatGeo(countryCode, ...parts) {
  return flag(countryCode) + " " + parts.filter(Boolean).join(", ");
}

/**
 * 将 ip.sb 返回字段归一化为内部格式
 */
function normalizeIpSb(data) {
  if (!data) return null;
  return {
    country_code: data.country_code,
    country_name: data.country,
    city: data.city,
    region: data.region,
    org: data.organization
  };
}

/**
 * 将 ipinfo.io 返回字段归一化为内部格式
 * ipinfo.io: { country:"US", city, region, org:"AS15169 Google LLC" }
 */
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
 * 将 bilibili zone API 返回字段归一化为内部格式（中文）
 * bilibili: { code:0, data:{ addr, country:"中国", province:"香港", city:"", isp:"数据中心" } }
 * 注意：bilibili 不返回 ISO country_code，需从 ip.sb 补充
 */
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

/**
 * 从 Scamalytics HTML 中解析风险分数
 */
function parseScamalyticsScore(html) {
  const m = html?.match(/Fraud Score[^0-9]*([0-9]{1,3})/i);
  return m ? Number(m[1]) : null;
}

// ==================== 代理策略获取 ====================
/**
 * 从 Surge 最近请求中查找匹配的代理策略
 */
async function findPolicyInRecent(pattern, limit) {
  const res = await surgeAPI("GET", "/v1/requests/recent");
  const hit = res?.requests?.slice(0, limit).find(i => pattern.test(i.URL));
  return hit?.policyName || null;
}

/**
 * 获取实际使用的代理策略（带重试和回落）
 */
async function getPolicy() {
  // 第一次查找
  let policy = await findPolicyInRecent(/(api(-ipv4)?\.ip\.sb|ipinfo\.io)/i, 10);
  if (policy) {
    console.log("找到代理策略: " + policy);
    $persistentStore.write(policy, CONFIG.storeKeys.lastPolicy);
    return policy;
  }

  // fetchIPs 阶段已发送过 outboundIP 请求，等待后直接重试
  console.log("未找到策略记录，等待后重试");
  await wait(CONFIG.policyRetryDelay);

  policy = await findPolicyInRecent(/(api(-ipv4)?\.ip\.sb|ipinfo\.io)/i, 5);
  if (policy) {
    console.log("重试后找到策略: " + policy);
    $persistentStore.write(policy, CONFIG.storeKeys.lastPolicy);
    return policy;
  }

  // 回落到上次保存的策略
  const lastPolicy = $persistentStore.read(CONFIG.storeKeys.lastPolicy);
  if (lastPolicy) {
    console.log("使用上次保存的策略: " + lastPolicy);
    return lastPolicy;
  }

  console.log("无法找到任何策略信息");
  return "Unknown";
}

// ==================== 风险评分获取（三级回落） ====================
/**
 * 获取 IP 风险分数
 * 优先级：IPQualityScore → ProxyCheck → Scamalytics
 */
async function getRiskScore(ip) {
  // 0. 检查缓存：IP 未变则直接返回
  const cached = $persistentStore.read(CONFIG.storeKeys.riskCache);
  if (cached) {
    try {
      const c = JSON.parse(cached);
      if (c.ip === ip) {
        console.log("风险评分命中缓存: " + c.score + "% (" + c.source + ")");
        return { score: c.score, source: c.source };
      }
    } catch (e) {}
  }

  function saveAndReturn(score, source) {
    $persistentStore.write(JSON.stringify({ ip, score, source }), CONFIG.storeKeys.riskCache);
    console.log("风险评分已缓存: " + score + "% (" + source + ")");
    return { score, source };
  }

  // 1. IPQualityScore（需要 API Key）
  if (args.ipqsKey) {
    const data = await httpJSON(CONFIG.urls.ipqs(args.ipqsKey, ip));
    if (data?.success && data?.fraud_score !== undefined) {
      return saveAndReturn(data.fraud_score, "IPQS");
    }
    console.log("IPQS 回落: " + (data ? "success=" + data.success + " message=" + (data.message || "") : "请求失败"));
  }

  // 2&3. ProxyCheck + Scamalytics 并行请求
  const [proxyData, scamHtml] = await Promise.all([
    httpJSON(CONFIG.urls.proxyCheck(ip)),
    httpRaw(CONFIG.urls.scamalytics(ip))
  ]);

  if (proxyData?.[ip]?.risk !== undefined) {
    return saveAndReturn(proxyData[ip].risk, "ProxyCheck");
  }
  console.log("ProxyCheck 失败: " + (proxyData ? JSON.stringify(proxyData).slice(0, 100) : "请求失败"));

  const score = parseScamalyticsScore(scamHtml);
  if (score !== null) {
    return saveAndReturn(score, "Scamalytics");
  }
  console.log("Scamalytics 失败: " + (scamHtml ? "解析失败" : "请求失败"));

  return saveAndReturn(50, "Default");
}

// ==================== IP 类型检测（二级回落） ====================
/**
 * 获取 IP 类型（住宅/机房、广播/原生）
 * 优先级：/v1/info JSON → /v1/card HTML 抓取
 */
async function getIPType() {
  // 1. 尝试 /v1/info JSON 接口
  const info = await httpJSON(CONFIG.urls.ipType);
  if (info && info.isResidential !== undefined) {
    console.log("IPPure /v1/info 返回 IP 类型数据");
    return {
      ipType: info.isResidential ? "住宅 IP" : "机房 IP",
      ipSrc: info.isBroadcast ? "广播 IP" : "原生 IP"
    };
  }
  console.log("IPPure /v1/info 未返回 IP 类型，回落到 /v1/card");

  // 2. 回落到 /v1/card HTML 抓取
  const html = await httpRaw(CONFIG.urls.ipTypeCard);
  if (html) {
    const ipType = /住宅|[Rr]esidential/.test(html) ? "住宅 IP" : "机房 IP";
    const ipSrc = /广播|[Bb]roadcast|[Aa]nnounced/.test(html) ? "广播 IP" : "原生 IP";
    console.log("IPPure /v1/card 抓取结果: " + ipType + " | " + ipSrc);
    return { ipType, ipSrc };
  }

  console.log("IPPure 所有接口均失败");
  return { ipType: "未知", ipSrc: "未知" };
}

// ==================== IP 获取 ====================
/**
 * 获取入口/出口 IP 地址
 */
async function fetchIPs() {
  const [enter, exit, exit6] = await Promise.all([
    httpJSON(CONFIG.urls.inboundIP, "DIRECT"),
    httpJSON(CONFIG.urls.outboundIP),
    Promise.race([
      httpJSON(CONFIG.urls.outboundIPv6),
      wait(CONFIG.ipv6Timeout).then(() => null)
    ])
  ]);

  const v6ip = exit6?.ip;
  // 仅当返回的 IP 确实是 IPv6 格式（含 :）时才视为有效 IPv6
  // api-ipv6.ip.sb 无 IPv6 连接时可能通过 IPv4 返回相同的 IPv4 地址
  const hasIPv6 = v6ip && v6ip.includes(":");

  return {
    inIP: enter?.data?.addr || null,
    outIP: exit?.ip || null,
    outIPv6: hasIPv6 ? v6ip : null,
    inRaw: enter,
    outRaw: exit,
    v6Raw: hasIPv6 ? exit6 : null
  };
}

// ==================== 网络变化检测 ====================
/**
 * 检查 IP 是否发生变化（EVENT 模式）
 * @returns {boolean} true 表示有变化或非 EVENT 模式，false 表示无变化应跳过
 */
function checkIPChange(inIP, outIP, outIPv6) {
  if (!args.isEvent) return true;

  const lastEvent = $persistentStore.read(CONFIG.storeKeys.lastEvent);
  let lastData = {};
  if (lastEvent) {
    try { lastData = JSON.parse(lastEvent); } catch (e) {}
  }

  if (inIP === lastData.inIP && outIP === lastData.outIP && outIPv6 === lastData.outIP6) {
    console.log("网络信息未变化，跳过");
    return false;
  }

  console.log("网络信息已变化");
  $persistentStore.write(JSON.stringify({ inIP, outIP, outIP6: outIPv6 }), CONFIG.storeKeys.lastEvent);
  return true;
}

// ==================== 面板内容构建 ====================
/**
 * 构建出口 IP 显示内容
 */
function buildOutboundSection(outIP, outIPv6, outInfo, ipv6Info, isZh) {
  const lines = [];
  const ct = (info) => isZh ? info?.country_name : info?.country_code;

  if (!outIPv6) {
    lines.push("出口 IP：" + outIP);
    lines.push("地区：" + formatGeo(outInfo?.country_code, outInfo?.city, outInfo?.region, ct(outInfo)));
    lines.push("运营商：" + (outInfo?.org || "Unknown"));
    return lines;
  }

  const sameLocation = outInfo?.country_code === ipv6Info?.country_code
    && outInfo?.org === ipv6Info?.org;

  if (sameLocation) {
    lines.push("出口 IP⁴：" + outIP);
    lines.push("出口 IP⁶：" + outIPv6);
    lines.push("地区：" + formatGeo(outInfo?.country_code, outInfo?.city, outInfo?.region, ct(outInfo)));
    lines.push("运营商：" + (outInfo?.org || "Unknown"));
  } else {
    lines.push("出口 IP⁴：" + outIP);
    lines.push("地区⁴：" + formatGeo(outInfo?.country_code, outInfo?.city, outInfo?.region, ct(outInfo)));
    lines.push("运营商⁴：" + (outInfo?.org || "Unknown"));
    lines.push("");
    lines.push("出口 IP⁶：" + outIPv6);
    lines.push("地区⁶：" + formatGeo(ipv6Info?.country_code, ipv6Info?.city, ipv6Info?.region, ct(ipv6Info)));
    lines.push("运营商⁶：" + (ipv6Info?.org || "Unknown"));
  }

  return lines;
}

/**
 * 构建完整面板内容
 */
function buildPanelContent({ isZh, riskInfo, riskResult, ipType, ipSrc, inIP, inInfo, outIP, outIPv6, outInfo, ipv6Info }) {
  const ct = (info) => isZh ? info?.country_name : info?.country_code;
  const lines = [
    "IP 风控值：" + riskInfo.score + "% " + riskResult.label + " (" + riskInfo.source + ")",
    "",
    "IP 类型：" + ipType + " | " + ipSrc,
    "",
    "入口 IP：" + inIP,
    "地区：" + formatGeo(inInfo?.country_code, inInfo?.city, inInfo?.region, ct(inInfo)),
    "运营商：" + (inInfo?.org || "Unknown"),
    "",
    ...buildOutboundSection(outIP, outIPv6, outInfo, ipv6Info, isZh)
  ];

  return lines.join("\n");
}

// ==================== 通知内容构建 ====================
/**
 * 构建网络变化通知并发送
 */
function sendNetworkChangeNotification({ policy, inIP, outIP, inInfo, outInfo, riskInfo, riskResult, ipType, ipSrc }) {
  const title = "🔄 网络已切换 | " + policy;
  const subtitle = "Ⓓ " + inIP + " 🅟 " + outIP;
  const body = [
    "Ⓓ " + formatGeo(inInfo?.country_code, inInfo?.city, inInfo?.country_name) + " · " + (inInfo?.org || "Unknown"),
    "🅟 " + formatGeo(outInfo?.country_code, outInfo?.city, outInfo?.country_name) + " · " + (outInfo?.org || "Unknown"),
    "🅟 风控：" + riskInfo.score + "% " + riskResult.label + " | 类型：" + ipType + " · " + ipSrc
  ].join("\n");

  $notification.post(title, subtitle, body);
  console.log("=== 已发送通知 ===");
}

// ==================== 主执行函数 ====================
(async () => {
  console.log("=== IP 安全检测开始 ===");

  // 1. EVENT 触发时延迟等待网络稳定
  if (args.isEvent && args.eventDelay > 0) {
    console.log("等待网络稳定 " + args.eventDelay + " 秒");
    await wait(args.eventDelay * 1000);
  }

  // 2. 获取入口/出口 IP
  const { inIP, outIP, outIPv6, inRaw, outRaw, v6Raw } = await fetchIPs();

  if (!inIP || !outIP) {
    console.log("IP 获取失败");
    return done({ title: "IP 获取失败", content: "无法获取入口或出口 IPv4", icon: "leaf", "icon-color": "#9E9E9E" });
  }
  console.log("入口 IP: " + inIP + ", 出口 IP: " + outIP);

  // 3. EVENT 模式下检查 IP 是否变化
  if (!checkIPChange(inIP, outIP, outIPv6)) {
    return done({});
  }

  // 4. 并行获取：代理策略、风险评分、IP 类型、地理/运营商信息
  const isZh = args.lang === "zh";

  // 两种模式都查 ipinfo.io（出口），zh 额外查 bilibili（中文地名）
  const queries = [
    getPolicy(),                             // 0
    getRiskScore(outIP),                     // 1
    getIPType(),                             // 2
    httpJSON(CONFIG.urls.inboundInfo(inIP)),  // 3: ip.sb 入口
    httpJSON(CONFIG.urls.ipInfo(outIP))       // 4: ipinfo 出口（两种模式都用）
  ];
  if (isZh) queries.push(httpJSON(CONFIG.urls.biliGeo(outIP)));  // 5: bilibili 出口（zh）
  const v6Idx = queries.length;
  if (outIPv6) {
    queries.push(httpJSON(CONFIG.urls.ipInfo(outIPv6)));           // v6Idx: ipinfo IPv6
    if (isZh) queries.push(httpJSON(CONFIG.urls.biliGeo(outIPv6))); // v6Idx+1: bilibili IPv6（zh）
  }

  const results = await Promise.all(queries);
  const [policy, riskInfo, ipTypeResult, inSbRaw, outIpInfoRaw] = results;

  let inInfo, outInfo, ipv6Info;
  if (isZh) {
    const outBiliRaw = results[5];
    const v6IpInfoRaw = outIPv6 ? results[v6Idx] : null;
    const v6BiliRaw = outIPv6 ? results[v6Idx + 1] : null;

    // 入口：地区用 bilibili，运营商仅中国用 bilibili，非中国用 ip.sb
    const inBili = normalizeBilibili(inRaw);
    const inSb = normalizeIpSb(inSbRaw);
    if (inBili) {
      const isChina = inBili.country_name === "中国";
      inInfo = { ...inBili, country_code: inSb?.country_code || "", org: isChina ? inBili.org : (inSb?.org || "") };
    } else {
      inInfo = inSb;
    }

    // 出口：地区用 bilibili，运营商仅中国用 bilibili，非中国用 ipinfo.io（回落 ip.sb）
    const outBili = normalizeBilibili(outBiliRaw);
    const outIpInfo = normalizeIpInfo(outIpInfoRaw);
    const outSb = normalizeIpSb(outRaw);
    if (outBili) {
      const isOutChina = outBili.country_name === "中国";
      outInfo = { ...outBili, country_code: outIpInfo?.country_code || outSb?.country_code || "", org: isOutChina ? outBili.org : (outIpInfo?.org || outSb?.org || "") };
    } else {
      outInfo = outIpInfo || outSb;
    }

    // IPv6：同上逻辑
    const v6Bili = normalizeBilibili(v6BiliRaw);
    const v6IpInfo = normalizeIpInfo(v6IpInfoRaw);
    const v6Sb = outIPv6 ? normalizeIpSb(v6Raw) : null;
    if (outIPv6) {
      if (v6Bili) {
        const isV6China = v6Bili.country_name === "中国";
        ipv6Info = { ...v6Bili, country_code: v6IpInfo?.country_code || v6Sb?.country_code || "", org: isV6China ? v6Bili.org : (v6IpInfo?.org || v6Sb?.org || "") };
      } else {
        ipv6Info = v6IpInfo || v6Sb;
      }
    } else {
      ipv6Info = null;
    }
  } else {
    // 英文模式：入口用 ip.sb，出口用 ipinfo.io（回落 ip.sb）
    const v6IpInfoRaw = outIPv6 ? results[v6Idx] : null;
    inInfo = normalizeIpSb(inSbRaw);
    outInfo = normalizeIpInfo(outIpInfoRaw) || normalizeIpSb(outRaw);
    ipv6Info = outIPv6 ? (normalizeIpInfo(v6IpInfoRaw) || normalizeIpSb(v6Raw)) : null;
  }

  const riskResult = riskText(riskInfo.score);
  const { ipType, ipSrc } = ipTypeResult;

  // 5. 根据触发类型输出结果
  const context = { isZh, policy, riskInfo, riskResult, ipType, ipSrc, inIP, outIP, outIPv6, inInfo, outInfo, ipv6Info };

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
})();
