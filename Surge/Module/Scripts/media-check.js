/**
 * =============================================================================
 * 流媒体 & AI 服务解锁检测脚本 - Surge Panel / Stash Tiles
 * =============================================================================
 * @description  检测代理节点对各大流媒体、AI 和社交平台的解锁状态
 * @version      2.2.5 (2026-09-30)
 * @source       https://github.com/HotKids/Rules/blob/master/Surge/Module/Scripts/media-check.js
 * @reference    https://github.com/StashNetworks/misc/tree/main/collapsed-tiles
 *               https://github.com/oneclickvirt/UnlockTests/tree/main/transnation
 * @runtime      自动识别 Surge / Stash；检测逻辑共用，面板与请求参数分别适配
 * @arguments    service=netflix&nfprice=true&notify=false
 *               service 可选 netflix/disney/hbomax/youtube/spotify/tiktok/chatgpt/claude/gemini/metaai/reddit
 *               Stash 不传 service 或传 service=all 时汇总；Surge 始终使用多行汇总
 *               mode=collapsed 由 Stash 选择检测节点，忽略 proxy 并关闭变化通知
 *               可选 proxy=URL编码后的节点名、notifykey=自定义通知分组
 * @routing      默认遵循所在客户端分流；proxy 指定代理，Stash 折叠模式由所选节点接管。
 * @author       HotKids & ChatGPT & Claude
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 📋 支持的服务（11 项）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 🎬 流媒体
 *    ├─ Netflix       含价格显示（可选关闭）、多级地区码提取
 *    ├─ Disney+       统一按地区与接口可用性判断
 *    ├─ HBO Max       官网结构化地区与可用性检测、第三方平台提示（JP/KR/CA）
 *    ├─ YouTube       明确可用性检测，未知时 Cookie 回落
 *    ├─ Spotify       标准地区检测
 *    └─ TikTok        Explore / 主页地区检测
 *
 * 🤖 AI 服务
 *    ├─ ChatGPT       单行显示地区 / Web Only / Mobile Only / NO
 *    ├─ Claude        地区可用性检测
 *    ├─ Gemini        网页检测 + API Key fallback
 *    └─ Meta AI       AJAX 可用性与主页回落检测
 *
 * 🌐 社交 & 其他
 *    └─ Reddit        地区访问检测
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚙️ 参数配置
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * • geminiapikey=YOUR_KEY    Gemini API Key（可选，增强检测准确性）
 * • nfprice=false            关闭 Netflix 价格显示（默认开启）
 * • viu=true                 仅 Surge：开启 Viu 检测，仅可用时显示（默认关闭）
 * • notify=true              解锁状态变化推送（默认关闭）：可用性或区域变化时通知，
 *                            超时/错误视为未知不触发，首次运行仅记录基线
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 🎨 状态指示
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 🟢 所有服务均可用
 * 🟡 部分服务不可用 / 受限 / 超时
 *
 * =============================================================================
 */

// 优先使用客户端的环境标识；tile 类型兼容未提供 Stash 版本标识的运行环境。
const ENV = typeof $environment === "object" && $environment ? $environment : {};
const IS_STASH = !!(ENV["stash-version"] || ENV["stash-build"] ||
  (!(ENV["surge-version"] || ENV["surge-build"]) && typeof $script === "object" && $script?.type === "tile"));

function finishPanel({ backgroundColor, ...panel }) {
  panel[IS_STASH ? "backgroundColor" : "icon-color"] = backgroundColor;
  $done(panel);
}

// 全局配置常量
const CONFIG = {
  VERSION: "2.2.5",
  UA: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  TIMEOUT: 8000,
  CHROME_VERSION: "131.0.6778"
};

// 检测状态码定义
const STATUS = { OK: 1, COMING: 2, FAIL: 0, TIMEOUT: -1, ERROR: -2 };

// ISO 3166 地区映射；避免把 KOR / AUT 等三位码直接截断。
const COUNTRY_CODES = Object.fromEntries(
  "AD:AND AE:ARE AF:AFG AG:ATG AI:AIA AL:ALB AM:ARM AO:AGO AQ:ATA AR:ARG AS:ASM AT:AUT AU:AUS AW:ABW AX:ALA AZ:AZE BA:BIH BB:BRB BD:BGD BE:BEL BF:BFA BG:BGR BH:BHR BI:BDI BJ:BEN BL:BLM BM:BMU BN:BRN BO:BOL BQ:BES BR:BRA BS:BHS BT:BTN BV:BVT BW:BWA BY:BLR BZ:BLZ CA:CAN CC:CCK CD:COD CF:CAF CG:COG CH:CHE CI:CIV CK:COK CL:CHL CM:CMR CN:CHN CO:COL CR:CRI CU:CUB CV:CPV CW:CUW CX:CXR CY:CYP CZ:CZE DE:DEU DJ:DJI DK:DNK DM:DMA DO:DOM DZ:DZA EC:ECU EE:EST EG:EGY EH:ESH ER:ERI ES:ESP ET:ETH FI:FIN FJ:FJI FK:FLK FM:FSM FO:FRO FR:FRA GA:GAB GB:GBR GD:GRD GE:GEO GF:GUF GG:GGY GH:GHA GI:GIB GL:GRL GM:GMB GN:GIN GP:GLP GQ:GNQ GR:GRC GS:SGS GT:GTM GU:GUM GW:GNB GY:GUY HK:HKG HM:HMD HN:HND HR:HRV HT:HTI HU:HUN ID:IDN IE:IRL IL:ISR IM:IMN IN:IND IO:IOT IQ:IRQ IR:IRN IS:ISL IT:ITA JE:JEY JM:JAM JO:JOR JP:JPN KE:KEN KG:KGZ KH:KHM KI:KIR KM:COM KN:KNA KP:PRK KR:KOR KW:KWT KY:CYM KZ:KAZ LA:LAO LB:LBN LC:LCA LI:LIE LK:LKA LR:LBR LS:LSO LT:LTU LU:LUX LV:LVA LY:LBY MA:MAR MC:MCO MD:MDA ME:MNE MF:MAF MG:MDG MH:MHL MK:MKD ML:MLI MM:MMR MN:MNG MO:MAC MP:MNP MQ:MTQ MR:MRT MS:MSR MT:MLT MU:MUS MV:MDV MW:MWI MX:MEX MY:MYS MZ:MOZ NA:NAM NC:NCL NE:NER NF:NFK NG:NGA NI:NIC NL:NLD NO:NOR NP:NPL NR:NRU NU:NIU NZ:NZL OM:OMN PA:PAN PE:PER PF:PYF PG:PNG PH:PHL PK:PAK PL:POL PM:SPM PN:PCN PR:PRI PS:PSE PT:PRT PW:PLW PY:PRY QA:QAT RE:REU RO:ROU RS:SRB RU:RUS RW:RWA SA:SAU SB:SLB SC:SYC SD:SDN SE:SWE SG:SGP SH:SHN SI:SVN SJ:SJM SK:SVK SL:SLE SM:SMR SN:SEN SO:SOM SR:SUR SS:SSD ST:STP SV:SLV SX:SXM SY:SYR SZ:SWZ TC:TCA TD:TCD TF:ATF TG:TGO TH:THA TJ:TJK TK:TKL TL:TLS TM:TKM TN:TUN TO:TON TR:TUR TT:TTO TV:TUV TW:TWN TZ:TZA UA:UKR UG:UGA UM:UMI US:USA UY:URY UZ:UZB VA:VAT VC:VCT VE:VEN VG:VGB VI:VIR VN:VNM VU:VUT WF:WLF WS:WSM YE:YEM YT:MYT ZA:ZAF ZM:ZMB ZW:ZWE".split(" ").map(pair => pair.split(":"))
);

// Claude 地区回落白名单，参考 UnlockTests/model/model.go（2026-09-30）。
const CLAUDE_REGIONS = new Set("AL DZ AD AO AG AR AM AU AT AZ BS BH BD BB BE BZ BJ BT BO BA BW BR BN BG BF BI CV KH CM CA TD CL CO KM CG CR CI HR CY CZ DK DJ DM DO EC EG SV GQ EE SZ FJ FI FR GA GM GE DE GH GR GD GT GN GW GY HT HN HU IS IN ID IQ IE IL IT JM JP JO KZ KE KI KW KG LA LV LB LS LR LI LT LU MG MW MY MV MT MH MR MU MX FM MD MC MN ME MA MZ NA NR NP NL NZ NE NG MK NO OM PK PW PS PA PG PY PE PH PL PT QA RO RW KN LC VC WS SM ST SA SN RS SC SL SG SK SI SB ZA KR ES LK SR SE CH TW TJ TZ TH TL TG TO TT TN TR TM TV UG UA AE GB US UY UZ VU VA VN ZM ZW".split(" "));

// 面板参数（脚本级解析一次，主流程与 checkGemini 共用）
let ARGS = {};

// Stash 保留独立服务卡片；通过一个定时脚本统一输出日志。
// 每个服务使用独立队列，收集器只记录已输出 ID，不清空正在写入的队列。
class MediaLog {
  static PREFIX = "stash_media_check_log_v1:";
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

  static readQueue(service) {
    const raw = $persistentStore.read(MediaLog.PREFIX + service);
    if (!raw) return [];
    const entries = JSON.parse(raw);
    if (!Array.isArray(entries)) return [];
    return entries.filter(entry => entry && typeof entry.id === "string"
      && Number.isFinite(entry.time) && Math.abs(entry.time) <= 8640000000000000
      && typeof entry.text === "string").slice(-60);
  }

  static log(...values) {
    let text;
    try { text = values.map(value => MediaLog.text(value)).join(" "); }
    catch { text = "[media-check] 日志内容无法格式化"; }
    if (!IS_STASH || ARGS.log !== "shared" || ARGS.service === "logs") {
      MediaLog.native(text);
      return;
    }
    try {
      const service = Object.prototype.hasOwnProperty.call(SERVICES, ARGS.service)
        ? ARGS.service : "summary";
      const time = Date.now();
      const entry = {
        id: `${time}:${MediaLog.RUN_ID}:${String(MediaLog.sequence++).padStart(6, "0")}`,
        time,
        text: text.slice(0, 2000)
      };
      const entries = MediaLog.readQueue(service);
      entries.push(entry);
      if ($persistentStore.write(JSON.stringify(entries.slice(-60)), MediaLog.PREFIX + service) === false) {
        throw new Error("日志存储写入失败");
      }
    } catch {
      MediaLog.native(text);
    }
  }

  static collect() {
    const pending = [];
    const queues = [];
    for (const service of [...Object.keys(SERVICES), "summary"]) {
      try {
        const entries = MediaLog.readQueue(service);
        const ackKey = MediaLog.PREFIX + "ack:" + service;
        const previous = JSON.parse($persistentStore.read(ackKey) || "[]");
        const seen = new Set(Array.isArray(previous) ? previous : []);
        for (const entry of entries) {
          if (!seen.has(entry.id)) pending.push({ ...entry, service });
        }
        const ids = entries.map(entry => entry.id);
        if (ids.some(id => !seen.has(id)) || seen.size !== ids.length) queues.push({ ackKey, ids });
      } catch {
        MediaLog.native(`[media-check][${service}] 无法读取日志队列`);
      }
    }
    pending.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
    for (const entry of pending) {
      MediaLog.native(`[${new Date(entry.time).toISOString()}][${entry.service}] ${entry.text}`);
    }
    for (const queue of queues) {
      try {
        if ($persistentStore.write(JSON.stringify(queue.ids), queue.ackKey) === false) {
          throw new Error("日志确认写入失败");
        }
      } catch {
        MediaLog.native("[media-check] 无法记录日志确认，下次可能重复输出");
      }
    }
  }
}

/**
 * 解锁状态变化推送（notify=true）：与上次快照对比，变化合并为一条通知
 * 超时/错误视为未知态：不通知也不更新该服务基线，避免网络抖动刷屏
 * 首次运行仅记录基线
 */
function notifyUnlockChanges(services) {
  // 保留两端既有记录；各 Stash Tile 单独保存，避免并发写入互相覆盖。
  const scope = ARGS.service && ARGS.service !== "all" ? ":" + ARGS.service : "";
  const group = JSON.stringify([ARGS.notifykey || "home", ARGS.proxy || "routing"]);
  const key = IS_STASH ? "stash_media_check_notify_v1:" + group + scope
    : (!ARGS.notifykey && !ARGS.proxy ? "mediaCheckNotifyState"
      : "mediaCheckNotifyState:" + encodeURIComponent(group));
  let prev = {};
  try { prev = JSON.parse($persistentStore.read(key)) || {}; } catch (e) {}
  if (!prev || typeof prev !== "object" || Array.isArray(prev)) prev = {};
  const next = { ...prev };
  const changes = [];
  services.forEach(s => {
    const st = s.result.status;
    if (st === STATUS.TIMEOUT || st === STATUS.ERROR) return;
    const avail = st === STATUS.OK || st === STATUS.COMING;
    const region = s.result.region || "";
    const cur = avail ? `1:${region}` : "0";
    const old = prev[s.name];
    next[s.name] = cur;
    if (typeof old !== "string" || old === cur) return;
    const oldAvail = old.charAt(0) === "1";
    const oldRegion = old.slice(2);
    if (!avail) changes.push(`🔴 ${s.name} 解锁失效`);
    else if (!oldAvail) changes.push(`🟢 ${s.name} 已解锁${region ? `（${region}）` : ""}`);
    else changes.push(`🔀 ${s.name} 区域变化 ${oldRegion || "?"} → ${region || "?"}`);
  });
  $persistentStore.write(JSON.stringify(next), key);
  if (changes.length) $notification.post("🎬 解锁状态变化", "", changes.join("\n"));
}

// 显示图标和颜色配置
const ICONS = { SUCCESS: "🟢", WARNING: "🟡", COLORS: { SUCCESS: "#3CB371", WARNING: "#DAA520" } };

/**
 * 工具类 - 提供通用方法
 */
class Utils {
  /**
   * 发起 HTTP 请求（支持 GET/POST）
   * @param {Object} options - 请求配置 {url, method, headers, body, timeout}
   * @returns {Promise<{status: number, headers: Object, body: string}>}
   */
  static request(options) {
    return new Promise((resolve, reject) => {
      const { url, method = "GET", headers = {}, body = null, timeout = CONFIG.TIMEOUT } = options;
      const started = Date.now();
      const target = Utils.safeUrl(url);
      const finalHeaders = { "User-Agent": CONFIG.UA, "Accept-Language": "en", ...headers };
      if (IS_STASH && ARGS.proxy) finalHeaders["X-Stash-Selected-Proxy"] = encodeURIComponent(ARGS.proxy);
      let settled = false;
      let timer;
      const settle = (error, value, phase = "callback") => {
        if (settled) return;
        settled = true;
        if (timer !== undefined && typeof clearTimeout === "function") clearTimeout(timer);
        if (error) {
          const failure = new Error(Utils.errorMessage(error));
          failure.phase = phase;
          MediaLog.log(`[HTTP] ${method} ${target}; 阶段=${phase}; 耗时=${Date.now() - started}ms; ${Utils.errorDetails(error)}`);
          reject(failure);
        } else {
          MediaLog.log(`[HTTP] ${method} ${target}; HTTP ${value.status}; 长度=${value.body.length}; 耗时=${Date.now() - started}ms`);
          resolve(value);
        }
      };
      MediaLog.log(`[HTTP] ${method} ${target}; 开始请求`);
      // Android Stash 可能没有 JS 计时器，此时依靠 HTTP 客户端自身的超时。
      // 有计时器的客户端继续保留 watchdog：JS 用毫秒，HTTP timeout 用秒。
      if (typeof setTimeout === "function") {
        timer = setTimeout(() => settle(new Error("Timeout"), null, "timeout"), timeout);
      }
      const cb = (error, response, data) => {
        if (settled) return;
        if (error) return settle(error);
        try {
          const status = Number(response && (response.status || response.statusCode));
          if (!status) return settle(new Error(response ? "Invalid Response: missing HTTP status" : "Invalid Response: missing response"), null, "response");
          if (status >= 500) return settle(new Error(`HTTP ${status}`), null, "http");
          const normalizedHeaders = {};
          Object.entries(response.headers || {}).forEach(([key, value]) => {
            normalizedHeaders[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
          });
          settle(null, { status, headers: normalizedHeaders, body: data == null ? "" : String(data),
            url: typeof response.url === "string" ? response.url : (typeof response.responseURL === "string" ? response.responseURL : "") });
        } catch (error) { settle(error, null, "response"); }
      };
      const request = {
        url,
        headers: finalHeaders,
        timeout: timeout / 1000,
        "auto-redirect": true,
        // 保留显式 Cookie；不让上一次请求的自动 Cookie 干扰双重检测。
        "auto-cookie": false
      };
      if (!IS_STASH && ARGS.proxy) request.policy = ARGS.proxy;
      if (body !== null) request.body = body;
      try {
        if (method === "POST") $httpClient.post(request, cb);
        else $httpClient.get(request, cb);
      } catch (error) { settle(error, null, "request"); }
    });
  }

  /**
   * 解析 argument 参数字符串（支持 URL 编码）
   * @param {string} argString - 参数字符串 (key1=value1&key2=value2)
   * @returns {Object} 解析后的参数对象
   */
  static parseArgs(argString) {
    const result = Object.create(null);
    const decode = value => {
      try { return decodeURIComponent(value); } catch { return value; }
    };
    String(argString || "").split("&").forEach(part => {
      const at = part.indexOf("=");
      if (at < 1) return;
      result[decode(part.slice(0, at)).trim()] = decode(part.slice(at + 1));
    });
    ["nfprice", "notify", "viu"].forEach(key => {
      if (result[key] !== undefined) result[key] = result[key].trim().toLowerCase();
    });
    return result;
  }

  static safeUrl(url) {
    return String(url || "").split(/[?#]/, 1)[0].replace(/(https?:\/\/)[^/@\s]+@/gi, "$1[redacted]@");
  }

  // Stash 的原生错误可能是字符串或对象；只提取诊断字段，不记录正文、请求头或堆栈。
  static errorMessage(error, depth = 0) {
    if (!error || typeof error !== "object") return String(error || "Unknown error");
    const parts = [];
    for (const key of ["name", "message", "description", "localizedDescription", "NSLocalizedDescription", "code", "domain", "reason", "error"]) {
      try {
        const value = error[key];
        if (value == null || value === "") continue;
        if (typeof value !== "object") parts.push(`${key}=${String(value)}`);
        else if (depth < 1) parts.push(`${key}=${Utils.errorMessage(value, depth + 1)}`);
      } catch (_) {}
    }
    return parts.join("; ") || "Unknown error object";
  }

  static errorDetails(error) {
    let message = Utils.errorMessage(error);
    const apiKey = String(ARGS.geminiapikey || "");
    if (apiKey && !["0", "null", "undefined"].includes(apiKey.toLowerCase())) {
      for (const secret of [apiKey, encodeURIComponent(apiKey)]) message = message.split(secret).join("[redacted]");
    }
    return message.replace(/https?:\/\/[^\s"'<>]+/gi, url => Utils.safeUrl(url))
      .replace(/\b(?:api[_-]?key|key|token|authorization|cookie)\s*[:=]\s*[^\s;,]+/gi, "[redacted]")
      .replace(/[\r\n\t]+/g, " ").slice(0, 320);
  }

  static errorResult(error) {
    const message = Utils.errorMessage(error);
    return /\btimeout\b|timed.?out|超时/i.test(message) || (/NSURLErrorDomain/.test(message) && /code=-1001\b/.test(message))
      ? this.createResult(STATUS.TIMEOUT, "Timeout")
      : this.createResult(STATUS.ERROR, "Error");
  }


  // HTTP 错误、限流、验证页都属于未知；只让服务专属的明确限制进入 NO。
  static responseProblem(res) {
    if (res.status === 429) return { ...this.createResult(STATUS.ERROR, "Error"), reason: "rate-limit" };
    if (this.isChallenge(res)) return { ...this.createResult(STATUS.ERROR, "Error"), reason: "challenge" };
    if (res.status < 200 || res.status >= 400 || !res.body.trim()) return this.createResult(STATUS.ERROR, "Error");
    return null;
  }

  static isChallenge(res) {
    // 普通页面也会加载 challenge-platform，不能仅因脚本路径出现就误判。
    return res.headers?.["cf-mitigated"] === "challenge" ||
      /<title>\s*(?:just a moment|attention required)|checking your browser|verify (?:that )?you are human/i.test(res.body) ||
      (res.status === 403 && /cf-chl|challenge-platform|__rd_verify_/i.test(res.body));
  }

  static country(code) {
    const value = String(code || "").trim().toUpperCase();
    if (Object.prototype.hasOwnProperty.call(COUNTRY_CODES, value)) return value;
    return Object.keys(COUNTRY_CODES).find(key => COUNTRY_CODES[key] === value) || "";
  }

  // Stash Android 不保证提供 atob / Buffer；只用标准 JS 解码网页内嵌配置。
  static decodeBase64(value) {
    const input = value.replace(/\s/g, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input) || input.length % 4 === 1) throw Error("Invalid base64");
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bits = 0, buffer = 0, encoded = "";
    for (const c of input.replace(/=+$/, "")) {
      buffer = (buffer << 6) | alphabet.indexOf(c);
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        encoded += "%" + ((buffer >> bits) & 255).toString(16).padStart(2, "0");
      }
    }
    return decodeURIComponent(encoded);
  }

  static traceRegion(res) {
    return res?.status === 200 ? this.country(res.body.match(/^loc=([A-Z]{2})\s*$/m)?.[1]) : "";
  }

  static pageUrl(body) {
    const tags = body.match(/<(?:link|meta)\b[^>]*>/gi) || [];
    for (const tag of tags) {
      if (/\brel=["']canonical["']|\bproperty=["']og:url["']/i.test(tag)) {
        const url = tag.match(/\b(?:href|content)=["']([^"']+)/i)?.[1];
        if (url) return url;
      }
    }
    return "";
  }

  /**
   * 构建显示行
   * @param {string} name - 服务名称
   * @param {Object} result - 检测结果 {status, region}
   * @param {string} suffix - 额外信息（如价格）
   * @returns {string} 格式化的显示行
   */
  static buildContent(result, suffix = "") {
    const statusMap = {
      [STATUS.OK]: result.region || "OK",
      [STATUS.COMING]: (result.region?.includes("(") || result.region?.includes(" ")) ? result.region : `${result.region || "N/A"} (Coming)`,
      [STATUS.FAIL]: result.region || "No",
      [STATUS.TIMEOUT]: "Timeout",
      [STATUS.ERROR]: result.region || "Error"
    };
    
    // 优先显示具体失败原因（如 VPN、Region Blocked）
    let displayStatus = (result.status === STATUS.FAIL && result.region && result.region !== "No") 
      ? result.region 
      : statusMap[result.status];
    
    return `${displayStatus}${suffix ? ` | ${suffix}` : ""}`;
  }

  static buildLine(name, result, suffix = "") {
    return `${name.padEnd(11)} ➟ ${this.buildContent(result, suffix)}`;
  }

  /**
   * 创建标准检测结果对象
   * @param {number} status - 状态码
   * @param {string} region - 地区代码或错误信息
   * @returns {Object} {status, region}
   */
  static createResult(status, region = "") {
    return { status, region };
  }


}

/**
 * 服务检测器 - 各平台解锁检测实现
 */
class ServiceChecker {
  /**
   * Netflix 解锁检测
   * 通过访问特定影片 ID 判断是否解锁，并获取地区代码
   * @returns {Promise<Object>} 检测结果
   */
  static async checkNetflix() {
    const probe = async id => {
      try {
        const res = await Utils.request({ url: `https://www.netflix.com/title/${id}` });
        if (/not available in your country|proxy or unblocker/i.test(res.body)) return { blocked: true };
        if (res.status === 404 || res.status === 410 || /Oh no!/.test(res.body)) return { available: false };
        const error = Utils.responseProblem(res);
        if (error) return { error };
        if (res.status !== 200) return { error: Utils.createResult(STATUS.ERROR, "Error") };
        const origin = res.headers["x-originating-url"] || "";
        const canonical = Utils.pageUrl(res.body);
        // 参考 UnlockTests：优先请求所在地区，避免语言菜单和 CDN 地区混入。
        const jsonRegion = res.body.match(/"requestCountry"\s*:\s*\{\s*"id"\s*:\s*"([a-z]{2})"/i)?.[1]
          || res.body.match(/"id"\s*:\s*"([a-z]{2})"[^}]*?"countryName"/i)?.[1]
          || res.body.match(/"geo"\s*:\s*\{[^}]*"country"\s*:\s*"([a-z]{2})"/i)?.[1]
          || res.body.match(/\bdata-country\s*=\s*["']([a-z]{2})["']/i)?.[1];
        const regionPath = (origin || canonical).match(/netflix\.com\/([a-z]{2})(?:-[a-z]+)?\/title\//i)?.[1];
        // /title/ 的来源头是明确的美国路径；没有地区证据时只显示 OK。
        const region = Utils.country(jsonRegion || regionPath) || (/^https?:\/\/www\.netflix\.com\/title\//i.test(origin) ? "US" : "");
        const titlePage = /<title>\s*Watch\b|"@type"\s*:\s*"(?:Movie|TVSeries|TVEpisode)"|"isPlayable"\s*:\s*true|property=["']og:video["']|data-uia=["']episodes["']|"playableVideo"\s*:/i.test(res.body)
          || origin.includes(`/title/${id}`);
        return titlePage ? { available: true, region } : { error: Utils.createResult(STATUS.ERROR, "Error") };
      } catch (error) { return { error: Utils.errorResult(error) }; }
    };
    // 两部非原创作品均明确不可用，才通过原创作品验证 Originals Only。
    for (const id of [81280792, 70143836]) {
      const result = await probe(id);
      if (result.blocked) return Utils.createResult(STATUS.FAIL, "NO");
      if (result.error) return result.error;
      if (result.available) return Utils.createResult(STATUS.OK, result.region || "OK");
    }
    const original = await probe(80197526);
    if (original.error) return original.error;
    return original.available
      ? Utils.createResult(STATUS.FAIL, original.region ? `${original.region} (Originals)` : "Originals Only")
      : Utils.createResult(STATUS.FAIL, "NO");
  }

  /**
   * Netflix 价格表预取（与各服务检测并行发起，避免检测完成后再串行等一个 RTT）
   * 价格表更新频率低，本地缓存 24 小时；请求失败时回退过期缓存
   * @returns {Promise<Object|null>} 价格表 HTTP 响应（或缓存等价物）
   */
  static fetchNetflixPrices() {
    const CACHE_KEY = IS_STASH ? "stash_media_check_nf_prices_v1" : "media_check_nf_prices";
    const TTL = 86400000; // 24h

    let cached = null;
    try {
      cached = JSON.parse($persistentStore.read(CACHE_KEY));
    } catch { /* 无缓存或缓存损坏 */ }

    if (cached?.body && Date.now() - cached.ts < TTL) {
      return Promise.resolve({ status: 200, body: cached.body });
    }

    return Utils.request({ url: "https://raw.githubusercontent.com/tompec/netflix-prices/main/data/latest.json", timeout: 2000 })
      .then(res => {
        if (res?.status === 200 && res.body && Array.isArray(JSON.parse(res.body))) {
          $persistentStore.write(JSON.stringify({ ts: Date.now(), body: res.body }), CACHE_KEY);
          return res;
        }
        // 非 200 → 回退过期缓存
        return cached?.body ? { status: 200, body: cached.body } : res;
      })
      .catch(() => (cached?.body ? { status: 200, body: cached.body } : null));
  }

  /**
   * Netflix 价格查询（从预取的价格表中查找）
   * @param {Promise<Object|null>} pricesPromise - fetchNetflixPrices() 返回的 Promise
   * @param {string} region - 地区代码
   * @returns {Promise<string>} 价格字符串
   */
  static async getNetflixPrice(pricesPromise, region) {
    try {
      const res = await pricesPromise;
      if (!res || res.status !== 200) return "";
      const country = JSON.parse(res.body).find(i => i.country_code === region);
      const plan = country?.plans?.find(p => p.name === "premium");
      return plan ? `${plan.price} ${country.currency}` : "";
    } catch { return ""; }
  }

  /**
   * Disney+ 解锁检测
   * 所有地区共用主页与 API 检测，不按地区名单特殊分类
   * @returns {Promise<Object>} 检测结果
   */
  static async checkDisney() {
    const home = Utils.request({ url: "https://www.disneyplus.com/" }).catch(error => ({ error }));
    const api = Utils.request({
      url: "https://disney.api.edge.bamgrid.com/graph/v1/device/graphql", method: "POST",
      headers: { "Authorization": "ZGlzbmV5JmJyb3dzZXImMS4wLjA.Cu56AgSfBTDag5NiRA81oLHkDZfu5L3CKadnefEAY84", "Content-Type": "application/json" },
      body: JSON.stringify({
        query: 'mutation registerDevice($input: RegisterDeviceInput!) { registerDevice(registerDevice: $input) { grant { grantType assertion } } }',
        variables: { input: { applicationRuntime: 'chrome', attributes: { browserName: 'chrome', browserVersion: CONFIG.CHROME_VERSION, operatingSystem: 'macintosh', operatingSystemVersion: '10.15.7' }, deviceFamily: 'browser', deviceLanguage: 'en', deviceProfile: 'macosx' } }
      })
    }).catch(error => ({ error }));
    const [homeRes, apiRes] = await Promise.all([home, api]);
    let apiProblem = apiRes.error ? Utils.errorResult(apiRes.error) : Utils.responseProblem(apiRes);
    if (!apiRes.error && /forbidden-location|unsupported_country/i.test(apiRes.body)) return Utils.createResult(STATUS.FAIL, "NO");
    if (!apiProblem) {
      try {
        const data = JSON.parse(apiRes.body);
        const session = data?.extensions?.sdk?.session;
        if (!data.errors && (session?.inSupportedLocation === true || session?.inSupportedLocation === "true")) {
          return Utils.createResult(STATUS.OK, Utils.country(session?.location?.countryCode) || "OK");
        }
        if (!data.errors && (session?.inSupportedLocation === false || session?.inSupportedLocation === "false")) {
          return Utils.createResult(STATUS.FAIL, "NO");
        }
      } catch (_) {}
      apiProblem = Utils.createResult(STATUS.ERROR, "Error");
    }
    if (!homeRes.error) {
      if (/Sorry, Disney\+ is not available/i.test(homeRes.body)) return Utils.createResult(STATUS.FAIL, "NO");
      if (!Utils.responseProblem(homeRes)) {
        const region = Utils.country(homeRes.body.match(/Region:\s*([A-Za-z]{2})[\s\S]*?CNBL:\s*[12]/)?.[1]);
        if (region) return Utils.createResult(STATUS.OK, region);
      }
    }
    return apiProblem || Utils.createResult(STATUS.ERROR, "Error");
  }

  /**
   * HBO Max 解锁检测
   * 参考 OpenClash 的 userCountry / isUserOutOfRegion 判据：
   * https://github.com/vernesong/OpenClash/blob/master/luci-app-openclash/root/usr/share/openclash/openclash_streaming_unlock.lua
   * 只读取 __NEXT_DATA__.props.pageProps，避免误取导航菜单或嵌套配置中的地区。
   * HTTP 异常、缺失字段及页面解析失败属于未知状态，不代表地区受限。
   * JP / CA / KR 保留第三方平台提示；此检测不验证账号播放或第三方平台解锁。
   * @returns {Promise<Object>} 检测结果
   */
  static async checkHBOMax() {
    const unknown = reason => {
      MediaLog.log("[media-check][HBO Max] " + reason);
      return Utils.createResult(STATUS.ERROR, "Error");
    };
    try {
      const res = await Utils.request({ url: "https://www.hbomax.com/" });
      if (res.status !== 200) return unknown("HTTP " + res.status);
      const match = res.body.match(/<script\b[^>]*\bid\s*=\s*["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script\s*>/i);
      if (!match) return unknown("Missing page data");
      let page;
      try { page = JSON.parse(match[1])?.props?.pageProps; }
      catch { return unknown("Invalid page data"); }
      if (!page || page.isCMSErrorPage === true) return unknown("Unavailable page data");

      const region = typeof page.userCountry === "string" ? page.userCountry.trim().toUpperCase() : "";
      const hasRegion = /^[A-Z]{2}$/.test(region);
      const outOfRegion = page.isUserOutOfRegion;
      if (outOfRegion !== true && outOfRegion !== false) return unknown("Missing availability flag");

      if (outOfRegion) {
        const partners = { JP: "U-NEXT", CA: "Crave", KR: "Coupang Play" };
        if (hasRegion && Object.prototype.hasOwnProperty.call(partners, region)) {
          return Utils.createResult(STATUS.COMING, `${region} (${partners[region]})`);
        }
        return Utils.createResult(STATUS.FAIL, "NO");
      }
      if (!hasRegion) return unknown("Missing user country");
      return Utils.createResult(STATUS.OK, region);
    } catch (error) {
      return Utils.errorResult(error);
    }
  }

  /**
   * YouTube Premium 解锁检测
   * 参考 RegionRestrictionCheck 的明确可用性标记；未知时回落
   * @returns {Promise<Object>} 检测结果
   */
  static async checkYoutube() {
    let unknown = Utils.createResult(STATUS.ERROR, "Error");
    // 通常一次请求即可；仅未知/异常时用最小同意 Cookie 重试，失败不覆盖有效结果。
    for (const headers of [{}, { Cookie: "SOCS=CAI" }]) {
      try {
        const res = await Utils.request({ url: "https://www.youtube.com/premium", headers });
        if (/premium is not available in your country/i.test(res.body)) return Utils.createResult(STATUS.FAIL, "NO");
        const issue = Utils.responseProblem(res);
        if (issue) { unknown = issue; continue; }
        if (res.body.includes("www.google.cn")) return Utils.createResult(STATUS.FAIL, "NO");
        if (/ad-free|premiumPurchaseButton|purchaseButtonOverride|manageSubscriptionButton|Start trial/i.test(res.body)) {
          const region = Utils.country(res.body.match(/"(?:countryCode|contentRegion|INNERTUBE_CONTEXT_GL)"\s*:\s*"([A-Z]{2})"/)?.[1]);
          return Utils.createResult(STATUS.OK, region || "Premium");
        }
      } catch (error) { unknown = Utils.errorResult(error); }
    }
    return unknown;
  }

  /**
   * Spotify 解锁检测
   * @returns {Promise<Object>} 检测结果
   */
  static async checkSpotify() {
    try {
      // 参考 oneclickvirt/UnlockTests：优先读取播放器实际 market，不匹配语言菜单。
      const res = await Utils.request({ url: "https://open.spotify.com/" });
      if (/not (?:yet )?available in (?:your|this) country/i.test(res.body)) return Utils.createResult(STATUS.FAIL, "NO");
      const issue = Utils.responseProblem(res);
      if (issue) return issue;
      const encoded = res.body.match(/<script\b[^>]*\bid=["']appServerConfig["'][^>]*>([^<]+)<\/script>/i)?.[1];
      if (encoded) {
        try {
          const region = Utils.country(JSON.parse(Utils.decodeBase64(encoded)).market);
          if (region) return Utils.createResult(STATUS.OK, region);
        } catch (_) {}
      }
      // 页面结构变动时只用 canonical / og:url 回落，忽略 alternate 与页脚链接。
      const premium = await Utils.request({ url: "https://www.spotify.com/premium/" });
      if (/not (?:yet )?available in (?:your|this) country/i.test(premium.body)) return Utils.createResult(STATUS.FAIL, "NO");
      const fallbackIssue = Utils.responseProblem(premium);
      if (fallbackIssue) return fallbackIssue;
      const url = Utils.pageUrl(premium.body);
      const region = Utils.country(url.match(/^https:\/\/(?:www\.)?spotify\.com\/([a-z]{2})(?:-[a-z]{2,4})?\/(?:premium(?:\/|$))?/i)?.[1]);
      if (region) return Utils.createResult(STATUS.OK, region);
      return Utils.createResult(STATUS.ERROR, "Error");
    } catch (error) { return Utils.errorResult(error); }
  }

  /**
   * ChatGPT 解锁检测
   * 参考 lmc999/RegionRestrictionCheck：单行区分可用地区 / Web Only / Mobile Only / NO
   * @returns {Promise<Object>} 检测结果
   */
  static async checkChatGPT() {
    const probe = async (url, headers, app = false) => {
      try {
        const res = await Utils.request({ url, headers });
        const blocked = /unsupported_country|disallowed isp|been blocked|blocked_why_headline/i.test(res.body)
          || (app && /\bVPN\b|"cf_details"\s*:\s*"[^"\n]*\([12]\)/i.test(res.body));
        if (blocked) return Utils.createResult(STATUS.FAIL, "NO");
        // App 探测根路径的通用 cf_details 不是地区/ISP 封锁证据。
        if (app && res.status === 403) {
          try {
            const data = JSON.parse(res.body);
            if (data.type === "dc" && /^Request is not allowed\. Please try again later\.?$/i.test(data.cf_details || "")) {
              return { ...Utils.createResult(STATUS.ERROR, "Error"), reason: "app-probe" };
            }
          } catch (_) {}
        }
        return Utils.responseProblem(res) || Utils.createResult(STATUS.OK);
      } catch (error) { return Utils.errorResult(error); }
    };
    const [web, app, trace] = await Promise.all([
      probe("https://api.openai.com/compliance/cookie_requirements", {
        "Authorization": "Bearer null", "Content-Type": "application/json",
        "Origin": "https://platform.openai.com", "Referer": "https://platform.openai.com/"
      }),
      probe("https://ios.chat.openai.com/", {}, true),
      Utils.request({ url: "https://chatgpt.com/cdn-cgi/trace", timeout: 1500 }).catch(() => null)
    ]);
    const region = Utils.traceRegion(trace);
    // 保留原地区检测口径；不把这个无需登录的探测地址当作真实 App 会话。
    if (web.status === STATUS.OK && app.reason === "app-probe" && region) {
      MediaLog.log("ChatGPT: generic App probe response; regional result from Web + trace (" + region + ")");
      return Utils.createResult(STATUS.OK, region);
    }
    if (web.status === STATUS.OK && app.status === STATUS.OK) return Utils.createResult(STATUS.OK, region || "OK");
    if (web.status === STATUS.FAIL && app.status === STATUS.FAIL) return Utils.createResult(STATUS.FAIL, "NO");
    if (web.status === STATUS.OK && app.status === STATUS.FAIL) return Utils.createResult(STATUS.COMING, "Web Only");
    if (web.status === STATUS.FAIL && app.status === STATUS.OK) return Utils.createResult(STATUS.COMING, "Mobile Only");
    // 未知不能冒充另一端已被限制，也不能显示完全可用。
    return [web, app].find(r => r.status === STATUS.ERROR || r.status === STATUS.TIMEOUT);
  }

  /**
   * Claude AI 解锁检测
   * login 可用性判断与 cdn-cgi/trace 地区码提取并发请求，仅在可用时采用地区码
   * @returns {Promise<Object>} 检测结果
   */
  static async checkClaude() {
    try {
      const [login, trace] = await Promise.all([
        Utils.request({ url: "https://claude.ai/login" }),
        Utils.request({ url: "https://claude.ai/cdn-cgi/trace", timeout: 1500 }).catch(() => null)
      ]);
      if (login.status === 451 || /app-unavailable-in-region/i.test(login.body)) return Utils.createResult(STATUS.FAIL, "NO");
      const region = Utils.traceRegion(trace);
      // 保留原来的地区检测口径：Cloudflare 浏览器挑战不等于地区不支持。
      // 仅在 trace 确认受支持地区时回落；未知 403、限流和地区限制仍不算通过。
      if (Utils.isChallenge(login) && login.status !== 429 && CLAUDE_REGIONS.has(region)) {
        MediaLog.log("Claude: browser challenge; regional result from trace (" + region + ")");
        return Utils.createResult(STATUS.OK, region);
      }
      return Utils.responseProblem(login) || Utils.createResult(STATUS.OK, region || "OK");
    } catch (error) { return Utils.errorResult(error); }
  }

  /**
   * Gemini 解锁检测
   * 网页检测（参考 lmc999/RegionRestrictionCheck）+ API Key fallback
   * @returns {Promise<Object>} 检测结果
   */
  static async checkGemini() {
    let unknown = Utils.createResult(STATUS.ERROR, "Error");
    const deadline = Date.now() + 10000;
    const logError = (stage, error) => {
      const result = Utils.errorResult(error);
      MediaLog.log(`[Gemini v${CONFIG.VERSION}] ${stage}失败；阶段=${error?.phase || "parse"}；${Utils.errorDetails(error)}`);
      return result;
    };
    const pages = ["https://gemini.google.com", "https://gemini.google.com/app?hl=en"];
    for (const [index, url] of pages.entries()) {
      const stage = index ? "应用页" : "首页";
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        MediaLog.log(`[Gemini v${CONFIG.VERSION}] 网页检测预算已耗尽，不再请求应用页`);
        break;
      }
      try {
        const res = await Utils.request({ url, timeout: remaining });
        const flags = ["45631641", "45617354"].map(id =>
          `${id}=${res.body.match(new RegExp(`${id},\\s*null,\\s*(true|false)`))?.[1] || "missing"}`);
        const region = Utils.country(res.body.match(/,\s*2,\s*1,\s*200,\s*"([A-Z]{2,3})"/)?.[1]);
        const redirect = /https?:\/\/(?:[^/]+\.)?google\.com\/sorry(?:[/?#]|$)/i.test(res.url) ? "验证页"
          : /^https?:\/\/consent\.google\./i.test(res.url) ? "同意页"
          : /^https?:\/\/accounts\.google\./i.test(res.url) ? "登录页" : "无";
        const issue = Utils.responseProblem(res);
        let result = issue || Utils.createResult(STATUS.ERROR, "Error");
        let reason = issue?.reason || (issue ? `HTTP ${res.status} 或空响应` : "缺少可用标记");
        if (redirect !== "无" || /our systems have detected unusual traffic|unusual traffic from your computer network/i.test(res.body)) {
          reason = redirect !== "无" ? redirect : "异常流量验证";
          result = Utils.createResult(STATUS.ERROR, "Error");
        } else if (issue?.reason) {
          reason = issue.reason;
        } else if (/unsupported_country|not (?:currently )?available in (?:your|this) (?:country|region)/i.test(res.body)) {
          reason = "地区限制";
          result = Utils.createResult(STATUS.FAIL, "NO");
        } else if (!issue && /456(?:31641|17354),\s*null,\s*true/.test(res.body)) {
          reason = "可用";
          result = Utils.createResult(STATUS.OK, region || "OK");
        }
        MediaLog.log(`[Gemini v${CONFIG.VERSION}] ${stage}: HTTP ${res.status}; 长度=${res.body.length}; ${flags.join(", ")}; 地区=${region || "未知"}; 原因=${reason}`);
        if (result.status === STATUS.OK || result.status === STATUS.FAIL) return result;
        unknown = result;
        // 正常首页缺标记时回落；限流和验证页面保持原结果。
        if (res.status !== 200 || reason !== "缺少可用标记" || flags.some(flag => !flag.endsWith("=missing"))) break;
      } catch (error) {
        unknown = logError(stage, error);
        // Stash 的原生 SendRequest 失败尚未收到 HTTP；沿同一线路尝试应用页一次。
        // 其他错误不重试，两个网页请求共用 10 秒预算。
        if (IS_STASH && index === 0 && error?.phase === "callback" && unknown.status !== STATUS.TIMEOUT &&
          /\bSendRequest\b/i.test(Utils.errorMessage(error))) {
          MediaLog.log(`[Gemini v${CONFIG.VERSION}] 首页 SendRequest，回落同一线路的应用页`);
          continue;
        }
        break;
      }
    }
    const apiKey = (ARGS.geminiapikey || "").trim();
    if (apiKey && !["0", "null", "undefined"].includes(apiKey.toLowerCase()) && !/[{}]/.test(apiKey)) {
      try {
        const res = await Utils.request({ url: `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}` });
        const issue = Utils.responseProblem(res);
        MediaLog.log(`[Gemini v${CONFIG.VERSION}] API: HTTP ${res.status}; 长度=${res.body.length}; 原因=${issue?.reason || "响应已收到"}`);
        if (issue?.reason) return issue;
        if (/user location is not supported|unsupported_country/i.test(res.body)) return Utils.createResult(STATUS.FAIL, "NO");
        if (/key not valid|api_key_invalid/i.test(res.body)) return Utils.createResult(STATUS.ERROR, "Invalid Key");
        if (issue) return issue;
        if (res.status === 200 && Array.isArray(JSON.parse(res.body).models)) return Utils.createResult(STATUS.OK, "OK");
      } catch (error) { unknown = logError("API", error); }
    }
    return unknown;
  }


  /** 参考 oneclickvirt/UnlockTests/transnation/MetaAI.go，保留 AJAX 协议判据。
   * 403 及验证页不直接算可用；主页需要明确标记，地区查询不影响可用性。
   */
  static async checkMetaAI() {
    const parseHome = res => {
      if (/GeoBlockedErrorRoot|not (?:yet )?available in (?:your|this) country/i.test(res.body)) return Utils.createResult(STATUS.FAIL, "NO");
      if (/AbraRateLimitedErrorRoot/.test(res.body)) return { ...Utils.createResult(STATUS.ERROR, "Error"), reason: "rate-limit" };
      const issue = Utils.responseProblem(res);
      if (issue) return issue;
      if (/AbraHomeRoot\.react|AbraHomeRootConversationQuery|HomeRootQuery|KadabraRootContainer/.test(res.body)) {
        const locale = res.body.match(/"code"\s*:\s*"(?:[a-z]{2}_)?([a-z]{2})"/i)?.[1];
        return Utils.createResult(STATUS.OK, Utils.country(locale) || "OK");
      }
      return Utils.createResult(STATUS.ERROR, "Error");
    };
    try {
      const ajax = await Utils.request({ url: "https://www.meta.ai/ajax", headers: { Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8" } });
      const parsed = parseHome(ajax);
      if (parsed.status === STATUS.FAIL || parsed.status === STATUS.OK || ["challenge", "rate-limit"].includes(parsed.reason)) return parsed;
      // /ajax 的 400/404 和明确的 401 登录要求均属于端点协议响应，不是地区限制。
      let authRequired = false;
      if (ajax.status === 401) {
        try { authRequired = JSON.parse(ajax.body).error === "Authentication required"; } catch (_) {}
      }
      if (ajax.status === 400 || ajax.status === 404 || authRequired) {
        let region = "";
        try {
          const legal = await Utils.request({ url: "https://www.meta.com/legal/", timeout: 1000 });
          if (!Utils.responseProblem(legal)) {
            const canonical = Utils.pageUrl(legal.body);
            region = [legal.url, canonical, legal.headers.location].map(url =>
              Utils.country(String(url || "").match(/meta\.com\/([a-z]{2})\/legal(?:\/|$)/i)?.[1])).find(Boolean) || "";
          }
        } catch (_) {}
        return Utils.createResult(STATUS.OK, region || "OK");
      }
      return parseHome(await Utils.request({ url: "https://www.meta.ai/" }));
    } catch (error) { return Utils.errorResult(error); }
  }

  /** 参考 oneclickvirt/UnlockTests/transnation/TikTok.go；回落时校验该次响应。 */
  static async checkTikTok() {
    let unknown = Utils.createResult(STATUS.ERROR, "Error");
    for (const url of ["https://www.tiktok.com/explore", "https://www.tiktok.com/"]) {
      try {
        const res = await Utils.request({ url });
        if (/tiktok\.com\/hk\/(?:notfound|about)|class=["'][^"']*\bhknotfound-page\b|not available in (?:your|this) country/i.test(res.body)
          || /tiktok\.com\/hk\/(?:notfound|about)/i.test(res.url)) return Utils.createResult(STATUS.FAIL, "NO");
        const issue = Utils.responseProblem(res);
        if (issue) { unknown = issue; continue; }
        const region = Utils.country(res.body.match(/"region"\s*:\s*"([a-z]{2,3})"/i)?.[1]);
        if (res.status === 200 && region) return Utils.createResult(STATUS.OK, region);
      } catch (error) { unknown = Utils.errorResult(error); }
    }
    return unknown;
  }

  /**
   * Reddit 解锁检测
   * 参考 lmc999/RegionRestrictionCheck：请求主站 www.reddit.com（而非 oauth.reddit.com
   * API 网关，该域名反爬策略更激进，会对无 OAuth token 的请求普遍返回 403 造成误判）
   * @returns {Promise<Object>} 检测结果
   */
  static async checkReddit() {
    try {
      const res = await Utils.request({ url: "https://www.reddit.com/" });
      if (res.status === 403 && /been blocked/i.test(res.body)) return Utils.createResult(STATUS.FAIL, "NO");
      const issue = Utils.responseProblem(res);
      if (issue) return issue;
      return res.status === 200 || res.status === 302
        ? Utils.createResult(STATUS.OK, "OK")
        : Utils.createResult(STATUS.ERROR, "Error");
    } catch (error) { return Utils.errorResult(error); }
  }

  /** ViuCom 即 Viu，仅供 Surge 可选检测；参考 UnlockTests 的 no-service 重定向。 */
  static async checkViu() {
    try {
      const res = await Utils.request({ url: "https://www.viu.com/" });
      const finalUrl = res.url || res.headers.location || Utils.pageUrl(res.body);
      if (/\/no-service(?:[/?#]|$)/i.test(finalUrl)) return Utils.createResult(STATUS.FAIL, "NO");
      const issue = Utils.responseProblem(res);
      if (issue) return issue;
      const region = Utils.country(finalUrl.match(/viu\.com\/ott\/([a-z]{2})(?:[/?#]|$)/i)?.[1]
        || res.body.match(/\/ott\/([a-z]{2})[/"']/i)?.[1]);
      return region ? Utils.createResult(STATUS.OK, region) : Utils.createResult(STATUS.ERROR, "Error");
    } catch (error) { return Utils.errorResult(error); }
  }
}

// Stash Tile 只运行 argument.service 对应的检测。
const SERVICES = {
  netflix: { title: "Netflix", check: "checkNetflix", url: "https://www.netflix.com", color: "#E50914" },
  disney: { title: "Disney+", check: "checkDisney", url: "https://www.disneyplus.com", color: "#113CCF" },
  hbomax: { title: "HBO Max", check: "checkHBOMax", url: "https://www.hbomax.com", color: "#191919" },
  youtube: { title: "YouTube Premium", check: "checkYoutube", url: "https://www.youtube.com/premium", color: "#E62117" },
  spotify: { title: "Spotify", check: "checkSpotify", url: "https://www.spotify.com", color: "#117C39" },
  tiktok: { title: "TikTok", check: "checkTikTok", url: "https://www.tiktok.com/", color: "#191919" },
  chatgpt: { title: "ChatGPT", check: "checkChatGPT", url: "https://chatgpt.com", color: "#0D8A70" },
  claude: { title: "Claude", check: "checkClaude", url: "https://claude.ai", color: "#B85C3F" },
  gemini: { title: "Gemini", check: "checkGemini", url: "https://gemini.google.com", color: "#386EDB" },
  metaai: { title: "Meta AI", check: "checkMetaAI", url: "https://www.meta.ai/", color: "#0866FF" },
  reddit: { title: "Reddit", check: "checkReddit", url: "https://www.reddit.com", color: "#D93900" }
};

async function checkService(definition) {
  MediaLog.log(`[media-check v${CONFIG.VERSION}][${definition.title}] 检测开始`);
  try {
    const result = await ServiceChecker[definition.check]();
    MediaLog.log(`[media-check v${CONFIG.VERSION}][${definition.title}] 检测完成：${Utils.buildContent(result)}${result.reason ? "; 原因=" + result.reason : ""}`);
    return result;
  } catch (error) {
    MediaLog.log(`[media-check v${CONFIG.VERSION}][${definition.title}] 检测异常：${Utils.errorDetails(error)}`);
    throw error;
  }
}

async function runServiceTile(service) {
  // hasOwnProperty 防止 constructor 等继承属性被误当成服务。
  if (!Object.prototype.hasOwnProperty.call(SERVICES, service)) {
    finishPanel({ title: "检测配置错误", content: "未知服务: " + service, backgroundColor: "#CC4444" });
    return;
  }
  const definition = SERVICES[service];
  const prices = service === "netflix" && ARGS.nfprice !== "false"
    ? ServiceChecker.fetchNetflixPrices() : null;
  let result;
  try { result = await checkService(definition); }
  catch (error) { result = Utils.errorResult(error); }
  const suffix = prices && result.status === STATUS.OK
    ? await ServiceChecker.getNetflixPrice(prices, result.region) : "";
  if (ARGS.notify === "true" && ARGS.mode !== "collapsed") {
    try { notifyUnlockChanges([{ name: definition.title, result }]); }
    catch { MediaLog.log("[media-check] 通知或状态存储失败，继续显示面板。"); }
  }
  const content = Utils.buildContent(result, suffix);
  finishPanel({
    title: definition.title,
    content: content === "No" ? "NO" : content,
    // icon 由覆写配置提供，更新状态时保留各服务的 Logo。
    // 可用或部分可用显示品牌色；不可用及检测异常显示灰色。
    backgroundColor: result.status === STATUS.OK || result.status === STATUS.COMING
      ? definition.color : "#8E8E93",
    url: definition.url
  });
}

/** 主流程：Surge 汇总；Stash 按 service 检测，并兼容旧汇总配置。 */
(async () => {
  try {
    const args = ARGS = Utils.parseArgs(typeof $argument === "string" ? $argument : "");
    args.service = IS_STASH ? String(args.service || "").trim().toLowerCase() : "";
    args.mode = IS_STASH ? String(args.mode || "home").trim().toLowerCase() : "home";
    if (IS_STASH && args.service === "logs") {
      MediaLog.collect();
      $done({});
      return;
    }
    if (args.mode === "collapsed") args.proxy = "";
    if (args.service && args.service !== "all") {
      await runServiceTile(args.service);
      return;
    }
    // Netflix 价格表与各服务检测并行预取（仅在开启价格显示时）
    const pricesPromise = args.nfprice !== "false" ? ServiceChecker.fetchNetflixPrices() : null;
    // 汇总与独立卡片共用服务表，顺序和新增服务只维护一次。
    const definitions = Object.entries(SERVICES);
    const viuPromise = !IS_STASH && args.viu === "true" ? ServiceChecker.checkViu() : Promise.resolve(null);
    const results = await Promise.all(definitions.map(([, definition]) => checkService(definition)));
    const services = definitions.map(([id, definition], index) => ({
      name: id === "youtube" ? "YouTube" : definition.title, result: results[index]
    }));
    if (results[0].status === STATUS.OK && pricesPromise) {
      services[0].suffix = await ServiceChecker.getNetflixPrice(pricesPromise, results[0].region);
    }
    const viu = await viuPromise;

    // Surge 的 Viu 保持原顺序及仅可用时显示的规则。
    if (viu && viu.status === STATUS.OK) {
      services.splice(4, 0, { name: "Viu", result: viu });
    }

    if (args.notify === "true" && args.mode !== "collapsed") {
      try { notifyUnlockChanges(services); }
      catch { MediaLog.log("[media-check] 通知或状态存储失败，继续显示面板。"); }
    }

    const lines = services.map(s => Utils.buildLine(s.name, s.result, s.suffix));
    const totalCount = services.length;
    const goodCount = services.filter(s => s.result.status === STATUS.OK || s.result.status === STATUS.COMING).length;
    const hasFailed = services.some(s => IS_STASH ? s.result.status !== STATUS.OK
      : [STATUS.FAIL, STATUS.ERROR, STATUS.TIMEOUT].includes(s.result.status));
    
    finishPanel({
      title: `${hasFailed ? ICONS.WARNING : ICONS.SUCCESS} 可用性检测 ${goodCount}/${totalCount}`,
      content: lines.join("\n"),
      icon: "play.circle.fill",
      backgroundColor: hasFailed ? ICONS.COLORS.WARNING : ICONS.COLORS.SUCCESS
    });
  } catch (error) {
    MediaLog.log(`[media-check v${CONFIG.VERSION}] 脚本异常：${Utils.errorDetails(error)}`);
    finishPanel({
      title: "❌ 检测失败",
      content: `错误: ${error.message || error}`,
      icon: "exclamationmark.triangle.fill",
      backgroundColor: "#FF6B6B"
    });
  }
})();
