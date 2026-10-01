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
 * ② 出口 IP: Surge 使用 Cloudflare trace → ip.sb；Stash 与官方卡片一样使用 IPPure，IPv4 缺失时回落 ipify
 * ③ 入口 IP: Surge /v1/requests/recent → remoteAddress(Proxy)
 * ④ 代理策略: Surge /v1/requests/recent
 * ⑤ 风险评分: IPQS (需 Key) → ProxyCheck → IPPure → Scamalytics；risk_api 指定优先源
 *    Surge 按出口 IP 缓存 24 小时；Stash 默认每次请求 IPPure，其他源按显式选项查询
 * ⑥ IP 类型: IPPure API → ProxyCheck type 字段回退（复用风险评分的请求；与风险评分同样按出口 IP 24 小时缓存）
 * ⑦ 地理: 本地默认百度；入口/出口默认 ip-api.com 中文；可选数据源见下方参数
 * ⑧ 出口运营商: 两端优先 ipinfo.io；失败保留选定地区源或本轮出口探测的运营商
 * ⑨ DNS 解析器: edns.ip-api.com；Surge 按解析器地区作提示，未验证是否属于本地 ISP
 * ⑩ 反向 DNS: ipinfo.io hostname 字段
 * ⑪ 流量统计: Surge /v1/traffic API
 *
 * 参数说明：
 * - TYPE: 设为 EVENT 表示网络变化触发（自动判断，无需手动设置）
 * - ipqs_key: IPQualityScore API Key（可选，仅 risk_api=ipqs 或回落模式需要）
 * - risk_api: 优先风险源，ipqs / proxycheck / ippure / scamalytics；Stash 默认 ippure，显式指定其他源时失败回落
 * - local_geoapi: 本地 IP 地理数据源，baidu(默认)=百度 opendata(中文，省市区粒度)，bilibili=bilibili(中文)，ipsb=ip.sb(英文)
 * - remote_geoapi: 入口/出口地理数据源，默认 ipapi-zh；Stash 可选 ippure。ipapi-zh=ip-api.com(中文, http 明文)，ipinfo=ipinfo.io，ipapi=ip-api.com(英文)，maxmind=GeoLite2(英文)，maxmind-zh=GeoLite2(中文优先)
 * - maxmind_key: MaxMind GeoLite 凭据，格式 account_id:license_key（仅 remote_geoapi=maxmind/maxmind-zh 需要，免费注册 1000 次/天）
 * - mask_ip: IP 打码，0=关闭，1=部分打码，2=全部隐藏 [IP 已隐藏]，默认 0
 * - tw_flag: 台湾地区旗帜，cn(默认)=🇨🇳，tw=🇹🇼
 * - event_delay: 网络变化后延迟检测（秒），默认 2 秒
 * - notify: 网络变化时是否推送通知，true(默认)=推送，false=不推送；Stash 独立定时任务比较 IP，首次仅记录
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
 * Stash：ip-security-panel.stoverride 提供首页聚合与三张折叠卡片，600 秒刷新；与 Surge 共用此文件。
 * - summary 首页 IP 信息卡；outbound 出口、local 本地、risk 纯净度维持独立折叠检测。
 * - Stash 默认风险源 IPPure、本地百度、出口地区 ipapi-zh；可用 risk_api / local_geoapi / remote_geoapi 改选。
 *   可选源与 Surge 同名；remote_geoapi=ippure 是 Stash 的可选源，其他地区源按指定 IP 查询。
 *   本地源失败回落本轮 ip.sb；出口地区源失败回落本轮出口探测地区，运营商优先 ipinfo。
 *   地区与运营商每轮查询，不复用历史字段；风险数据缓存保持独立。
 *   两端共用六档风险等级与颜色，首页补充 DNS 解析器、rDNS、显式指定的策略名。
 *   DNS 地区只作展示，不据此判断泄露；打码时同时隐藏可能包含 IP 的 rDNS。
 *   脚本 notify 默认 true；配套卡片显式关闭通知，仅 monitor 定时任务开启。
 * - 覆写 argument 内的 tile 用于选择卡片；其余选项已预设，不需要导入参数界面。
 * - proxy: 可手动指定 URL 编码的节点/策略组名；留空遵循当前分流。
 * - mode: home / collapsed（独立卡片默认）；折叠模式不覆盖 Stash 长按节点时指定的出口。
 * - iOS 折叠卡片按 $environment.system 自动使用单行标题：Ⓓ / 🅟 + IP，纯净度只显示百分比。
 * - mask_ip: Stash 固定按参数显示，不通过刷新时间猜测点击切换。
 * - Stash 不调用 Surge 专用 API，不显示入口 IP/流量统计，不订阅 network-changed 事件。
 *   task=monitor 独立定时通知 IP 变化；卡片不写通知基线，避免长按测试节点时误报。
 *   通知与 Surge 使用相同排版，变化后补查本地/出口地区、运营商及 IPPure 风险；
 *   只展示本轮有效 IP 对应的数据，不依赖 Surge 的入口或策略查询接口。
 * - log=shared: Stash 各卡片与通知日志按任务暂存；task=logs 独立收集到一个脚本日志。
 *
 * @version 6.4.10
 * @date 2026-10-01
 */

// ==================== 全局配置 ====================
const isStash = (typeof $environment !== "undefined" &&
  (!!$environment["stash-version"] || !!$environment["stash-build"])) ||
  (typeof $script !== "undefined" && $script.type === "tile");
const stashSystem = typeof $environment !== "undefined" ? String($environment.system || "").trim().toLowerCase() : "";
const isStashiOS = isStash && (stashSystem === "ios" || stashSystem === "ipados");
const hasTimers = typeof setTimeout === "function";
// 图标统一由覆写提供；更新检测结果时保留卡片 Logo。
const stashTiles = {
  summary: { title: "IP 信息卡", color: "#9E9E9E" },
  risk: { title: "IP 纯净度", color: "#88A788" },
  dns: { title: "DNS 解析器", color: "#7357A6" },
  outbound: { title: "出口 IP", marker: "🅟", color: "#1565C0" },
  local: { title: "本地 IP", marker: "Ⓓ", color: "#00796B" }
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
    stashIPv4: "https://api.ipify.org?format=json",
    stashIPv6: "https://api6.ipify.org?format=json",
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
  stashIPv4Timeout: 5000, // IPPure 失败后的 IPv4 备用请求预算，仍受总时限约束
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

// 每个卡片/通知任务使用独立队列，收集器仅记录已输出 ID，不清空生产者的队列。
class IPLog {
  static PREFIX = "stash_ip_security_log_v1:";
  static SCOPES = ["summary", "outbound", "local", "risk", "notify"];
  static RUN_ID = Date.now().toString(36) + ":" + Math.random().toString(36).slice(2);
  static sequence = 0;

  static native(value) {
    try { console.log(value); } catch {}
  }

  static text(value) {
    if (typeof value === "string") return value;
    if (value instanceof Error) return value.message || String(value);
    try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
  }

  static readQueue(scope) {
    const raw = $persistentStore.read(IPLog.PREFIX + scope);
    if (!raw) return [];
    const entries = JSON.parse(raw);
    if (!Array.isArray(entries)) return [];
    return entries.filter(entry => entry && typeof entry.id === "string"
      && Number.isFinite(entry.time) && Math.abs(entry.time) <= 8640000000000000
      && typeof entry.text === "string").slice(-60);
  }

  static log(...values) {
    let text;
    try { text = values.map(value => IPLog.text(value)).join(" "); }
    catch { text = "[ip-security] 日志内容无法格式化"; }
    if (!isStash || args.log !== "shared" || args.task === "logs") {
      IPLog.native(text);
      return;
    }
    try {
      const scope = args.task === "monitor" ? "notify"
        : IPLog.SCOPES.includes(args.tile) ? args.tile : "summary";
      const time = Date.now();
      const entry = {
        id: `${time}:${IPLog.RUN_ID}:${String(IPLog.sequence++).padStart(6, "0")}`,
        time,
        text: text.slice(0, 2000)
      };
      const entries = IPLog.readQueue(scope);
      entries.push(entry);
      if ($persistentStore.write(JSON.stringify(entries.slice(-60)), IPLog.PREFIX + scope) === false) {
        throw new Error("日志存储写入失败");
      }
    } catch {
      IPLog.native(text);
    }
  }

  static collect() {
    const pending = [];
    const queues = [];
    for (const scope of IPLog.SCOPES) {
      try {
        const entries = IPLog.readQueue(scope);
        const ackKey = IPLog.PREFIX + "ack:" + scope;
        const previous = JSON.parse($persistentStore.read(ackKey) || "[]");
        const seen = new Set(Array.isArray(previous) ? previous : []);
        for (const entry of entries) {
          if (!seen.has(entry.id)) pending.push({ ...entry, scope });
        }
        const ids = entries.map(entry => entry.id);
        if (ids.some(id => !seen.has(id)) || seen.size !== ids.length) queues.push({ ackKey, ids });
      } catch {
        IPLog.native(`[ip-security][${scope}] 无法读取日志队列`);
      }
    }
    pending.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
    for (const entry of pending) {
      IPLog.native(`[${new Date(entry.time).toISOString()}][${entry.scope}] ${entry.text}`);
    }
    for (const queue of queues) {
      try {
        if ($persistentStore.write(JSON.stringify(queue.ids), queue.ackKey) === false) {
          throw new Error("日志确认写入失败");
        }
      } catch {
        IPLog.native("[ip-security] 无法记录日志确认，下次可能重复输出");
      }
    }
  }
}

// ==================== 参数解析 ====================
function parseArguments() {
  let arg = {};
  const decode = value => { try { return decodeURIComponent(value); } catch (_) { return value; } };

  if (typeof $argument !== "undefined") {
    // 不打印 $argument 原文：其中可能含 ipqs_key 等敏感凭据
    arg = Object.fromEntries($argument.split("&").map(i => {
      const idx = i.indexOf("=");
      return idx === -1 ? [i.trim(), ""] : [i.slice(0, idx).trim(), decode(i.slice(idx + 1)).trim()];
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

  if (!isStash) IPLog.log("参数解析: risk_api=" + JSON.stringify(arg.risk_api) + " ipqs_key=" + (arg.ipqs_key ? "已设置" : "未设置"));

  // notify 参数：默认 true，仅当明确设为 "false" 时关闭通知
  const notifyVal = clean(arg.notify).toLowerCase();
  const notify = notifyVal !== "false";

  return {
    isEvent: !isStash && arg.TYPE === "EVENT",
    proxy: isStash && clean(arg.mode) !== "collapsed" ? clean(arg.proxy) : "",
    mode: clean(arg.mode) === "collapsed" ? "collapsed" : "home",
    tile: clean(arg.tile) || "outbound",
    task: clean(arg.task),
    log: clean(arg.log),
    ipqsKey: clean(arg.ipqs_key),
    riskApi: clean(arg.risk_api).toLowerCase() || (isStash ? "ippure" : ""),
    maxmindKey: clean(arg.maxmind_key),
    localGeoApi: clean(arg.local_geoapi) || "baidu",
    remoteGeoApi: clean(arg.remote_geoapi) || "ipapi-zh",
    maskIP: arg.mask_ip === "2" ? 2 : (arg.mask_ip === "1" || arg.mask_ip === "true") ? 1 : 0,
    twFlag: clean(arg.tw_flag) || (isStash ? "tw" : "cn"),
    eventDelay: parseFloat(arg.event_delay) || 2,
    notify: notify,
    panelInterval: parseInt(clean(arg.panel_interval), 10) || 600
  };
}

const args = parseArguments();

if (!(isStash && args.task === "logs")) IPLog.log("触发类型: " + (args.isEvent ? "EVENT" : "MANUAL") + ", risk_api: " + (args.riskApi || "fallback") + ", 本地: " + args.localGeoApi + ", 通知: " + args.notify);

// ==================== 全局状态控制 ====================
let finished = false;
let watchdog = null;
const requestDeadline = Date.now() + CONFIG.timeout - 250;

function done(o) {
  if (finished) return;
  finished = true;
  if (watchdog !== null && typeof clearTimeout === "function") clearTimeout(watchdog);
  if (isStash && (args.task === "monitor" || args.task === "logs")) {
    $done({});
  } else if (isStash) {
    $done({
      title: o.title || stashTiles[args.tile]?.title || "IP Security",
      content: o.content || "检测失败",
      backgroundColor: o.backgroundColor || o["icon-color"] || "#9E9E9E",
      url: o.url || "https://ippure.com"
    });
  } else {
    $done(o);
  }
}

if (hasTimers && !(isStash && args.task === "logs")) {
  watchdog = setTimeout(() => {
    done({ title: "检测超时", content: "API 请求超时", icon: "leaf", "icon-color": "#9E9E9E" });
  }, CONFIG.timeout);
}

// ==================== HTTP 工具 ====================
function logHTTPFailure(url, status, error) {
  // 只记录站点和错误类别；完整 URL 可能含 IP 或 API Key。
  const host = String(url).match(/^https?:\/\/([^/?#]+)/)?.[1] || "API";
  const detail = String(error || "");
  const reason = error ? (/script wait deadline/i.test(detail) ? "脚本等待期限已到" :
    /timeout|timed out/i.test(detail) ? "请求超时" :
    /dns|resolve|lookup/i.test(detail) ? "DNS 解析失败" :
    /invalid JSON/i.test(detail) ? "JSON 响应无效" :
    /tls|ssl|certificate/i.test(detail) ? "TLS 连接失败" : "网络请求失败") :
    (status ? "HTTP " + status : "无有效响应");
  IPLog.log("[IP HTTP] " + host + "：" + reason);
}

function httpRaw(url, policy, headers, deadline = requestDeadline) {
  const remaining = Math.min(deadline, requestDeadline) - Date.now();
  if (finished || remaining < 100) return Promise.resolve(null);
  return new Promise(resolve => {
    let req = { url };
    const nativeIPPure = isStash && url === CONFIG.urls.ipType;
    let settled = false, timer = null;
    const complete = (error, response, data) => {
      if (settled) return;
      settled = true;
      if (timer !== null && typeof clearTimeout === "function") clearTimeout(timer);
      const status = Number(response?.status || response?.statusCode);
      if (error || !(status >= 200 && status < 300)) logHTTPFailure(url, status, error);
      resolve(!error && status >= 200 && status < 300 ? (data || null) : null);
    };
    if (headers) req.headers = { ...headers };
    if (isStash) {
      // IPPure 与官方脚本一样使用原生 HTTP 默认值；其他请求的 timeout 单位为秒。
      if (!nativeIPPure) req.timeout = Math.min(5, remaining / 1000);
      const selected = policy || args.proxy;
      if (selected) req.headers = { ...req.headers, "X-Stash-Selected-Proxy": encodeURIComponent(selected) };
      // 不用新增的 5 秒脚本截止截断 IPPure；保留总期限，避免原生请求不回调时挂起。
      if (hasTimers) timer = setTimeout(() => complete("script wait deadline", null, null),
        nativeIPPure ? remaining : Math.min(5000, remaining));
      if (nativeIPPure && !req.headers) req = url;
    } else if (policy) {
      req.policy = policy;
    }
    try {
      $httpClient.get(req, complete);
    } catch (error) { complete(error, null, null); }
  });
}

async function httpJSON(url, policy, headers, deadline) {
  const raw = await httpRaw(url, policy, headers, deadline);
  try { return raw ? JSON.parse(raw) : null; }
  catch (_) { logHTTPFailure(url, 0, "invalid JSON"); return null; }
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

// 单次运行内去重：Stash 出口、评分和类型与官方卡片一样取自同一份 IPPure 数据。
// 不跨刷新缓存此响应，避免节点切换后沿用另一个出口。
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
    IPLog.log("未找到策略记录，等待后重试 (1/2)");
    await wait(CONFIG.policyRetryDelay);
    hit = await findInRecent(50);
  }
  if (!hit) {
    IPLog.log("未找到策略记录，等待后重试 (2/2)");
    await wait(CONFIG.policyRetryDelay * 2);
    hit = await findInRecent(100);
  }

  if (!hit) {
    const lastPolicy = $persistentStore.read(CONFIG.storeKeys.lastPolicy);
    IPLog.log(lastPolicy ? "使用上次保存的策略: " + lastPolicy : "无法找到任何策略信息");
    return { policy: lastPolicy || "Unknown", entranceIP: null };
  }

  const policy = hit.policyName || "Unknown";
  $persistentStore.write(policy, CONFIG.storeKeys.lastPolicy);
  IPLog.log("找到代理策略: " + policy);

  let entranceIP = null;
  if (/\(Proxy\)/.test(hit.remoteAddress)) {
    entranceIP = hit.remoteAddress.replace(/\s*\(Proxy\)\s*/, "").replace(/:\d+$/, "");
    IPLog.log("找到入口 IP: " + entranceIP);
  }

  return { policy, entranceIP };
}

// ==================== 风险评分获取 ====================
// 优先尝试指定源，失败后继续其余源；Stash 默认 IPPure，指定其他源时复用此流程。
// 不填或其他值 → 四级回落（IPQS → ProxyCheck → IPPure → Scamalytics）
// Surge 缓存策略：出口 IP、risk_api、是否带 Key 均未变化，且缓存未超过 riskCacheTTL
// （默认 24 小时）时直接复用，不再重新请求；IP 变化或缓存过期才会重新查询
async function getRiskScore(ip) {
  const api = args.riskApi;
  const hasKey = !!args.ipqsKey;

  const cached = !isStash && $persistentStore.read(CONFIG.storeKeys.riskCache);
  if (cached) {
    try {
      const c = JSON.parse(cached);
      const age = Math.floor(Date.now() / 1000) - (c.ts || 0);
      if (c.ip === ip && (c.api || "") === api && !!c.hasKey === hasKey && age < CONFIG.riskCacheTTL) {
        IPLog.log("风险评分命中缓存: " + c.score + "% (" + c.source + ")，已缓存 " + age + "s");
        return { score: c.score, source: c.source };
      }
    } catch (e) {}
  }

  function saveAndReturn(score, source) {
    if (!(typeof score === "number" || typeof score === "string" && score.trim())) return null;
    score = Number(score);
    if (!Number.isFinite(score) || score < 0 || score > 100) return null;
    if (isStash) return { score, source };
    $persistentStore.write(JSON.stringify({ ip, score, source, api, hasKey, ts: Math.floor(Date.now() / 1000) }), CONFIG.storeKeys.riskCache);
    IPLog.log("风险评分已缓存: " + score + "% (" + source + ")");
    return { score, source };
  }

  async function tryIPQS() {
    if (!args.ipqsKey) return null;
    const data = await httpJSON(CONFIG.urls.ipqs(args.ipqsKey, ip));
    if (data?.success && data?.fraud_score !== undefined) return saveAndReturn(data.fraud_score, "IPQS");
    IPLog.log("IPQS 失败: " + (data ? "success=" + data.success + " message=" + (data.message || "") : "请求失败"));
    return null;
  }

  async function tryProxyCheck() {
    const data = await getProxyCheck(ip);
    if (data?.[ip]?.risk !== undefined) return saveAndReturn(data[ip].risk, "ProxyCheck");
    IPLog.log("ProxyCheck 失败: " + (data ? JSON.stringify(data).slice(0, 100) : "请求失败"));
    return null;
  }

  async function tryIPPure() {
    const info = await getIPPureInfo();
    // IPPure 查询访问者自身；不能把另一路出口的评分套到指定 IP 上。
    if (isStash && stashCacheIP(info?.ip) !== ip) return null;
    if (info?.fraudScore !== undefined) return saveAndReturn(info.fraudScore, "IPPure");
    if (isStash) return null; // card HTML 没有可核验的目标 IP。
    IPLog.log("IPPure /v1/info 无 fraudScore，回落到 /v1/card");
    const html = await getIPPureCard();
    if (html) {
      const m = html.match(/(\d+)\s*%\s*(极度纯净|纯净|一般|微风险|一般风险|极度风险)/);
      if (m) return saveAndReturn(Number(m[1]), "IPPure");
    }
    IPLog.log("IPPure 风险评分获取失败");
    return null;
  }

  async function tryScamalytics() {
    const html = await httpRaw(CONFIG.urls.scamalytics(ip));
    const score = parseScamalyticsScore(html);
    if (score !== null) return saveAndReturn(score, "Scamalytics");
    IPLog.log("Scamalytics 失败: " + (html ? "解析失败" : "请求失败"));
    return null;
  }

  const tryMap = { ipqs: tryIPQS, proxycheck: tryProxyCheck, ippure: tryIPPure, scamalytics: tryScamalytics };
  if (api && !tryMap[api]) IPLog.log("未知 risk_api: " + api + "，走四级回落");

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
  IPLog.log("风险评分：所有数据源均失败，显示未知（不缓存）");
  return { score: null, source: "Unavailable" };
}

// ==================== IP 类型检测（二级回落） ====================
// Surge IP 类型是数据源对当前地址的分类，可能变化；按出口 IP 最多缓存 24 小时，
// 避免面板自动刷新反复消耗 IPPure 额度
async function getIPType(ip) {
  const cached = $persistentStore.read(CONFIG.storeKeys.ipTypeCache);
  if (cached) {
    try {
      const c = JSON.parse(cached);
      const age = Math.floor(Date.now() / 1000) - (c.ts || 0);
      if (c.ip === ip && age < CONFIG.riskCacheTTL) {
        IPLog.log("IP 类型命中缓存: " + c.ipType + " | " + c.ipSrc + "，已缓存 " + age + "s");
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
    IPLog.log("IPPure /v1/info 返回 IP 类型数据");
    return saveAndReturn(
      info.isResidential ? "住宅 IP" : "机房 IP",
      info.isBroadcast ? "广播 IP" : "原生 IP"
    );
  }
  IPLog.log("IPPure /v1/info 未返回 IP 类型，回落到 /v1/card");

  const html = await getIPPureCard();
  if (html) {
    const ipType = /住宅|[Rr]esidential/.test(html) ? "住宅 IP" : "机房 IP";
    const ipSrc = /广播|[Bb]roadcast|[Aa]nnounced/.test(html) ? "广播 IP" : "原生 IP";
    IPLog.log("IPPure /v1/card 抓取结果: " + ipType + " | " + ipSrc);
    return saveAndReturn(ipType, ipSrc);
  }

  // IPPure 全部失败后读取 ProxyCheck type；本轮已有请求则复用，否则发起一次。
  const pc = await getProxyCheck(ip);
  const pcType = pc?.[ip]?.type;
  if (pcType) {
    const ipType = /residential|wireless|mobile/i.test(pcType) ? "住宅 IP" : "机房 IP";
    IPLog.log("ProxyCheck type 回退: " + pcType + " → " + ipType);
    return saveAndReturn(ipType, "未知");
  }

  IPLog.log("IPPure/ProxyCheck 所有接口均失败");
  return { ipType: "未知", ipSrc: "未知" };
}

// ==================== DNS 泄露检测 ====================
async function checkDNSLeak(policy, deadline) {
  const c = "abcdefghijklmnopqrstuvwxyz0123456789";
  function randStr(len) { let s = ""; for (let i = 0; i < len; i++) s += c[Math.floor(Math.random() * c.length)]; return s; }

  // edns.ip-api.com：随机子域触发 DNS 查询，服务端返回解析器 IP 和地理信息
  const ednsData = await httpJSON(CONFIG.urls.dnsLeakEdns(randStr(32)), policy, null, deadline);
  if (!ednsData?.dns) {
    IPLog.log("DNS 泄露检测失败");
    return { leaked: null, resolvers: null };
  }
  const ip = ednsData.dns.ip || "";
  const geo = ednsData.dns.geo || "";
  const isChina = /China|中国/i.test(geo);
  const name = (geo.includes(" - ") ? geo.split(" - ").pop().trim() : (geo || ip)).replace(/\s*communications\s+corporation/gi, "");
  const resolvers = ip ? [{ ip, name, geo, isChina }] : [];
  // 既有启发式：解析器位于中国即作提示；未比较本地 ISP，不能证明有/无 DNS 泄露。
  const leaked = isChina;
  IPLog.log("DNS 解析器: " + (resolvers.length ? resolvers[0].name + (isChina ? " [CN]" : "") : "无"));
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
    IPLog.log("流量统计获取失败");
    return null;
  }
  IPLog.log("流量统计原始数据: " + JSON.stringify(data).slice(0, 300));

  // Surge 返回 interface 为嵌套字典 { en0: {...}, pdp_ip0: {...}, lo0: {...} }
  let network = null;
  if (data.interface && typeof data.interface === "object") {
    const keys = Object.keys(data.interface).filter(k => k !== "lo0");
    if (keys.length > 0) {
      network = data.interface[keys[0]];
      IPLog.log("使用网卡: " + keys[0]);
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

// 官方 IPPure Tile 使用的地理字段；只用于同一次响应确认的出口。
function normalizeStashIPPure(data) {
  const text = value => typeof value === "string" ? value.trim() : "";
  const code = text(data.countryCode).toUpperCase();
  return {
    country_code: /^[A-Z]{2}$/.test(code) ? code : "",
    country_name: text(data.country), city: text(data.city), region: text(data.region),
    org: text(data.asOrganization)
  };
}

// 按 Stash 官方 IPPure 卡片：请求经当前检测节点，IP、评分和类型来自它的响应。
// 缺少相应地址族时才用 ipify 补充 IP，不用另一站点的地址否定 IPPure 评分。
async function probeStashOutbound4() {
  const info = await getIPPureInfo();
  if (finished) return null;
  const ip = stashCacheIP(info?.ip);
  if (ip && !ip.includes(":")) return { ip };
  if (requestDeadline - Date.now() < 100) return null;
  const deadline = Math.min(requestDeadline, Date.now() + CONFIG.stashIPv4Timeout);
  IPLog.log("IPPure 未提供有效 IPv4，使用 ipify 备用探测");
  const backup = await httpJSON(CONFIG.urls.stashIPv4, null, null, deadline);
  if (finished) return null;
  const backupIP = stashCacheIP(backup?.ip);
  return backupIP && !backupIP.includes(":") ? { ip: backupIP } : null;
}

async function probeStashOutbound6() {
  const info = await getIPPureInfo();
  if (finished) return null;
  const pureIP = stashCacheIP(info?.ip);
  if (pureIP.includes(":")) return pureIP;
  const deadline = Date.now() + CONFIG.ipv6Timeout;
  const data = await httpJSON(CONFIG.urls.stashIPv6, null, null, deadline);
  if (finished) return null;
  const ip = stashCacheIP(data?.ip);
  if (ip.includes(":")) return ip;
  IPLog.log("IPv6 未探测到有效地址，仅展示 IPv4");
  return null;
}

// Surge 保持原有 Cloudflare trace → ip.sb。
async function fetchOutbound4() {
  if (isStash) {
    return probeStashOutbound4();
  }
  const t = parseTrace(await httpRaw(CONFIG.urls.outboundTrace));
  if (t) return { ip: t.ip, raw: { country_code: t.loc, country: t.loc } };
  IPLog.log("CF trace(v4) 失败，回落 ip.sb");
  const sb = await httpJSON(CONFIG.urls.outboundIP);
  return sb?.ip ? { ip: sb.ip, raw: sb } : null;
}

async function fetchOutbound6() {
  if (isStash) {
    return probeStashOutbound6();
  }
  const deadline = Date.now() + CONFIG.ipv6Timeout;
  const t = parseTrace(await httpRaw(CONFIG.urls.outboundTrace6, null, null, deadline));
  if (t) return t.ip;
  IPLog.log("CF trace(v6) 失败，回落 ip.sb");
  const sb = await httpJSON(CONFIG.urls.outboundIPv6, null, null, deadline);
  return sb?.ip || null;
}

async function fetchIPs() {
  const [local, exit, exit6ip] = await Promise.all([
    httpJSON(CONFIG.urls.localIP, "DIRECT"),
    fetchOutbound4(),
    !isStash && hasTimers ? Promise.race([
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
    IPLog.log("网络信息未变化，跳过");
    return false;
  }

  IPLog.log("网络信息已变化");
  $persistentStore.write(JSON.stringify({ localIP, outIP, outIPv6 }), CONFIG.storeKeys.lastEvent);
  return true;
}

// Stash 通知专用上下文：不读取/写入节点测试卡片的记录。
// 各 IP 字段独立建立基线；失败字段沿用旧值，不妨碍其他有效变化。
async function runStashMonitor() {
  if (!args.notify || (typeof $script !== "undefined" && $script.type === "tile")) return done({});
  const current = await fetchIPs();
  if (finished) return;
  const key = "stash.ip-security.monitor.v2:" + encodeURIComponent(args.proxy || "routing");
  let previous = {};
  try { previous = JSON.parse($persistentStore.read(key) || "{}"); } catch (_) {}
  if (!previous || typeof previous !== "object" || Array.isArray(previous)) previous = {};
  const next = { ...previous };
  let changed = false;
  for (const field of ["outIP", "localIP", "outIPv6"]) {
    const value = current[field];
    if (!value) continue;
    if (previous[field] && previous[field] !== value) {
      changed = true;
    }
    next[field] = value;
  }
  if (changed) {
    if (typeof $notification === "undefined" || typeof $notification.post !== "function") {
      IPLog.log("当前客户端未提供通知接口；保留基线供下次重试");
      return done({});
    }
    // 仅变化后补查详情，沿用本轮 IP/IPPure 响应，不再探测一遍出口。
    const results = await Promise.allSettled([
      getStashLocalResult(current.localRaw),
      current.outIP ? getStashOutboundResult(false, { ip: current.outIP, raw: current.outRaw }) : null,
      current.outIP ? getStashRiskResult() : null
    ]);
    if (finished) return;
    const [local, outbound, risk] = results.map(result => result.status === "fulfilled" ? result.value : null);
    const sameRisk = risk?.ip === current.outIP ? risk : null;
    const m = ip => ip ? maskIP(ip, args.maskIP) : "查询失败";
    const detail = info => (info?.location ? formatGeo(info.countryCode, info.location) : "地区查询失败") +
      " · " + (info?.organization || "运营商未知");
    const title = "🔄 网络已切换" + (args.proxy ? " | " + args.proxy : "");
    const subtitle = "Ⓓ " + m(current.localIP) + " 🅟 " + m(current.outIP);
    const lines = ["Ⓓ " + detail(local), "🅟 " + detail(outbound)];
    if (current.outIPv6) lines.push("🅟 IPv6：" + m(current.outIPv6));
    lines.push("🅟 风控：" + (sameRisk?.valid ? formatRisk(sameRisk) : "未知（检测失败）") +
      " | 类型：" + (sameRisk?.typeText || "类型未知 · 来源未知"));
    try { $notification.post(title, subtitle, lines.join("\n")); }
    catch (_) { IPLog.log("通知发送失败；保留基线供下次重试"); return done({}); }
  }
  if (Object.keys(next).length) {
    try { $persistentStore.write(JSON.stringify(next), key); }
    catch (_) { IPLog.log("通知记录保存失败"); }
  }
  done({});
}

// IP 校验供出口确认及风险字段缓存共用；地区与运营商不使用历史字段缓存。
function stashCacheIP(value) {
  if (typeof value !== "string") return "";
  const ip = value.trim().toLowerCase();
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
    return ip.split(".").every(n => Number(n) <= 255) ? ip : "";
  }
  // IPv6 缓存键保留地址写法；不同等价写法最多造成未命中，不会串用地址。
  if (!/^[0-9a-f:]+$/.test(ip) || ip.includes(":::") ||
    (ip.startsWith(":") && !ip.startsWith("::")) ||
    (ip.endsWith(":") && !ip.endsWith("::"))) return "";
  const halves = ip.split("::"), groups = ip.split(":").filter(Boolean);
  if (halves.length > 2 || !groups.every(n => /^[0-9a-f]{1,4}$/.test(n))) return "";
  return halves.length === 2 ? (groups.length < 8 ? ip : "") :
    (groups.length === 8 && !ip.startsWith(":") && !ip.endsWith(":") ? ip : "");
}

function stashFields(values, ts = Date.now()) {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value, ts }]));
}

function stashLastGood(kind, ip, fresh, fallback = {}) {
  const key = "stash.ip-security.last-good.v1", ttl = 86400000, now = Date.now();
  const address = stashCacheIP(ip), id = kind + ":" + address;
  const valid = (name, value) => name === "score" ?
    typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 :
    ["isResidential", "isBroadcast"].includes(name) ? typeof value === "boolean" :
    name === "countryCode" ? typeof value === "string" && /^[A-Z]{2}$/.test(value) :
    typeof value === "string" && !!value.trim();
  const usable = (name, field) => field && Number.isFinite(field.ts) &&
    now - field.ts >= 0 && now - field.ts < ttl && valid(name, field.value);
  let entries = {};
  try {
    const stored = JSON.parse($persistentStore.read(key) || "{}");
    if (stored && typeof stored === "object" && !Array.isArray(stored)) entries = stored;
  } catch (_) {}
  const previous = address ? entries[id]?.fields || {} : {};
  const fields = {}, data = {};
  let cached = false;
  for (const name of Object.keys(fresh)) {
    let field = fresh[name];
    if (!usable(name, field)) {
      if (usable(name, previous[name])) { field = previous[name]; cached = true; }
      else field = fallback[name];
    }
    if (usable(name, field)) { fields[name] = field; data[name] = field.value; }
  }
  if (address && Object.keys(fields).length) {
    // 沿用每个字段原始时间；失败刷新不延长旧数据寿命，也不覆盖其他 IP。
    const ts = Math.max(...Object.values(fields).map(field => field.ts));
    const retained = Object.entries(entries).filter(([entry, value]) => entry !== id &&
      Number.isFinite(value?.ts) && now - value.ts >= 0 && now - value.ts < ttl);
    retained.push([id, { ts, fields }]);
    retained.sort((a, b) => a[1].ts - b[1].ts);
    try { $persistentStore.write(JSON.stringify(Object.fromEntries(retained.slice(-32))), key); }
    catch (_) { IPLog.log("上次成功结果保存失败，继续显示本次结果"); }
  }
  if (cached) IPLog.log("[IP 缓存] " + kind + "：复用同一 IP 的上次成功字段");
  return { data, cached };
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
    IPLog.log("通知已禁用 (notify=false)，跳过推送");
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
  IPLog.log("=== 已发送通知 ===");
}

// ==================== Stash 独立卡片 ====================
// 按选定数据源获取元数据，不调用 Surge API；无 JS 定时器时使用客户端请求超时。
// 默认风险和类型取自同一次 IPPure 响应；其他风险源查询同一 IP，不用另一站点的出口代替。
// 折叠卡片保留简短地区/运营商摘要，风险等级与颜色共用 Surge 的配置。
// Android 用标题第二行显示 IP；iOS 标题也只有一行，改用标记与 IP 同行。
function compactStashLocation(location, local = false) {
  const value = String(location || "").trim();
  const compact = local ? value.replace(/^中国/, "").replace(/^.*?(?:省|自治区)/, "")
    .replace(/(?:特别行政区|市).*$/, "") : value.replace(/市$/, "");
  return compact || value;
}

function compactStashOrg(organization) {
  const value = String(organization || "运营商未知").replace(/^AS\d+\s+/, "")
    .replace(/\s+(?:(?:Co\.?[,]?\s*)?Ltd\.?|Limited|Inc\.?|LLC|Corporation)\.?$/i, "").trim();
  if (isStashiOS) {
    // iOS 正文只有一行，常见中国运营商用短名称，包含香港等地区的同品牌出口。
    const carriers = [
      [/中国移动|\bChina\s*Mobile\b/i, "中国移动"],
      [/中国联通|\bChina\s*Unicom\b/i, "中国联通"],
      [/中国电信|\bChina\s*Telecom\b/i, "中国电信"],
      [/中国广电|\bChina\s*(?:Broadnet|Broadcasting(?:\s*Network)?)\b/i, "中国广电"]
    ];
    for (const [pattern, label] of carriers) if (pattern.test(value)) return label;
  }
  return value;
}

function compactStashIPContent({ shortLocation, organization, countryCode }, fallbackCountryCode) {
  const code = countryCode || fallbackCountryCode;
  const location = code === "CN" ? String(shortLocation || "").replace(/[省市]$/, "") : shortLocation;
  let org = compactStashOrg(organization);
  // 按去掉省/市后的地区字数缩短中国运营商；两字及以下保留“中国”。
  if (code === "CN" && Array.from(location || "").length > 2) org = org.replace(/^中国/, "");
  return [[flag(code), location || "地区查询失败"].filter(Boolean).join(" "), org].join(" · ");
}

async function getStashRiskResult() {
  // 按官方脚本读取当前 IPPure 响应；不再额外探测 CF/ipify 后拦截评分。
  const info = await getIPPureInfo();
  if (!info && args.riskApi === "ippure") return null;
  const pureIP = stashCacheIP(info?.ip) || (args.riskApi !== "ippure" ? (await fetchOutbound4())?.ip : "");
  const freshScore = typeof info?.fraudScore === "number" ? info.fraudScore :
    (typeof info?.fraudScore === "string" && info.fraudScore.trim() ? Number(info.fraudScore) : NaN);
  const { data } = stashLastGood("risk", pureIP, stashFields({
    score: freshScore, isResidential: info?.isResidential, isBroadcast: info?.isBroadcast
  }));
  const selected = args.riskApi !== "ippure" && pureIP ? await getRiskScore(pureIP) : null;
  const score = args.riskApi === "ippure" ? data.score : selected?.score;
  const source = args.riskApi === "ippure" ? "IPPure" : selected?.source || "Unavailable";
  const valid = Number.isFinite(score) && score >= 0 && score <= 100;
  const ipType = typeof data.isResidential === "boolean" ? (data.isResidential ? "住宅 IP" : "机房 IP") : "类型未知";
  const ipSrc = typeof data.isBroadcast === "boolean" ? (data.isBroadcast ? "广播 IP" : "原生 IP") : "来源未知";
  const { label: level, color } = riskText(valid ? score : null);
  const detail = valid ? formatRisk({ score, source }) : "暂无有效评分";
  const typeText = [ipType.replace(/ IP$/, ""), ipSrc.replace(/ IP$/, "")].join(" · ");
  return { ip: pureIP, score, source, valid, level, color, riskText: detail, typeText };
}

async function getStashLocalResult(local) {
  if (local === undefined) local = await httpJSON(CONFIG.urls.localIP, "DIRECT");
  const ip = local?.data?.addr;
  if (!ip) return null;
  const source = ["baidu", "bilibili", "ipsb"].includes(args.localGeoApi) ? args.localGeoApi : "baidu";
  const [baidu, sb] = await Promise.all([
    source === "baidu" ? httpJSON(CONFIG.urls.baiduGeo(ip), "DIRECT", null, Date.now() + 5000) : null,
    httpJSON(CONFIG.urls.ipSbGeo(ip), "DIRECT", null, Date.now() + 5000)
  ]);
  const sbInfo = normalizeIpSb(sb);
  const primary = source === "baidu" ? normalizeOpendata(baidu)
    : source === "bilibili" ? normalizeBilibili(local) : sbInfo;
  if (source === "baidu" && primary && /^(移动|联通|电信|广电)$/.test(primary.org)) primary.org = "中国" + primary.org;
  // 与 Surge 相同：选定本地源失败后使用本轮 ip.sb，不混入 bilibili 或旧字段。
  const info = primary && source !== "ipsb" ? { ...primary, country_code: sbInfo?.country_code || "CN" }
    : primary || sbInfo;
  if (!primary && info) IPLog.log("本地地区：" + source + " 不可用，使用本轮 ip.sb 结果");
  return {
    ip, countryCode: info?.country_code,
    location: info && [...new Set([info.country_name, info.region, info.city].filter(Boolean))].join(" "),
    shortLocation: info && compactStashLocation(info.city || info.region || info.country_name, true),
    organization: info?.org
  };
}

async function getStashOutboundResult(includeIPv6, detectedExit) {
  // 折叠卡片不探测 IPv6；地区与运营商的数据源优先级和首页、通知一致。
  const ipv6 = includeIPv6 ? fetchOutbound6() : Promise.resolve(null);
  const pure = getIPPureInfo();
  const exit = detectedExit || await fetchOutbound4();
  const outIP = exit?.ip, outRaw = exit?.raw;
  if (!outIP) return null;
  const pureInfo = await pure;
  const sameIPPure = stashCacheIP(pureInfo?.ip) === outIP ? normalizeStashIPPure(pureInfo) : null;
  const pureHasLocation = !!(sameIPPure?.city || sameIPPure?.region || sameIPPure?.country_name || sameIPPure?.country_code);
  // IPPure 仍可显式选作地区源；默认使用同一出口 IP 的 ipapi-zh。
  const usePure = args.remoteGeoApi === "ippure" && pureHasLocation;
  let source = ["ipinfo", "ipapi", "ipapi-zh", "maxmind", "maxmind-zh"].includes(args.remoteGeoApi)
    ? args.remoteGeoApi : "ipapi-zh";
  if (source.startsWith("maxmind") && !args.maxmindKey) {
    IPLog.log("remote_geoapi=maxmind 未填写凭据，回落 ipinfo");
    source = "ipinfo";
  }
  const maxmind = source.startsWith("maxmind");
  const normalizeGeo = value => maxmind ? normalizeMaxmind(value, source === "maxmind-zh")
    : source === "ipinfo" ? normalizeIpInfo(value) : normalizeIpApi(value);
  // 所有卡片都查询 ipinfo；作为地区源时共用这一个请求。
  const ipinfo = httpJSON(CONFIG.urls.ipInfo(outIP), undefined, null, Date.now() + 5000);
  const [geo, org, outIPv6] = await Promise.all([
    usePure ? null : source === "ipinfo" ? ipinfo : httpJSON(
      maxmind ? CONFIG.urls.maxmindGeo(outIP) : CONFIG.urls.ipApi(outIP, source === "ipapi-zh" ? "zh-CN" : "en"),
      undefined, maxmind ? { Authorization: "Basic " + b64(args.maxmindKey) } : null, Date.now() + 5000),
    ipinfo,
    ipv6
  ]);
  const primaryInfo = usePure ? sameIPPure : normalizeGeo(geo);
  // 与 Surge 相同：地区源失败后只取本轮出口探测已有地区，不改用运营商源的地区。
  // Stash 的出口来自 IPPure / ipify，因此仅复用已确认同一 IP 的 IPPure 地区。
  const probeInfo = sameIPPure?.country_code ? sameIPPure : normalizeIpSb(outRaw);
  const info = primaryInfo || probeInfo;
  const orgInfo = normalizeIpInfo(org);
  if (info && orgInfo?.org) info.org = orgInfo.org;
  if (!primaryInfo && info) IPLog.log("出口地区：" + source + " 不可用，使用本轮出口探测的地区");
  return {
    ip: outIP, ipv6: outIPv6, raw: outRaw, countryCode: info?.country_code,
    location: info && [...new Set([info.city, info.region, geoLabel(info) || info.country_name].filter(Boolean))].join(", "),
    shortLocation: info && compactStashLocation(["HK", "MO", "SG"].includes(info.country_code) ?
      geoLabel(info) : info.city || info.region || geoLabel(info) || info.country_name),
    organization: info?.org || "运营商未知",
    reverseDNS: typeof org?.hostname === "string" ? org.hostname.trim() : ""
  };
}

// 首页聚合卡片：各项并行检测，某一项失败不抹掉其他成功结果。
// 地区和运营商与折叠卡片使用相同回退顺序；风险阈值及配色保持一致。
async function runStashSummary() {
  const results = await Promise.allSettled([
    getStashRiskResult(), getStashLocalResult(), getStashOutboundResult(true),
    checkDNSLeak(args.proxy || undefined, Date.now() + 1500)
  ]);
  const [risk, local, outbound, dns] = results.map(result => result.status === "fulfilled" ? result.value : null);
  const m = ip => maskIP(ip, args.maskIP);
  const region = info => info?.location ? [flag(info.countryCode), info.location].filter(Boolean).join(" ") : "查询失败";
  const lines = [
    "IP 风控值：" + (risk?.valid ? formatRisk(risk) : "暂无有效评分"),
    "IP 类型：" + (risk?.typeText || "类型未知 · 来源未知"),
    "",
    "本地 IP：" + (local?.ip ? m(local.ip) : "查询失败"),
    "地区：" + region(local),
    "运营商：" + (local?.organization || "Unknown"),
    ""
  ];
  if (outbound?.ipv6) {
    lines.push("出口 IP⁴：" + m(outbound.ip), "出口 IP⁶：" + m(outbound.ipv6));
  } else {
    lines.push("出口 IP：" + (outbound?.ip ? m(outbound.ip) : "查询失败"));
  }
  lines.push("地区：" + region(outbound), "运营商：" + (outbound?.organization || "Unknown"));
  if (outbound?.reverseDNS) lines.push("rDNS：" + (args.maskIP ? "[已隐藏]" : outbound.reverseDNS));
  const resolver = dns?.resolvers?.[0];
  lines.push("", "DNS 解析器：" + (resolver ? m(resolver.ip) : "查询失败"));
  if (resolver?.geo) lines.push("DNS 地区：" + resolver.geo);
  // 地区不能证明是否泄露；proxy 只代表调用者显式指定的策略，不推断实际节点。
  if (args.proxy) lines.push("指定策略：" + args.proxy);
  return done({
    title: "IP 信息卡", content: lines.join("\n"),
    backgroundColor: risk?.color || "#9E9E9E", url: "https://ippure.com"
  });
}

async function runStashTile() {
  if (args.tile === "summary") return runStashSummary();
  const tile = stashTiles[args.tile];
  if (!tile) return done({ content: "未知卡片类型" });
  const fail = message => done({
    title: args.mode === "collapsed" && isStashiOS && tile.marker ? tile.marker : tile.title,
    content: message, backgroundColor: "#9E9E9E"
  });
  const render = (lines, color = tile.color, compact = null, url) => done({
    content: lines.filter(Boolean).join("\n"), backgroundColor: color, url,
    ...(args.mode === "collapsed" && compact ? compact : {})
  });
  const m = ip => maskIP(ip, args.maskIP);
  const heading = (detail) => [isStashiOS ? tile.marker : tile.title, detail].filter(Boolean)
    .join(isStashiOS ? " " : "\n");

  if (args.tile === "risk") {
    const result = await getStashRiskResult();
    if (!result) return fail("风险评分检测失败");
    const { color, riskText, typeText, valid, score, level } = result;
    const percentText = valid ? score + "% " + level : riskText;
    return render([
      typeText,
      riskText
    ], color, {
      // iOS 标题只放百分比；Android 保留标题第二行，正文均放类型。
      title: heading(percentText),
      content: typeText
    }, args.maskIP === 0 && result.ip ? "https://ippure.com/?ip=" + encodeURIComponent(result.ip) : undefined);
  }

  if (args.tile === "local") {
    const result = await getStashLocalResult();
    if (!result) return fail("无法获取直连公网 IP");
    const { ip, countryCode, location, organization } = result;
    return render([
      m(ip),
      location ? [flag(countryCode), location].filter(Boolean).join(" ") : "地区查询失败",
      organization || "运营商未知"
    ], location ? tile.color : "#9E9E9E", {
      title: heading(m(ip)),
      content: location ? compactStashIPContent(result) : "地区查询失败"
    }, args.maskIP === 0 ? "https://ippure.com/?ip=" + encodeURIComponent(ip) : undefined);
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

  const result = await getStashOutboundResult(args.mode === "home");
  if (!result) return fail("无法获取出口 IPv4");
  const { ip: outIP, ipv6: outIPv6, raw: outRaw, location, countryCode, organization } = result;
  const lines = [m(outIP), outIPv6 ? "IPv6：" + m(outIPv6) : "",
    location ? [flag(countryCode), location].filter(Boolean).join(" ") : "地区查询失败", organization];
  if (args.mode === "home" && result.reverseDNS) lines.push("rDNS：" + (args.maskIP ? "[已隐藏]" : result.reverseDNS));
  if (args.mode === "home" && args.proxy) lines.push("指定策略：" + args.proxy);
  return render(lines, location ? tile.color : "#9E9E9E", {
    title: heading(m(outIP)),
    content: compactStashIPContent(result, outRaw?.country_code)
  });
}

// ==================== 主执行函数 ====================
(async () => {
  try {
  if (isStash && args.task === "logs") {
    IPLog.collect();
    return done({});
  }
  IPLog.log("=== IP 安全检测开始 (v6.4.10 / " + (isStash ? "Stash / " + (args.task || args.tile) + " / " + args.mode : "Surge") + ") ===");
  if (isStash) IPLog.log("请求线路：本地 DIRECT；出口 " + (args.proxy ? "使用参数指定的策略" : "遵循当前分流（长按测试时使用所选节点）"));
  if (isStash) return args.task === "monitor" ? await runStashMonitor() : await runStashTile();

  // 1. EVENT 触发时延迟等待网络稳定
  if (args.isEvent && args.eventDelay > 0) {
    IPLog.log("等待网络稳定 " + args.eventDelay + " 秒");
    await wait(args.eventDelay * 1000);
  }

  // 2. 获取本地/出口 IP
  const { localIP, outIP, outIPv6, localRaw, outRaw } = await fetchIPs();

  if (!localIP || !outIP) {
    IPLog.log("IP 获取失败");
    return done({ title: "IP 获取失败", content: "无法获取本地或出口 IPv4", icon: "leaf", "icon-color": "#9E9E9E" });
  }
  IPLog.log("本地 IP: " + localIP + ", 出口 IP: " + outIP);

  // 3. EVENT 模式下检查 IP 是否变化
  if (!checkIPChange(localIP, outIP, outIPv6)) {
    return done({});
  }

  // 4. 并行获取：代理策略+入口 IP、风险评分、IP 类型、地理信息
  let localGeoApi = args.localGeoApi;
  if (!["bilibili", "baidu", "ipsb"].includes(localGeoApi)) {
    IPLog.log("未知 local_geoapi: " + localGeoApi + "，使用 baidu");
    localGeoApi = "baidu";
  }
  const useBilibili = localGeoApi === "bilibili";
  const useBaiduLocal = localGeoApi === "baidu";
  const localZh = useBilibili || useBaiduLocal; // 本地地理为中文源 → 显示中文国名

  // 入口/出口地理数据源：remote_geoapi=ipinfo → ipinfo.io, ipapi/ipapi-zh → ip-api.com(en/zh, http 明文),
  // maxmind/maxmind-zh → GeoLite2(en/zh, 需 key)
  let remoteGeoApi = args.remoteGeoApi;
  if (!["ipinfo", "ipapi", "ipapi-zh", "maxmind", "maxmind-zh"].includes(remoteGeoApi)) {
    IPLog.log("未知 remote_geoapi: " + remoteGeoApi + "，使用 ipapi-zh");
    remoteGeoApi = "ipapi-zh";
  }
  const useIpApi = remoteGeoApi.startsWith("ipapi");
  let useMaxmind = remoteGeoApi.startsWith("maxmind");
  const maxmindZh = remoteGeoApi === "maxmind-zh";
  if (useMaxmind && !args.maxmindKey) {
    IPLog.log("remote_geoapi=maxmind 需要 maxmind_key（account_id:license_key），回落 ipinfo");
    useMaxmind = false;
  }
  const ipApiLang = remoteGeoApi === "ipapi-zh" ? "zh-CN" : "en";
  // 非 ipinfo 数据源时补查 ipinfo：优先取运营商与 hostname，失败仍保留可用的地理源字段。
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

  // 请求完成后查询 recent，提高捕获概率；记录仍可能缺失，内部会重试并降级。
  const { policy, entranceIP } = await getPolicyAndEntrance();

  // 当前仅在识别到代理策略时探测 DNS 解析器，并将请求指定到该策略。
  const isDirect = !policy || policy === "DIRECT" || policy === "Unknown";
  let dnsLeakResult = null;
  if (!isDirect) {
    dnsLeakResult = await checkDNSLeak(policy);
  } else {
    IPLog.log("当前为直连，跳过 DNS 泄露检测");
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

  // 出口地区优先使用 remote_geoapi，缺失时取探测结果；有 ipinfo 运营商字段才覆盖。
  // IPv6 只显示 IP 地址，不单独查询地区和运营商
  let outInfo = normalizeGeo(outGeoRaw) || normalizeIpSb(outRaw);
  // 反向 DNS：从 ipinfo.io 响应中提取 hostname
  // ipinfo 模式: outGeoRaw 来自 ipinfo.io; 其余数据源: outOrgRaw 来自 ipinfo.io
  const ipinfoRaw = needExtraOrg ? outOrgRaw : outGeoRaw;
  const reverseDNS = ipinfoRaw?.hostname || null;
  if (reverseDNS) IPLog.log("反向 DNS: " + reverseDNS);
  if (needExtraOrg && outInfo) {
    const orgData = normalizeIpInfo(outOrgRaw);
    if (orgData?.org) outInfo.org = orgData.org;
  }

  // 入口 IP 地理信息：与出口不同时才查询
  let entranceInfo = null;
  if (entranceIP && entranceIP !== outIP) {
    IPLog.log("入口 IP: " + entranceIP + " 与出口 IP 不同，查询入口地理信息");
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
    IPLog.log("=== 面板显示 ===");
    done({
      title: "代理策略：" + policy,
      content: buildPanelContent(context),
      icon: "leaf.fill",
      "icon-color": riskResult.color
    });
  }
  } catch (e) {
    IPLog.log("未捕获异常: " + (e.message || e));
    done({ title: "检测异常", content: e.message || String(e), icon: "leaf", "icon-color": "#9E9E9E" });
  }
})();
