/**
 * =============================================================================
 * 流媒体 & AI 服务解锁检测脚本 - Surge Panel / Stash Tiles
 * =============================================================================
 * @description  检测代理节点对各大流媒体、AI 和社交平台的解锁状态
 * @version      2.1.2 (2026-09-29)
 * @source       https://github.com/HotKids/Rules/blob/master/Surge/Module/Scripts/media-check.js
 * @reference    https://github.com/StashNetworks/misc/tree/main/collapsed-tiles
 * @runtime      自动识别 Surge / Stash；检测逻辑共用，面板与请求参数分别适配
 * @arguments    service=netflix&nfprice=true&notify=false
 *               service 可选 netflix/disney/hbomax/youtube/spotify/chatgpt/gemini/claude/reddit
 *               Stash 不传 service 或传 service=all 时汇总；Surge 始终使用多行汇总
 *               mode=collapsed 由 Stash 选择检测节点，忽略 proxy 并关闭变化通知
 *               可选 proxy=URL编码后的节点名、notifykey=自定义通知分组
 * @routing      默认遵循所在客户端分流；proxy 指定代理，Stash 折叠模式由所选节点接管。
 * @author       HotKids & ChatGPT & Claude
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 📋 支持的服务（9 项）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 🎬 流媒体
 *    ├─ Netflix       含价格显示（可选关闭）、多级地区码提取
 *    ├─ Disney+       统一按地区与接口可用性判断
 *    ├─ HBO Max       官网结构化地区与可用性检测、第三方平台提示（JP/KR/CA）
 *    ├─ YouTube       双重请求机制（带/不带 Cookie）
 *    └─ Spotify       标准地区检测
 *
 * 🤖 AI 服务
 *    ├─ ChatGPT       单行显示地区 / Web Only / Mobile Only / NO
 *    ├─ Gemini        网页检测 + API Key fallback
 *    └─ Claude        地区可用性检测
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
  UA: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  TIMEOUT: 8000,
  CHROME_VERSION: "131.0.6778"
};

// 检测状态码定义
const STATUS = { OK: 1, COMING: 2, FAIL: 0, TIMEOUT: -1, ERROR: -2 };

// 面板参数（脚本级解析一次，主流程与 checkGemini 共用）
let ARGS = {};

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
      const finalHeaders = { "User-Agent": CONFIG.UA, "Accept-Language": "en", ...headers };
      if (IS_STASH && ARGS.proxy) finalHeaders["X-Stash-Selected-Proxy"] = encodeURIComponent(ARGS.proxy);
      let settled = false;
      const settle = (error, value) => {
        if (settled) return;
        settled = true;
        if (typeof clearTimeout === "function") clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      };
      // 脚本计时器用毫秒；Surge / Stash HTTP timeout 均用秒。
      const timer = setTimeout(() => settle(new Error("Timeout")), timeout);
      const cb = (error, response, data) => {
        if (settled) return;
        if (error) return settle(error);
        try {
          const status = Number(response && (response.status || response.statusCode));
          if (!status) return settle(new Error("Invalid Response"));
          if (status >= 500) return settle(new Error(`HTTP ${status}`));
          const normalizedHeaders = {};
          Object.entries(response.headers || {}).forEach(([key, value]) => {
            normalizedHeaders[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
          });
          settle(null, { status, headers: normalizedHeaders, body: data == null ? "" : String(data) });
        } catch (error) { settle(error); }
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
      } catch (error) { settle(error); }
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

  static errorResult(error) {
    const message = String(error && (error.message || error) || "");
    return /timeout|timed.?out|超时/i.test(message)
      ? this.createResult(STATUS.TIMEOUT, "Timeout")
      : this.createResult(STATUS.ERROR, "Error");
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

  /**
   * 通用正则匹配检测方法
   * @param {string} url - 检测 URL
   * @param {RegExp} regex - 正则表达式（需包含捕获组）
   * @param {Object} options - 额外的请求配置
   * @returns {Promise<Object>} 检测结果
   */
  static async checkByRegex(url, regex, options = {}) {
    try {
      const res = await this.request({ url, ...options });
      const match = res.body.match(regex);
      return match ? this.createResult(STATUS.OK, match[1]?.toUpperCase()) : this.createResult(STATUS.FAIL);
    } catch (error) {
      return this.errorResult(error);
    }
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
    const checkFilm = async (id) => {
      try {
        const res = await Utils.request({ url: `https://www.netflix.com/title/${id}` });
        return { httpStatus: res.status, body: res.body || "", headers: res.headers || {} };
      } catch (error) {
        return { httpStatus: -1, body: "", headers: {}, error };
      }
    };

    /**
     * 多级地区码提取（从 HTML body + 响应头）
     * 参考 RegionRestrictionCheck 项目
     */
    const extractRegion = (body, headers) => {
      // 1. 嵌入 JSON: "id":"xx" ... "countryName" (RegionRestrictionCheck 方案)
      let m = body.match(/"id"\s*:\s*"([a-z]{2})"[^}]*?"countryName"/);
      if (m) return m[1].toUpperCase();

      // 2. Body 内 URL 模式: netflix.com/xx(-yy)?/title/
      m = body.match(/netflix\.com\/([a-z]{2})(?:-[a-z]+)?\/title\//i);
      if (m) return m[1].toUpperCase();

      // 3. x-originating-url 响应头 (旧方案，部分节点仍有效)
      const urlHeader = headers["x-originating-url"] || headers["X-Originating-URL"] || "";
      const h = urlHeader.split("/")[3]?.split("-")[0]?.toUpperCase();
      if (h && h !== "TITLE") return h;

      return "";
    };

    // Film 1: LEGO Ninjago (非原创，用于区分完整解锁 vs Originals Only)
    const r1 = await checkFilm(81280792);

    if (r1.httpStatus === 403) return Utils.createResult(STATUS.FAIL);
    if (r1.httpStatus === -1) return Utils.errorResult(r1.error);

    // Film 1 可用且非 "Oh no!" → 完整解锁
    if (r1.httpStatus === 200 && !r1.body.includes("Oh no!")) {
      const region = extractRegion(r1.body, r1.headers) || "US";
      return Utils.createResult(STATUS.OK, region);
    }

    // Film 1 不可用 → 尝试 Film 2: Breaking Bad
    const r2 = await checkFilm(70143836);
    if (r2.httpStatus === -1) return Utils.errorResult(r2.error);

    if (r2.httpStatus === 200 && !r2.body.includes("Oh no!")) {
      const region = extractRegion(r2.body, r2.headers) || "US";
      return Utils.createResult(STATUS.OK, region);
    }

    // 两部影片均不可用，但至少一个返回了 200 → Originals Only
    if (r1.httpStatus === 200 || r2.httpStatus === 200) {
      const body = r1.httpStatus === 200 ? r1.body : r2.body;
      const headers = r1.httpStatus === 200 ? r1.headers : r2.headers;
      const region = extractRegion(body, headers);
      return Utils.createResult(STATUS.FAIL, region ? `${region} (Originals)` : "Originals Only");
    }

    return Utils.createResult(STATUS.FAIL);
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

    return Utils.request({ url: "https://raw.githubusercontent.com/tompec/netflix-prices/main/data/latest.json" })
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
    const checkHomePage = async () => {
      try {
        const res = await Utils.request({ url: "https://www.disneyplus.com/" });
        if (res.status !== 200 || res.body.includes('Sorry, Disney+ is not available')) return { valid: false };
        const match = res.body.match(/Region: ([A-Za-z]{2})[\s\S]*?CNBL: [12]/);
        return match ? { valid: true, region: match[1] } : { valid: true, region: "" };
      } catch (error) { return { valid: false, error }; }
    };

    const checkAPI = async () => {
      try {
        const res = await Utils.request({
          url: 'https://disney.api.edge.bamgrid.com/graph/v1/device/graphql',
          method: 'POST',
          headers: {
            "Authorization": "ZGlzbmV5JmJyb3dzZXImMS4wLjA.Cu56AgSfBTDag5NiRA81oLHkDZfu5L3CKadnefEAY84",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            query: 'mutation registerDevice($input: RegisterDeviceInput!) { registerDevice(registerDevice: $input) { grant { grantType assertion } } }',
            variables: { input: { applicationRuntime: 'chrome', attributes: { browserName: 'chrome', browserVersion: CONFIG.CHROME_VERSION, operatingSystem: 'macintosh', operatingSystemVersion: '10.15.7' }, deviceFamily: 'browser', deviceLanguage: 'en', deviceProfile: 'macosx' } }
          })
        });

        if (res.status !== 200) return { valid: false };
        const data = JSON.parse(res.body);
        if (data?.errors) return { valid: false };
        const session = data?.extensions?.sdk?.session;
        return {
          valid: true,
          inSupportedLocation: session?.inSupportedLocation,
          countryCode: session?.location?.countryCode
        };
      } catch (error) { return { valid: false, error }; }
    };

    try {
      const [homeRes, apiRes] = await Promise.all([checkHomePage(), checkAPI()]);
      const region = apiRes.countryCode || homeRes.region || "";

      if (apiRes.valid) {
        const isSupported = apiRes.inSupportedLocation !== false && apiRes.inSupportedLocation !== 'false';
        
        // 修复：无地区码时返回 FAIL 状态显示 "No"
        if (!region) {
          return Utils.createResult(STATUS.FAIL, "No");
        }
        
        return Utils.createResult(isSupported ? STATUS.OK : STATUS.COMING, region);
      }
      
      // 修复：主页检测通过但无地区码时也返回 FAIL
      if (homeRes.valid) {
        return homeRes.region 
          ? Utils.createResult(STATUS.OK, homeRes.region)
          : Utils.createResult(STATUS.FAIL, "No");
      }
      
      if (homeRes.error || apiRes.error) return Utils.errorResult(homeRes.error || apiRes.error);
      return Utils.createResult(STATUS.FAIL);
    } catch (error) { return Utils.errorResult(error); }
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
      console.log("[media-check][HBO Max] " + reason);
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
   * 采用双重请求机制（参考 RegionRestrictionCheck），提高检测准确性
   * @returns {Promise<Object>} 检测结果
   */
  static async checkYoutube() {
    try {
      // 带 Cookie / 不带 Cookie 两次请求互相独立，并行发起
      const [tmpresult1, tmpresult2] = await Promise.all([
        Utils.request({
          url: "https://www.youtube.com/premium",
          headers: {
            "Cookie": "YSC=BiCUU3-5Gdk; CONSENT=YES+cb.20220301-11-p0.en+FX+700; GPS=1; VISITOR_INFO1_LIVE=4VwPMkB7W5A; PREF=tz=Asia.Shanghai; _gcl_au=1.1.1809531354.1646633279",
            "Accept-Language": "en"
          }
        }),
        Utils.request({
          url: "https://www.youtube.com/premium",
          headers: { "Accept-Language": "en" }
        })
      ]);

      // 合并两次结果
      const combinedBody = tmpresult1.body + ":" + tmpresult2.body;
      
      // Stash 官方示例的明确地区限制提示优先于页面地区码。
      if (/youtube premium is not available in your country/i.test(combinedBody)) {
        return Utils.createResult(STATUS.FAIL, "NO");
      }
      // 检查是否为大陆
      if (combinedBody.includes('www.google.cn')) {
        return Utils.createResult(STATUS.FAIL, "CN");
      }
      
      // 提取地区码：countryCode 不一定有，contentRegion 一定有
      const region = combinedBody.match(/"countryCode":"([A-Z]{2})"/)?.[1]
                  || combinedBody.match(/"contentRegion":"([A-Z]{2})"/)?.[1];
      
      // 检查可用性标识
      const hasPurchaseButton = combinedBody.includes('purchaseButtonOverride');
      const hasStartTrial = combinedBody.includes('Start trial');
      
      // 判断逻辑：参考 RegionRestrictionCheck
      if (hasPurchaseButton || hasStartTrial || region) {
        // 可用
        if (region) {
          return Utils.createResult(STATUS.OK, region);
        } else {
          return Utils.createResult(STATUS.OK, "Premium");
        }
      } else {
        // 不可用
        if (region) {
          return Utils.createResult(STATUS.FAIL, region);
        } else {
          return Utils.createResult(STATUS.FAIL, "No");
        }
      }
      
    } catch (error) { return Utils.errorResult(error); }
  }

  /**
   * Spotify 解锁检测
   * @returns {Promise<Object>} 检测结果
   */
  static checkSpotify() {
    return Utils.checkByRegex("https://www.spotify.com/premium/", /spotify\.com\/([a-z]{2})\//);
  }

  /**
   * ChatGPT 解锁检测
   * 参考 lmc999/RegionRestrictionCheck：单行区分可用地区 / Web Only / Mobile Only / NO
   * @returns {Promise<Object>} 检测结果
   */
  static async checkChatGPT() {
    try {
      // 地区查询与 Web / App 检测并行；辅助查询失败仍保留可用性结果。
      const tracePromise = Utils.request({
        url: "https://chatgpt.com/cdn-cgi/trace", timeout: 3000
      }).catch(() => null);
      const [webRes, iosRes] = await Promise.all([
        Utils.request({
          url: "https://api.openai.com/compliance/cookie_requirements",
          headers: {
            "Authorization": "Bearer null",
            "Content-Type": "application/json",
            "Origin": "https://platform.openai.com",
            "Referer": "https://platform.openai.com/"
          }
        }),
        Utils.request({ url: "https://ios.chat.openai.com/" })
      ]);

      const webBlocked = /unsupported_country/i.test(webRes.body);
      const iosBlocked = /VPN|disallowed isp|been blocked/i.test(iosRes.body);

      if (!webBlocked && !iosBlocked) {
        const traceRes = await tracePromise;
        const region = (traceRes?.body || "").match(/loc=([A-Z]{2})/)?.[1] || "";
        return Utils.createResult(STATUS.OK, region || "OK");
      }
      if (webBlocked && iosBlocked) return Utils.createResult(STATUS.FAIL, "NO");
      if (!webBlocked && iosBlocked) return Utils.createResult(STATUS.COMING, "Web Only");
      return Utils.createResult(STATUS.COMING, "Mobile Only");
    } catch (error) { return Utils.errorResult(error); }
  }

  /**
   * Claude AI 解锁检测
   * login 可用性判断与 cdn-cgi/trace 地区码提取并发请求，仅在可用时采用地区码
   * @returns {Promise<Object>} 检测结果
   */
  static async checkClaude() {
    try {
      const [loginRes, traceRes] = await Promise.all([
        Utils.request({ url: "https://claude.ai/login" }),
        Utils.request({ url: "https://claude.ai/cdn-cgi/trace" }).catch(() => null)
      ]);
      if (!loginRes.body || loginRes.body.includes("app-unavailable-in-region")) {
        return Utils.createResult(STATUS.FAIL, "No");
      }
      const region = traceRes?.body.match(/loc=([A-Z]{2})/)?.[1] || "";
      return Utils.createResult(STATUS.OK, region || "OK");
    } catch (error) { return Utils.errorResult(error); }
  }

  /**
   * Gemini 解锁检测
   * 网页检测（参考 lmc999/RegionRestrictionCheck）+ API Key fallback
   * @returns {Promise<Object>} 检测结果
   */
  static async checkGemini() {
    // 网页检测：访问 gemini.google.com（参考 lmc999/RegionRestrictionCheck）
    let webResult = null;
    let requestError = null;
    try {
      const res = await Utils.request({ url: "https://gemini.google.com", timeout: 10000 });
      const body = res.body || "";

      if (body.includes("45631641,null,true")) {
        const m2 = body.match(/,2,1,200,"([A-Z]{2})"/);
        if (m2) return Utils.createResult(STATUS.OK, m2[1]);
        const m3 = body.match(/,2,1,200,"([A-Z]{3})"/);
        if (m3) return Utils.createResult(STATUS.OK, m3[1].substring(0, 2));
        // 有标记但无地区码 → 不可用
        return Utils.createResult(STATUS.FAIL, "No");
      }
      webResult = "fail";
    } catch (error) { requestError = error; }

    // API 检测 fallback（需要 Key）
    const apiKey = (ARGS.geminiapikey || "").trim();
    if (apiKey && !["0", "null", "undefined"].includes(apiKey.toLowerCase()) && !/[{}]/.test(apiKey)) {
      try {
        const res = await Utils.request({ url: `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}` });
        const body = (res.body || "").toLowerCase();
        if (res.status === 200 && body.includes('"models"')) return Utils.createResult(STATUS.OK, "OK");
        if (res.status === 429) return Utils.createResult(STATUS.OK, "OK");
        if (res.status === 400 || body.includes("key not valid") || body.includes("api_key_invalid")) {
          return Utils.createResult(STATUS.ERROR, "Invalid Key");
        }
      } catch (error) { requestError = error; }
    }

    if (requestError) return Utils.errorResult(requestError);
    return Utils.createResult(STATUS.FAIL, webResult ? "No" : "Unknown");
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
      return res.status === 200
        ? Utils.createResult(STATUS.OK, "OK")
        : Utils.createResult(STATUS.FAIL, "No");
    } catch (error) { return Utils.errorResult(error); }
  }

  /** Viu 仅供 Surge 可选检测：从最终页面中的 /ott/{area}/ 路径提取地区。 */
  static async checkViu() {
    try {
      const res = await Utils.request({ url: "https://www.viu.com/" });
      if (res.status !== 200) return Utils.createResult(STATUS.FAIL, "No");
      const m = (res.body || "").match(/\/ott\/([a-z]{2})[/"']/i);
      return m
        ? Utils.createResult(STATUS.OK, m[1].toUpperCase())
        : Utils.createResult(STATUS.FAIL, "No");
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
  chatgpt: { title: "ChatGPT", check: "checkChatGPT", url: "https://chatgpt.com", color: "#0D8A70" },
  gemini: { title: "Gemini", check: "checkGemini", url: "https://gemini.google.com", color: "#386EDB" },
  claude: { title: "Claude", check: "checkClaude", url: "https://claude.ai", color: "#B85C3F" },
  reddit: { title: "Reddit", check: "checkReddit", url: "https://www.reddit.com", color: "#D93900" }
};

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
  try { result = await ServiceChecker[definition.check](); }
  catch (error) { result = Utils.errorResult(error); }
  const suffix = prices && result.status === STATUS.OK
    ? await ServiceChecker.getNetflixPrice(prices, result.region) : "";
  if (ARGS.notify === "true" && ARGS.mode !== "collapsed") {
    try { notifyUnlockChanges([{ name: definition.title, result }]); }
    catch { console.log("[media-check] 通知或状态存储失败，继续显示面板。"); }
  }
  const content = Utils.buildContent(result, suffix);
  finishPanel({
    title: definition.title,
    content: content === "No" ? "NO" : content,
    // icon 由覆写配置提供，更新状态时保留各服务的 Logo。
    // 固定品牌底色，检测状态由 content 表达；使用完整六位色值。
    backgroundColor: definition.color,
    url: definition.url
  });
}

/** 主流程：Surge 汇总；Stash 按 service 检测，并兼容旧汇总配置。 */
(async () => {
  try {
    const args = ARGS = Utils.parseArgs(typeof $argument === "string" ? $argument : "");
    args.service = IS_STASH ? String(args.service || "").trim().toLowerCase() : "";
    args.mode = IS_STASH ? String(args.mode || "home").trim().toLowerCase() : "home";
    if (args.mode === "collapsed") args.proxy = "";
    if (args.service && args.service !== "all") {
      await runServiceTile(args.service);
      return;
    }
    // Netflix 价格表与各服务检测并行预取（仅在开启价格显示时）
    const pricesPromise = args.nfprice !== "false" ? ServiceChecker.fetchNetflixPrices() : null;
    const results = await Promise.all([
      ServiceChecker.checkNetflix(),
      ServiceChecker.checkDisney(),
      ServiceChecker.checkHBOMax(),
      ServiceChecker.checkYoutube(),
      ServiceChecker.checkSpotify(),
      ServiceChecker.checkChatGPT(),
      ServiceChecker.checkGemini(),
      ServiceChecker.checkClaude(),
      ServiceChecker.checkReddit(),
      !IS_STASH && args.viu === "true" ? ServiceChecker.checkViu() : Promise.resolve(null)
    ]);

    const [netflix, disney, hbomax, youtube, spotify, chatgpt, gemini, claude, reddit, viu] = results;
    const netflixPrice = (netflix.status === STATUS.OK && pricesPromise)
      ? await ServiceChecker.getNetflixPrice(pricesPromise, netflix.region)
      : "";

    const services = [
      { name: "Netflix", result: netflix, suffix: netflixPrice },
      { name: "Disney+", result: disney },
      { name: "HBO Max", result: hbomax },
      { name: "YouTube", result: youtube },
      { name: "Spotify", result: spotify },
      { name: "ChatGPT", result: chatgpt },
      { name: "Gemini", result: gemini },
      { name: "Claude", result: claude },
      { name: "Reddit", result: reddit }
    ];

    // Surge 的 Viu 保持原顺序及仅可用时显示的规则。
    if (viu && viu.status === STATUS.OK) {
      services.splice(4, 0, { name: "Viu", result: viu });
    }

    if (args.notify === "true" && args.mode !== "collapsed") {
      try { notifyUnlockChanges(services); }
      catch { console.log("[media-check] 通知或状态存储失败，继续显示面板。"); }
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
    finishPanel({
      title: "❌ 检测失败",
      content: `错误: ${error.message || error}`,
      icon: "exclamationmark.triangle.fill",
      backgroundColor: "#FF6B6B"
    });
  }
})();
