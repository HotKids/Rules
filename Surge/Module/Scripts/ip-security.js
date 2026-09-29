/**
 * Surge / Stash IP Security Check Script
 *
 * 功能概述：
 * - 检测并显示本地/入口/出口 IP 信息
 * - 评估 IP 风险等级和类型
 * - 显示地理位置和运营商信息
 * - 支持网络变化自动检测和通知
 *
 * 数据来源：
 * ① 本地 IP: bilibili API (DIRECT)
 * ② 出口 IP: Cloudflare cdn-cgi/trace（官方端点，IP 直连不受 DNS 污染影响；失败回落 ip.sb）(IPv4/IPv6)
 * ③ 入口 IP: Surge /v1/requests/recent → remoteAddress(Proxy)
 * ④ 代理策略: Surge /v1/requests/recent
 * ⑤ 风险评分: IPQualityScore (可选，需 API Key) → ProxyCheck → IPPure → Scamalytics (兜底)
 *    出口 IP 24 小时内未变化则复用缓存评分，避免面板自动刷新反复消耗按次计费额度
 * ⑥ IP 类型: IPPure API → ProxyCheck type 字段回退（复用风险评分的请求；与风险评分同样按出口 IP 24 小时缓存）
 * ⑦ 地理: 本地默认百度（可选 bilibili / ip.sb）；入口/出口默认 ip-api.com 中文（可选 ipinfo / ip-api.com 英文 / MaxMind）
 * ⑧ 运营商: 入口/出口 IP 始终使用 ipinfo.io
 * ⑨ DNS 泄露: edns.ip-api.com（通过代理探测 DNS 解析器，检测是否泄露到本地 ISP）
 * ⑩ 反向 DNS: ipinfo.io hostname 字段
 * ⑪ 流量统计: Surge /v1/traffic API
 *
 * 参数说明：
 * - TYPE: 设为 EVENT 表示网络变化触发（自动判断，无需手动设置）
 * - ipqs_key: IPQualityScore API Key（可选，仅 risk_api=ipqs 或回落模式需要）
 * - risk_api: 风险评分数据源，ipqs / proxycheck / ippure / scamalytics（可选，不填则四级回落）
 * - local_geoapi: 本地 IP 地理数据源，baidu(默认)=百度 opendata(中文，省市区粒度)，bilibili=bilibili(中文)，ipsb=ip.sb(英文)
 * - remote_geoapi: 入口/出口地理数据源，ipapi-zh(默认)=ip-api.com(中文, http 明文)，ipinfo=ipinfo.io，ipapi=ip-api.com(英文)，maxmind=GeoLite2(英文)，maxmind-zh=GeoLite2(中文优先)
 * - maxmind_key: MaxMind GeoLite 凭据，格式 account_id:license_key（仅 remote_geoapi=maxmind/maxmind-zh 需要，免费注册 1000 次/天）
 * - mask_ip: IP 打码，0=关闭，1=部分打码，2=全部隐藏 [IP 已隐藏]，默认 0
 * - tw_flag: 台湾地区旗帜，cn(默认)=🇨🇳，tw=🇹🇼
 * - event_delay: 网络变化后延迟检测（秒），默认 2 秒
 * - notify: 网络变化时是否推送通知，true(默认)=推送，false=不推送；Stash 首页刷新时比较 IP，首次仅记录
 * - panel_interval: 面板 update-interval（秒），默认 600；改了 [Panel] 的 update-interval 需同步此参数，
 *   否则打码点击切换的自动刷新判定会失准
 *
 * 配置示例：
 * [Panel]
 * ip-security-panel = script-name=ip-security-panel,update-interval=600
 *
 * [Script]
 * # 手动触发（面板）- ipqs_key 可选，不填自动回落
 * ip-security-panel = type=generic,timeout=15,script-path=ip-security.js,argument=ipqs_key=YOUR_API_KEY&panel_interval=600
 *
 * # 网络变化自动触发
 * ip-security-event = type=event,event-name=network-changed,timeout=15,script-path=ip-security.js,argument=TYPE=EVENT&ipqs_key=YOUR_API_KEY&event_delay=2&notify=true
 *
 * @author HotKids&Claude
 * Stash：ip-security-panel.stoverride 默认首页显示，600 秒刷新；与 Surge 共用此文件。
 * - 四张 Tile：risk 风险、dns 解析器、outbound 出口、local 本地，各自只执行需要的请求。
 * - 默认：风险仅 IPPure、本地百度、出口 ipapi-zh、mask_ip=0、tw_flag=tw、notify=true。
 * - 覆写 argument 内的 tile 用于选择卡片；其余选项已预设，不需要导入参数界面。
 * - proxy: 可手动指定 URL 编码的节点/策略组名；留空遵循当前分流。
 * - mode: home(默认) / collapsed；折叠模式不覆盖 Stash 长按节点时指定的出口。
 * - mask_ip: Stash 固定按参数显示，不通过刷新时间猜测点击切换。
 * - Stash 不调用 Surge 专用 API，不显示入口 IP/流量统计，不订阅 network-changed 事件。
 *   首页模式刷新时可通知 IP 变化；折叠模式不通知，避免切换检测节点产生误报。
 * - DNS 仅显示探测到的解析器和地区提示；不能仅凭地区判断是否泄露。
 *
 * @version 6.2.0
 * @date 2026-09-29
 */

// ==================== 全局配置 ====================
const isStash = (typeof $environment !== "undefined" &&
  (!!$environment["stash-version"] || !!$environment["stash-build"])) ||
  (typeof $script !== "undefined" && $script.type === "tile");
const hasTimers = typeof setTimeout === "function";
// 图标：Koolson/Qure https://github.com/Koolson/Qure（Color 彩色图标）
const stashIconRoot = "https://raw.githubusercontent.com/Koolson/Qure/master/IconSet/Color/";
const stashTiles = {
  risk: { title: "IP 风险", icon: stashIconRoot + "Hijacking.png", color: "#2E9F5E" },
  dns: { title: "DNS 解析器", icon: stashIconRoot + "Round_Robin.png", color: "#7357A6" },
  outbound: { title: "出口 IP", icon: stashIconRoot + "Global.png", color: "#3269B7" },
  local: { title: "本地 IP", icon: stashIconRoot + "Domestic.png", color: "#397D78" }
};
const CONFIG = {
  timeout: isStash ? 20000 : 10000, // Surge 看门狗须小于 sgmodule 的 timeout=15；Stash 兼容无 JS 定时器的运行时
  riskCacheTTL: 86400, // 风险评分缓存有效期（秒）：出口 IP 未变化时，此时长内复用缓存，
                       // 避免面板自动刷新（update-interval，默认 600s）反复消耗 IPQS 等按次计费额度
  storeKeys: {
    lastEvent: "lastNetworkInfoEvent",
    lastPolicy: "lastProxyPolicy",
    riskCache: "riskScoreCache",
    ipTypeCache: "ipTypeCache",
    maskToggle: "ipMaskToggle",
    lastRun: "ipLastRunTime"
  },
  urls: {
    localIP: "https://api.bilibili.com/x/web-interface/zone",
    baiduGeo: (ip) => `https://opendata.baidu.com/api.php?query=${ip}&co=&resource_id=6006&oe=utf8`,
    maxmindGeo: (ip) => `https://geolite.info/geoip/v2.1/city/${ip}`,
    // Cloudflare 官方端点，证书含 IP SAN，可直连（不经 DNS）；失败回落 ip.sb
    outboundTrace: "https://1.1.1.1/cdn-cgi/trace",
    outboundTrace6: "https://[2606:4700:4700::1111]/cdn-cgi/trace",
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
    dnsLeakEdns: (id) => `http://${id}.edns.ip-api.com/json`
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
    // 不打印 $argument 原文：其中可能含 ipqs_key 等敏感凭据
    arg = Object.fromEntries($argument.split("&").map(i => {
      const idx = i.indexOf("=");
      return idx === -1 ? [i.trim(), ""] : [i.slice(0, idx).trim(), decodeURIComponent(i.slice(idx + 1)).trim()];
    }));
  }

  const isPanel = typeof $input !== "undefined" && $input.purpose === "panel";
  const isRequest = typeof $request !== "undefined";
  if (!isStash && !isPanel && !isRequest) {
    arg.TYPE = "EVENT";
  }

  function clean(val) {
    if (!val) return "";
    const v = String(val).trim();
    return (v === "" || v.toLowerCase() === "null") ? "" : v;
  }

  console.log("参数解析: risk_api=" + JSON.stringify(arg.risk_api) + " ipqs_key=" + (arg.ipqs_key ? "已设置" : "未设置"));

  // notify 参数：默认 true，仅当明确设为 "false" 时关闭通知
  const notifyVal = clean(arg.notify).toLowerCase();
  const notify = notifyVal !== "false";

  return {
    isEvent: !isStash && arg.TYPE === "EVENT",
    proxy: isStash && clean(arg.mode) !== "collapsed" ? clean(arg.proxy) : "",
    mode: clean(arg.mode) === "collapsed" ? "collapsed" : "home",
    tile: clean(arg.tile) || "outbound",
    ipqsKey: isStash ? "" : clean(arg.ipqs_key),
    riskApi: isStash ? "ippure" : clean(arg.risk_api).toLowerCase(),
    maxmindKey: clean(arg.maxmind_key),
    localGeoApi: isStash ? "baidu" : clean(arg.local_geoapi) || "baidu",
    remoteGeoApi: isStash ? "ipapi-zh" : clean(arg.remote_geoapi) || "ipapi-zh",
    maskIP: arg.mask_ip === "2" ? 2 : (arg.mask_ip === "1" || arg.mask_ip === "true") ? 1 : 0,
    twFlag: clean(arg.tw_flag) || (isStash ? "tw" : "cn"),
    eventDelay: parseFloat(arg.event_delay) || 2,
    notify: notify,
    panelInterval: parseInt(clean(arg.panel_interval), 10) || 600
  };
}

const args = parseArguments();
if (isStash) {
  // 避免与 Surge 或其他策略的通知/显示状态共用键；评分另按出口 IP 验证缓存。
  for (const key of Object.keys(CONFIG.storeKeys)) {
    CONFIG.storeKeys[key] = "stash.ip-security." + args.mode + "." + encodeURIComponent(args.proxy) + "." + CONFIG.storeKeys[key];
  }
}
console.log("触发类型: " + (args.isEvent ? "EVENT" : "MANUAL") + ", risk_api: " + (args.riskApi || "fallback") + ", 本地: " + args.localGeoApi + ", 通知: " + args.notify);

// ==================== 全局状态控制 ====================
let finished = false;
let watchdog = null;
const requestDeadline = Date.now() + CONFIG.timeout - 250;

function done(o) {
  if (finished) return;
  finished = true;
  if (watchdog !== null && typeof clearTimeout === "function") clearTimeout(watchdog);
  if (isStash) {
    $done({
      title: stashTiles[args.tile]?.title || "IP Security",
      content: o.content || "检测失败",
      icon: stashTiles[args.tile]?.icon || stashTiles.outbound.icon,
      backgroundColor: o.backgroundColor || o["icon-color"] || "#9E9E9E"
    });
  } else {
    $done(o);
  }
}

if (hasTimers) {
  watchdog = setTimeout(() => {
    done({ title: "检测超时", content: "API 请求超时", icon: "leaf", "icon-color": "#9E9E9E" });
  }, CONFIG.timeout);
}

// ==================== HTTP 工具 ====================
function httpRaw(url, policy, headers, deadline = requestDeadline) {
  const remaining = Math.min(deadline, requestDeadline) - Date.now();
  if (finished || remaining < 100) return Promise.resolve(null);
  return new Promise(resolve => {
    const req = { url };
    if (headers) req.headers = { ...headers };
    if (isStash) {
      // Stash timeout 单位为秒；Android 无 setTimeout 时仍由 HTTP 层限制请求时间。
      req.timeout = Math.min(5, remaining / 1000);
      const selected = policy || args.proxy;
      if (selected) req.headers = { ...req.headers, "X-Stash-Selected-Proxy": encodeURIComponent(selected) };
    } else if (policy) {
      req.policy = policy;
    }
    try {
      $httpClient.get(req, (error, response, data) => {
        const status = Number(response?.status || response?.statusCode);
        resolve(!error && status >= 200 && status < 300 ? (data || null) : null);
      });
    } catch (_) { resolve(null); }
  });
}

async function httpJSON(url, policy, headers, deadline) {
  const raw = await httpRaw(url, policy, headers, deadline);
  try { return raw ? JSON.parse(raw) : null; } catch (_) { return null; }
}

function wait(ms) {
  return hasTimers ? new Promise(r => setTimeout(r, ms)) : Promise.resolve();
}

function surgeAPI(method, path) {
  if (isStash || typeof $httpAPI !== "function") return Promise.resolve(null);
  return new Promise(r => {
    $httpAPI(method, path, null, res => r(res));
  });
}

// IPPure 请求去重：getIPType 和 tryIPPure 共享同一个请求
let _ippureInfoP = null, _ippureCardP = null;
function getIPPureInfo() { return _ippureInfoP || (_ippureInfoP = httpJSON(CONFIG.urls.ipType)); }
function getIPPureCard() { return _ippureCardP || (_ippureCardP = httpRaw(CONFIG.urls.ipTypeCard)); }

// ProxyCheck 请求去重：风险评分和 IP 类型回退共享同一个请求
let _proxyCheckP = null;
function getProxyCheck(ip) { return _proxyCheckP || (_proxyCheckP = httpJSON(CONFIG.urls.proxyCheck(ip))); }

// ==================== 数据处理工具 ====================
function flag(cc) {
  if (!cc || cc.length !== 2) return "";
  cc = cc.toUpperCase();
  if (cc === "TW" && args.twFlag !== "tw") cc = "CN";
  const b = 0x1f1e6;
  return String.fromCodePoint(b + cc.charCodeAt(0) - 65, b + cc.charCodeAt(1) - 65);
}

function riskText(score) {
  if (score === null || score === undefined || !Number.isFinite(Number(score))) {
    return { label: "检测失败", color: "#9E9E9E" };
  }
  const level = CONFIG.riskLevels.find(l => score <= l.max) || CONFIG.riskLevels.at(-1);
  return { label: level.label, color: level.color };
}

function formatRisk(info) {
  if (info.score === null || info.score === undefined) return "未知（检测失败）";
  return info.score + "% " + riskText(info.score).label + " (" + info.source + ")";
}

function maskIP(ip, mode) {
  if (!ip || !mode) return ip;
  if (mode === 2) return "[IP 已隐藏]";
  if (ip.includes(":")) {
    if (ip.includes("::")) {
      // :: 压缩记法（如 2001:db8::1）：真实分段数不固定，无法按未压缩地址逐段打码，
      // 仅显示首尾各一段，中间（含被压缩的隐藏段）统一用 ** 代替
      const [left = "", right = ""] = ip.split("::");
      const leftGroups = left ? left.split(":") : [];
      const rightGroups = right ? right.split(":") : [];
      const first = leftGroups[0] || rightGroups[0];
      const last = rightGroups.at(-1) || leftGroups.at(-1);
      if (!first || !last) return ip;
      return first === last ? "::" + first : first + "::**:" + last;
    }
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

/**
 * 将百度 opendata 返回归一化为内部格式
 * opendata 6006: { status:"0", data:[{ location:"广东省深圳市 移动" }] }
 * location 首段为地理（整体放 country_name 供中文显示），其余为运营商；
 * country_code 无法提供，由调用方回填（本地默认 CN）
 */
function normalizeOpendata(data) {
  const loc = data?.data?.[0]?.location;
  if (!loc) return null;
  const parts = String(loc).trim().split(/\s+/);
  return {
    country_code: null,
    country_name: parts[0] || "",
    city: "",
    region: "",
    org: parts.slice(1).join(" ")
  };
}

// Basic Auth 用 base64（Surge JSC 无内建 btoa，凭据为 ASCII）
function b64(s) {
  if (typeof btoa !== "undefined") return btoa(s);
  const c = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < s.length; i += 3) {
    const c1 = s.charCodeAt(i), c2 = s.charCodeAt(i + 1), c3 = s.charCodeAt(i + 2);
    out += c[c1 >> 2] + c[((c1 & 3) << 4) | (isNaN(c2) ? 0 : c2 >> 4)]
      + (isNaN(c2) ? "=" : c[((c2 & 15) << 2) | (isNaN(c3) ? 0 : c3 >> 6)])
      + (isNaN(c3) ? "=" : c[c3 & 63]);
  }
  return out;
}

/**
 * 将 MaxMind GeoLite2 city 返回归一化为内部格式
 * geolite.info/geoip/v2.1/city: { country:{iso_code,names}, city:{names}, subdivisions:[{names}] }
 * zhFirst=true 时中文名优先、缺失回落英文（maxmind-zh），否则英文（maxmind）
 */
function normalizeMaxmind(data, zhFirst) {
  if (!data || !data.country?.iso_code) return null;
  const pick = n => (zhFirst ? (n?.["zh-CN"] || n?.en) : n?.en) || "";
  return {
    country_code: data.country.iso_code,
    country_name: pick(data.country.names),
    city: pick(data.city?.names),
    region: pick(data.subdivisions?.[0]?.names),
    org: ""
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
  if (isStash) return { policy: args.proxy || (args.mode === "collapsed" ? "当前检测出口" : "按规则分流"), entranceIP: null };
  const pattern = /(api(-ipv4)?\.ip\.sb|ipinfo\.io|ip-api\.com|\b1\.1\.1\.1\b|2606:4700|opendata\.baidu\.com|geolite\.info)/i;

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
// 缓存策略：出口 IP、risk_api、是否带 Key 均未变化，且缓存未超过 riskCacheTTL
// （默认 24 小时）时直接复用，不再重新请求；IP 变化或缓存过期才会重新查询
async function getRiskScore(ip) {
  const api = args.riskApi;
  const hasKey = !!args.ipqsKey;

  const cached = $persistentStore.read(CONFIG.storeKeys.riskCache);
  if (cached) {
    try {
      const c = JSON.parse(cached);
      const age = Math.floor(Date.now() / 1000) - (c.ts || 0);
      if (c.ip === ip && (c.api || "") === api && !!c.hasKey === hasKey && age < CONFIG.riskCacheTTL) {
        console.log("风险评分命中缓存: " + c.score + "% (" + c.source + ")，已缓存 " + age + "s");
        return { score: c.score, source: c.source };
      }
    } catch (e) {}
  }

  function saveAndReturn(score, source) {
    $persistentStore.write(JSON.stringify({ ip, score, source, api, hasKey, ts: Math.floor(Date.now() / 1000) }), CONFIG.storeKeys.riskCache);
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
    const data = await getProxyCheck(ip);
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
  if (api && !tryMap[api]) console.log("未知 risk_api: " + api + "，走四级回落");

  // 指定数据源 → 优先使用
  if (tryMap[api]) {
    const r = await tryMap[api]();
    if (r) return r;
  }

  // 未指定 → 四级回落 / 指定但失败 → 回落到剩余数据源
  for (const key of ["ipqs", "proxycheck", "ippure", "scamalytics"].filter(k => k !== api)) {
    const r = await tryMap[key]();
    if (r) return r;
  }

  // 所有数据源均失败：仅为本次展示返回未知状态，不写入缓存，
  // 避免一次性的临时故障被 24h TTL 放大成长期错误风控值
  console.log("风险评分：所有数据源均失败，显示未知（不缓存）");
  return { score: null, source: "Unavailable" };
}

// ==================== IP 类型检测（二级回落） ====================
// IP 类型（住宅/机房）是出口 IP 的静态属性，与风险评分同样按出口 IP + 24h TTL 缓存，
// 避免面板自动刷新反复消耗 IPPure 额度
async function getIPType(ip) {
  const cached = $persistentStore.read(CONFIG.storeKeys.ipTypeCache);
  if (cached) {
    try {
      const c = JSON.parse(cached);
      const age = Math.floor(Date.now() / 1000) - (c.ts || 0);
      if (c.ip === ip && age < CONFIG.riskCacheTTL) {
        console.log("IP 类型命中缓存: " + c.ipType + " | " + c.ipSrc + "，已缓存 " + age + "s");
        return { ipType: c.ipType, ipSrc: c.ipSrc };
      }
    } catch (e) {}
  }

  function saveAndReturn(ipType, ipSrc) {
    $persistentStore.write(JSON.stringify({ ip, ipType, ipSrc, ts: Math.floor(Date.now() / 1000) }), CONFIG.storeKeys.ipTypeCache);
    return { ipType, ipSrc };
  }

  const info = await getIPPureInfo();
  if (info && info.isResidential !== undefined) {
    console.log("IPPure /v1/info 返回 IP 类型数据");
    return saveAndReturn(
      info.isResidential ? "住宅 IP" : "机房 IP",
      info.isBroadcast ? "广播 IP" : "原生 IP"
    );
  }
  console.log("IPPure /v1/info 未返回 IP 类型，回落到 /v1/card");

  const html = await getIPPureCard();
  if (html) {
    const ipType = /住宅|[Rr]esidential/.test(html) ? "住宅 IP" : "机房 IP";
    const ipSrc = /广播|[Bb]roadcast|[Aa]nnounced/.test(html) ? "广播 IP" : "原生 IP";
    console.log("IPPure /v1/card 抓取结果: " + ipType + " | " + ipSrc);
    return saveAndReturn(ipType, ipSrc);
  }

  // IPPure 全部失败 → 复用 ProxyCheck 响应的 type 字段（风险评分链路已请求过，零额外开销）
  const pc = await getProxyCheck(ip);
  const pcType = pc?.[ip]?.type;
  if (pcType) {
    const ipType = /residential|wireless|mobile/i.test(pcType) ? "住宅 IP" : "机房 IP";
    console.log("ProxyCheck type 回退: " + pcType + " → " + ipType);
    return saveAndReturn(ipType, "未知");
  }

  console.log("IPPure/ProxyCheck 所有接口均失败");
  return { ipType: "未知", ipSrc: "未知" };
}

// ==================== DNS 泄露检测 ====================
async function checkDNSLeak(policy) {
  const c = "abcdefghijklmnopqrstuvwxyz0123456789";
  function randStr(len) { let s = ""; for (let i = 0; i < len; i++) s += c[Math.floor(Math.random() * c.length)]; return s; }

  // edns.ip-api.com：随机子域触发 DNS 查询，服务端返回解析器 IP 和地理信息
  const ednsData = await httpJSON(CONFIG.urls.dnsLeakEdns(randStr(32)), policy);
  if (!ednsData?.dns) {
    console.log("DNS 泄露检测失败");
    return { leaked: null, resolvers: null };
  }
  const ip = ednsData.dns.ip || "";
  const geo = ednsData.dns.geo || "";
  const isChina = /China|中国/i.test(geo);
  const name = (geo.includes(" - ") ? geo.split(" - ").pop().trim() : (geo || ip)).replace(/\s*communications\s+corporation/gi, "");
  const resolvers = ip ? [{ ip, name, geo, isChina }] : [];
  const leaked = isChina;
  console.log("DNS 解析器: " + (resolvers.length ? resolvers[0].name + (isChina ? " [CN]" : "") : "无"));
  return { leaked, resolvers: resolvers.length > 0 ? resolvers : null };
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
  if (isStash) return null;
  const data = await surgeAPI("GET", "/v1/traffic");
  if (!data) {
    console.log("流量统计获取失败");
    return null;
  }
  console.log("流量统计原始数据: " + JSON.stringify(data).slice(0, 300));

  // Surge 返回 interface 为嵌套字典 { en0: {...}, pdp_ip0: {...}, lo0: {...} }
  let network = null;
  if (data.interface && typeof data.interface === "object") {
    const keys = Object.keys(data.interface).filter(k => k !== "lo0");
    if (keys.length > 0) {
      network = data.interface[keys[0]];
      console.log("使用网卡: " + keys[0]);
    }
  }
  if (!network) network = data.connector || data;
  const upload = network.out ?? 0;
  const download = network.in ?? 0;
  const rawStart = data.startTime;
  const startMs = rawStart
    ? (typeof rawStart === "number" && rawStart < 1e12 ? rawStart * 1000 : new Date(rawStart).getTime())
    : null;
  const duration = startMs ? Math.floor((Date.now() - startMs) / 1000) : null;

  return { upload, download, duration };
}

// ==================== IP 获取 ====================
// Cloudflare cdn-cgi/trace 纯文本响应（ip=x.x.x.x\nloc=US\n…）→ 对象
function parseTrace(text) {
  if (!text || typeof text !== "string" || !text.includes("ip=")) return null;
  const o = {};
  text.trim().split("\n").forEach(l => {
    const i = l.indexOf("=");
    if (i > 0) o[l.slice(0, i)] = l.slice(i + 1);
  });
  return o.ip ? o : null;
}

// 出口 IPv4：Cloudflare trace 优先（官方端点 + IP 直连），失败回落 ip.sb
async function fetchOutbound4() {
  const t = parseTrace(await httpRaw(CONFIG.urls.outboundTrace));
  if (t) return { ip: t.ip, raw: { country_code: t.loc, country: t.loc } };
  console.log("CF trace(v4) 失败，回落 ip.sb");
  const sb = await httpJSON(CONFIG.urls.outboundIP);
  return sb?.ip ? { ip: sb.ip, raw: sb } : null;
}

async function fetchOutbound6() {
  const deadline = Date.now() + CONFIG.ipv6Timeout;
  const t = parseTrace(await httpRaw(CONFIG.urls.outboundTrace6, null, null, deadline));
  if (t) return t.ip;
  console.log("CF trace(v6) 失败，回落 ip.sb");
  const sb = await httpJSON(CONFIG.urls.outboundIPv6, null, null, deadline);
  return sb?.ip || null;
}

async function fetchIPs() {
  const [local, exit, exit6ip] = await Promise.all([
    httpJSON(CONFIG.urls.localIP, "DIRECT"),
    fetchOutbound4(),
    hasTimers ? Promise.race([
      fetchOutbound6(),
      wait(CONFIG.ipv6Timeout).then(() => null)
    ]) : fetchOutbound6()
  ]);

  const hasIPv6 = exit6ip && exit6ip.includes(":");

  return {
    localIP: local?.data?.addr || null,
    outIP: exit?.ip || null,
    outIPv6: hasIPv6 ? exit6ip : null,
    localRaw: local,
    outRaw: exit?.raw || null
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

// Stash 没有使用 Surge 的网络事件：在首页 Tile 刷新时比较成功取得的 IP。
// 首次仅建立基线；本地接口失败不更新基线，IPv6 暂时失败不视为断开。
function checkStashIPChange(localIP, outIP, outIPv6) {
  if (!isStash || args.tile !== "outbound" || args.mode !== "home" || !args.notify || !localIP || !outIP) return false;
  let previous = null;
  try { previous = JSON.parse($persistentStore.read(CONFIG.storeKeys.lastEvent) || "null"); } catch (_) {}
  const changed = previous && (previous.localIP !== localIP || previous.outIP !== outIP ||
    (!!outIPv6 && previous.outIPv6 !== outIPv6));
  const retainedIPv6 = previous && previous.outIP === outIP ? previous.outIPv6 : null;
  $persistentStore.write(JSON.stringify({ localIP, outIP, outIPv6: outIPv6 || retainedIPv6 || null }), CONFIG.storeKeys.lastEvent);
  return !!changed;
}

// ==================== 面板内容构建 ====================
function geoLabel(info) {
  // ip-api.com(zh): country_name="香港"(非 ASCII) → 显示中文国名
  // ip-api.com(en): country_name="Hong Kong" / ipinfo.io: country_name="HK" → 显示 country_code
  return (info?.country_name && /[^\x00-\x7F]/.test(info.country_name)) ? info.country_name : info?.country_code;
}

function buildOutboundSection(outIP, outIPv6, outInfo, maskMode, reverseDNS) {
  const lines = [];
  const m = (ip) => maskIP(ip, maskMode);

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

function buildPanelContent({ localZh, maskMode, riskInfo, riskResult, ipType, ipSrc, localIP, localInfo, entranceIP, entranceInfo, outIP, outIPv6, outInfo, dnsLeak, reverseDNS, traffic }) {
  const m = (ip) => maskIP(ip, maskMode);
  const lines = [
    "IP 风控值：" + formatRisk(riskInfo),
  ];

  // DNS 泄露检测
  if (dnsLeak) {
    if (dnsLeak.leaked === null) {
      lines.push("DNS 检测：检测失败");
    } else if (dnsLeak.resolvers) {
      const names = [...new Set(dnsLeak.resolvers.map(r => r.name).filter(Boolean))];
      if (dnsLeak.leaked) {
        const leakedNames = [...new Set(dnsLeak.resolvers.filter(r => r.isChina).map(r => r.name))];
        lines.push("DNS 检测：⚠️ 泄露! " + leakedNames.join(", "));
      } else {
        lines.push("DNS 检测：无泄露 (" + names.join(" / ") + ")");
      }
    } else {
      lines.push("DNS 检测：无泄露");
    }
  }

  lines.push(
    "",
    "IP 类型：" + ipType + " | " + ipSrc,
    "",
    "本地 IP：" + m(localIP),
    "地区：" + formatGeo(localInfo?.country_code, localInfo?.city, localInfo?.region, localZh ? localInfo?.country_name : localInfo?.country_code),
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

  lines.push("", ...buildOutboundSection(outIP, outIPv6, outInfo, maskMode, reverseDNS));

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
function sendNetworkChangeNotification({ localZh, policy, localIP, outIP, entranceIP, localInfo, entranceInfo, outInfo, riskInfo, riskResult, ipType, ipSrc, maskMode, dnsLeak }) {
  if (!args.notify) {
    console.log("通知已禁用 (notify=false)，跳过推送");
    return;
  }

  const m = (ip) => maskIP(ip, maskMode);
  const title = "🔄 网络已切换 | " + policy;
  const subtitle = "Ⓓ " + m(localIP) + " 🅟 " + m(outIP);
  const bodyLines = [
    "Ⓓ " + formatGeo(localInfo?.country_code, localInfo?.city, localZh ? localInfo?.country_name : localInfo?.country_code) + " · " + (localInfo?.org || "Unknown"),
  ];
  if (entranceInfo) {
    bodyLines.push("Ⓔ " + m(entranceIP) + " " + formatGeo(entranceInfo?.country_code, entranceInfo?.city, geoLabel(entranceInfo)) + " · " + (entranceInfo?.org || "Unknown"));
  }
  bodyLines.push(
    "🅟 " + formatGeo(outInfo?.country_code, outInfo?.city, geoLabel(outInfo)) + " · " + (outInfo?.org || "Unknown"),
    "🅟 风控：" + formatRisk(riskInfo) + " | 类型：" + ipType + " · " + ipSrc
  );
  if (dnsLeak && dnsLeak.leaked && dnsLeak.resolvers) {
    const leakedNames = [...new Set(dnsLeak.resolvers.filter(r => r.isChina).map(r => r.name))];
    bodyLines.push("⚠️ DNS 泄露! " + leakedNames.join(", "));
  }

  $notification.post(title, subtitle, bodyLines.join("\n"));
  console.log("=== 已发送通知 ===");
}

// ==================== Stash 独立卡片 ====================
// 固定选定的数据源，不运行 Surge 的全量检测，不依赖 $httpAPI 或 JS 定时器。
// IPPure 的评分与类型来自同一个响应，显示其实际检测 IP；按规则分流时不同探测站点的出口可能不同。
async function runStashTile() {
  const tile = stashTiles[args.tile];
  if (!tile) return done({ content: "未知卡片类型" });
  const fail = message => done({ content: message, backgroundColor: "#9E9E9E" });
  const render = (lines, color = tile.color) => done({ content: lines.filter(Boolean).join("\n"), backgroundColor: color });
  const m = ip => maskIP(ip, args.maskIP);

  if (args.tile === "risk") {
    // 每次刷新只请求一次 IPPure；不回落其他评分源，也不复用可能属于旧节点的评分。
    const info = await getIPPureInfo();
    if (!info || typeof info !== "object") return fail("IPPure 检测失败");
    const score = typeof info.fraudScore === "number" ? info.fraudScore :
      (typeof info.fraudScore === "string" && info.fraudScore.trim() ? Number(info.fraudScore) : NaN);
    const valid = Number.isFinite(score) && score >= 0 && score <= 100;
    const ipType = typeof info.isResidential === "boolean" ? (info.isResidential ? "住宅 IP" : "机房 IP") : "类型未知";
    const ipSrc = typeof info.isBroadcast === "boolean" ? (info.isBroadcast ? "广播 IP" : "原生 IP") : "来源未知";
    const level = score < 40 ? "低风险" : score < 70 ? "中风险" : "高风险";
    const color = !valid ? "#9E9E9E" : score < 40 ? "#2E9F5E" : score < 70 ? "#D4A017" : "#C44444";
    return render([
      valid ? "评分：" + score + " / 100 · " + level : "IPPure 暂无有效评分",
      ipType + " · " + ipSrc,
      typeof info.ip === "string" && info.ip ? m(info.ip) : "",
      "来源：IPPure"
    ], color);
  }

  if (args.tile === "local") {
    const local = await httpJSON(CONFIG.urls.localIP, "DIRECT");
    const ip = local?.data?.addr;
    if (!ip) return fail("无法获取直连公网 IP");
    const [baidu, sb] = await Promise.all([
      httpJSON(CONFIG.urls.baiduGeo(ip), "DIRECT"),
      httpJSON(CONFIG.urls.ipSbGeo(ip), "DIRECT")
    ]);
    const info = normalizeOpendata(baidu);
    if (info && /^(移动|联通|电信|广电)$/.test(info.org)) info.org = "中国" + info.org;
    return render([
      m(ip),
      info ? [flag(sb?.country_code), info.country_name].filter(Boolean).join(" ") : "百度地区查询失败",
      info?.org || "运营商未知"
    ], info ? tile.color : "#9E9E9E");
  }

  if (args.tile === "dns") {
    const detected = await checkDNSLeak(args.proxy || undefined);
    const resolver = detected.resolvers?.[0];
    if (!resolver) return fail("DNS 解析器检测失败");
    const info = normalizeIpApi(await httpJSON(CONFIG.urls.ipApi(resolver.ip, "zh-CN")));
    return render([
      m(resolver.ip),
      info ? formatGeo(info.country_code, info.city, info.region, geoLabel(info)) : resolver.geo,
      info?.org || (!resolver.geo ? resolver.name : "")
    ]);
  }

  const { localIP, outIP, outIPv6, outRaw } = await fetchIPs();
  if (!outIP) return fail("无法获取出口 IPv4");
  const [geo, org] = await Promise.all([
    httpJSON(CONFIG.urls.ipApi(outIP, "zh-CN")),
    httpJSON(CONFIG.urls.ipInfo(outIP))
  ]);
  const info = normalizeIpApi(geo);
  const organization = normalizeIpInfo(org)?.org || info?.org || "运营商未知";
  const location = info ? formatGeo(info.country_code, info.city, info.region, geoLabel(info)) :
    [flag(outRaw?.country_code), "ip-api 地区查询失败"].filter(Boolean).join(" ");
  const lines = [m(outIP), outIPv6 ? "IPv6：" + m(outIPv6) : "", location, organization];
  if (!finished && checkStashIPChange(localIP, outIP, outIPv6)) {
    // 只有出口卡片负责通知；不为通知重复请求风险、本地地理或 DNS。
    if (typeof $notification !== "undefined" && typeof $notification.post === "function") {
      try {
        $notification.post("🔄 IP 已变化", location, ["本地 IP：" + m(localIP), ...lines].join("\n"));
      } catch (_) { console.log("通知发送失败，继续显示检测结果"); }
    } else { console.log("当前客户端未提供通知接口"); }
  }
  return render(lines, info ? tile.color : "#9E9E9E");
}

// ==================== 主执行函数 ====================
(async () => {
  try {
  console.log("=== IP 安全检测开始 ===");
  if (isStash) return await runStashTile();

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
  let localGeoApi = args.localGeoApi;
  if (!["bilibili", "baidu", "ipsb"].includes(localGeoApi)) {
    console.log("未知 local_geoapi: " + localGeoApi + "，使用 baidu");
    localGeoApi = "baidu";
  }
  const useBilibili = localGeoApi === "bilibili";
  const useBaiduLocal = localGeoApi === "baidu";
  const localZh = useBilibili || useBaiduLocal; // 本地地理为中文源 → 显示中文国名

  // 入口/出口地理数据源：remote_geoapi=ipinfo → ipinfo.io, ipapi/ipapi-zh → ip-api.com(en/zh, http 明文),
  // maxmind/maxmind-zh → GeoLite2(en/zh, 需 key)
  let remoteGeoApi = args.remoteGeoApi;
  if (!["ipinfo", "ipapi", "ipapi-zh", "maxmind", "maxmind-zh"].includes(remoteGeoApi)) {
    console.log("未知 remote_geoapi: " + remoteGeoApi + "，使用 ipapi-zh");
    remoteGeoApi = "ipapi-zh";
  }
  const useIpApi = remoteGeoApi.startsWith("ipapi");
  let useMaxmind = remoteGeoApi.startsWith("maxmind");
  const maxmindZh = remoteGeoApi === "maxmind-zh";
  if (useMaxmind && !args.maxmindKey) {
    console.log("remote_geoapi=maxmind 需要 maxmind_key（account_id:license_key），回落 ipinfo");
    useMaxmind = false;
  }
  const ipApiLang = remoteGeoApi === "ipapi-zh" ? "zh-CN" : "en";
  // 非 ipinfo 数据源时需单独请求 ipinfo：运营商始终用 ipinfo + rDNS 取自 hostname
  const needExtraOrg = useIpApi || useMaxmind;
  const geoHeaders = useMaxmind ? { "Authorization": "Basic " + b64(args.maxmindKey) } : undefined;
  function geoUrl(ip) {
    if (useMaxmind) return CONFIG.urls.maxmindGeo(ip);
    return useIpApi ? CONFIG.urls.ipApi(ip, ipApiLang) : CONFIG.urls.ipInfo(ip);
  }
  function normalizeGeo(data) {
    if (useMaxmind) return normalizeMaxmind(data, maxmindZh);
    return useIpApi ? normalizeIpApi(data) : normalizeIpInfo(data);
  }

  // 先并行发起 geo/risk/流量 API 请求，确保 ip.sb/ipinfo/ip-api 请求完成后再查策略
  // DNS 泄露检测需要走代理策略，必须在取得 policy 后执行
  const [riskInfo, ipTypeResult, localSbRaw, localBaiduRaw, outGeoRaw, outOrgRaw, trafficResult] = await Promise.all([
    getRiskScore(outIP),                     // 0: 风险评分
    getIPType(outIP),                        // 1: IP 类型
    httpJSON(CONFIG.urls.ipSbGeo(localIP)),  // 2: ip.sb 本地（en 地理 / zh country_code）
    useBaiduLocal ? httpJSON(CONFIG.urls.baiduGeo(localIP)) : null,  // 3: 百度本地地理（仅 baidu 模式）
    httpJSON(geoUrl(outIP), null, geoHeaders),  // 4: 出口地理
    needExtraOrg ? httpJSON(CONFIG.urls.ipInfo(outIP)) : null,  // 5: 出口运营商（非 ipinfo 数据源时）+ hostname
    getTrafficStats(),                       // 6: 流量统计
  ]);

  // API 请求已完成，此时 recent 里一定有匹配记录
  const { policy, entranceIP } = await getPolicyAndEntrance();

  // DNS 泄露检测：直连无意义，仅代理时执行，强制走代理策略
  const isDirect = !policy || policy === "DIRECT" || policy === "Unknown";
  let dnsLeakResult = null;
  if (!isDirect) {
    dnsLeakResult = await checkDNSLeak(policy);
  } else {
    console.log("当前为直连，跳过 DNS 泄露检测");
  }

  // 本地 IP 地理信息：zh 用 bilibili/baidu（默认中国），en 用 ip.sb
  let localInfo;
  if (useBaiduLocal) {
    const bd = normalizeOpendata(localBaiduRaw);
    const sb = normalizeIpSb(localSbRaw);
    if (bd && /^(移动|联通|电信|广电)$/.test(bd.org)) bd.org = "中国" + bd.org;
    localInfo = bd
      ? { ...bd, country_code: sb?.country_code || "CN" }
      : sb;
  } else if (useBilibili) {
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
  // ipinfo 模式: outGeoRaw 来自 ipinfo.io; 其余数据源: outOrgRaw 来自 ipinfo.io
  const ipinfoRaw = needExtraOrg ? outOrgRaw : outGeoRaw;
  const reverseDNS = ipinfoRaw?.hostname || null;
  if (reverseDNS) console.log("反向 DNS: " + reverseDNS);
  if (needExtraOrg && outInfo) {
    const orgData = normalizeIpInfo(outOrgRaw);
    if (orgData?.org) outInfo.org = orgData.org;
  }

  // 入口 IP 地理信息：与出口不同时才查询
  let entranceInfo = null;
  if (entranceIP && entranceIP !== outIP) {
    console.log("入口 IP: " + entranceIP + " 与出口 IP 不同，查询入口地理信息");
    const entrQueries = [httpJSON(geoUrl(entranceIP), null, geoHeaders)];
    if (needExtraOrg) entrQueries.push(httpJSON(CONFIG.urls.ipInfo(entranceIP)));
    const [entrGeoRaw, entrOrgRaw] = await Promise.all(entrQueries);
    entranceInfo = normalizeGeo(entrGeoRaw);
    if (needExtraOrg && entranceInfo && entrOrgRaw) {
      const orgData = normalizeIpInfo(entrOrgRaw);
      if (orgData?.org) entranceInfo.org = orgData.org;
    }
  }

  const riskResult = riskText(riskInfo.score);
  const { ipType, ipSrc } = ipTypeResult;

  // 5. IP 打码：mask_ip=2 锁定全隐藏；0/1 手动点击切换
  const maskStored = parseInt($persistentStore.read(CONFIG.storeKeys.maskToggle), 10);
  let maskMode = args.maskIP === 2 ? 2 : (Number.isInteger(maskStored) ? maskStored : args.maskIP);
  if (args.maskIP !== 2 && !args.isEvent) {
    const now = Math.floor(Date.now() / 1000);
    const lastRun = parseInt($persistentStore.read(CONFIG.storeKeys.lastRun), 10) || 0;
    $persistentStore.write(String(now), CONFIG.storeKeys.lastRun);
    const elapsed = now - lastRun;
    const interval = args.panelInterval; // 需与 [Panel] update-interval 一致，经 panel_interval 参数传入（默认 600）
    const tolerance = 15;
    const remainder = elapsed % interval;
    const isAutoRefresh = lastRun > 0 && elapsed > tolerance
      && (remainder <= tolerance || remainder >= interval - tolerance);
    if (lastRun > 0 && !isAutoRefresh) {
      maskMode = maskMode === 1 ? 0 : 1;
      $persistentStore.write(String(maskMode), CONFIG.storeKeys.maskToggle);
    }
  }
  const context = { localZh, maskMode, policy, riskInfo, riskResult, ipType, ipSrc, localIP, localInfo, entranceIP, entranceInfo, outIP, outIPv6, outInfo, dnsLeak: dnsLeakResult, reverseDNS, traffic: trafficResult };

  if (finished) return;
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
