/**
 * =============================================================================
 * 流媒体解锁检测脚本 - Surge Panel Script
 * =============================================================================
 * @description  检测代理节点对各大流媒体和 AI 服务的解锁状态
 * @version      1.7.0 (HBO Max Detection Fix - 2025-12-16)
 * @author       HotKids & ChatGPT & Claude
 * 
 * ═══════════════════════════════════════════════════════════════════════════
 * 📋 支持的服务
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * 🎬 流媒体服务
 *    ├─ Netflix       含价格显示（可选关闭）
 *    ├─ Disney+       支持 Hotstar 地区识别（ID/MY/TH/PH 等东南亚地区）
 *    ├─ HBO Max       支持第三方平台识别（JP/KR/CA）
 *    ├─ YouTube       双重请求机制，准确检测
 *    └─ Spotify       标准地区检测
 * 
 * 🤖 AI 服务
 *    ├─ ChatGPT       OpenAI 服务检测
 *    ├─ Claude AI     Anthropic 服务检测
 *    └─ Gemini API    Google AI 检测（需提供 API Key）
 * 
 * 🌐 社交平台
 *    └─ Reddit        地区访问检测
 * 
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚙️ 功能特性
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * • 🚀 并发检测技术，响应速度快
 * • 🌍 自动识别并显示地区代码
 * • 🍿 Netflix 价格显示（默认开启，可通过 nfprice=false 关闭）
 * • 🐭 Disney+ Hotstar 地区特殊标识（ID, MY, TH, PH 等东南亚地区 Disney+ Hotstar 现已更名为 Disney+ 此脚本仅作特殊标识以作区分）
 * • 🧙‍♂️ HBO Max 智能检测
 *     - 🇯🇵 JP 地区：验证 U-NEXT 可用性
 *       • U-NEXT 可用 → "JP (U-NEXT)"（黄灯⚠️）
 *       • U-NEXT 不可用 → "JP (No)"（黄灯⚠️）
 *     - 🇰🇷 KR 地区：显示 "KR (Coupang Play)"（通过 Coupang Play 提供，黄灯⚠️）
 *     - 🇨🇦 CA 地区：显示 "CA (Crave)"（通过 Bell Media 的 Crave 提供，黄灯⚠️）
 *     - 其他地区：从主页提取可用地区列表，判断是否可用
 *       • 可用 → 显示地区码（绿灯✅）
 *       • 不可用 → 显示 "地区码 (No)"（黄灯⚠️）
 *     - VPN 检测：显示 "地区码 (VPN)"（黄灯⚠️）
 *     - 参考 RegionRestrictionCheck 项目优化
 * • 📺 YouTube Premium 增强检测
 *     - 双重请求机制（带/不带 Cookie）
 *     - 检查 purchaseButtonOverride 和 Start trial 标识
 *     - 始终显示地区码（如能提取）
 *     - 参考 RegionRestrictionCheck 项目优化
 * • ✨ Gemini API 可选检测（需提供有效 API Key）
 * 
 * ═══════════════════════════════════════════════════════════════════════════
 * 📖 使用方法
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * 1. 添加到 Surge Module 或 Panel
 * 2. 可选参数：
 *    • geminiapikey=YOUR_KEY    启用 Gemini API 检测
 *    • nfprice=false            关闭 Netflix 价格显示
 * 3. 切换代理节点后点击面板刷新查看解锁状态
 * 
 * ═══════════════════════════════════════════════════════════════════════════
 * 🎨 状态指示
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * 🟢 绿色：所有检测服务均可用
 * 🟡 黄色：部分服务不可用、检测失败或检测到 VPN
 * 
 * ═══════════════════════════════════════════════════════════════════════════
 * 📝 更新日志
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * v1.7.0 (2025-12-16) - HBO Max 检测完全重写
 * ┌─────────────────────────────────────────────────────────────────────────
 * │ ✨ HBO Max 检测逻辑重写
 * │   • 参考 RegionRestrictionCheck 开源项目的检测方法
 * │   • 从主页提取可用地区列表（提取 "url":"/xx/xx" 格式链接）
 * │   • 判断 API 返回的地区码是否在可用列表中
 * │   • 第三方平台特殊标识：
 * │     - JP (U-NEXT) - 日本通过 U-NEXT 提供
 * │     - CA (Crave) - 加拿大通过 Bell Media 的 Crave 提供
 * │     - KR (Coupang Play) - 韩国通过 Coupang Play 提供
 * │   • 移除不可靠的 geo-availability 页面检测
 * │   • 修复误判问题，提高检测准确性
 * │
 * │ ✨ Disney+ Hotstar 地区调整
 * │   • 移除 IN（印度）的 Hotstar 标识，正常显示为 IN
 * │   • 保留东南亚 Hotstar 地区：ID, MY, PH, TH, VN
 * │   • SG（新加坡）正常显示，不标识为 Hotstar
 * └─────────────────────────────────────────────────────────────────────────
 * 
 * =============================================================================
 */

// 全局配置常量
const CONFIG = {
  UA: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  TIMEOUT: 8000,
  CHROME_VERSION: "131.0.6778"
};

// 检测状态码定义
const STATUS = { OK: 1, COMING: 2, FAIL: 0, TIMEOUT: -1, ERROR: -2 };

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
      const timer = setTimeout(() => reject("Timeout"), timeout);

      const cb = (err, resp, data) => {
        clearTimeout(timer);
        if (err) return reject(err);
        resolve({ status: resp.status, headers: resp.headers || {}, body: data || "" });
      };

      const reqOpts = { url, headers: finalHeaders, body };
      method === "POST" ? $httpClient.post(reqOpts, cb) : $httpClient.get(reqOpts, cb);
    });
  }

  /**
   * 解析 Surge 参数字符串
   * @param {string} argString - 参数字符串 (key1=value1&key2=value2)
   * @returns {Object} 解析后的参数对象
   */
  static parseArgs(argString) {
    if (!argString) return {};
    return Object.fromEntries(argString.split("&").map(p => {
      const [k, ...v] = p.split("=");
      return [k, v.join("=")];
    }));
  }

  /**
   * 构建显示行
   * @param {string} name - 服务名称
   * @param {Object} result - 检测结果 {status, region}
   * @param {string} suffix - 额外信息（如价格）
   * @returns {string} 格式化的显示行
   */
  static buildLine(name, result, suffix = "") {
    const statusMap = {
      [STATUS.OK]: result.region || "OK",
      [STATUS.COMING]: result.region?.includes("(") ? result.region : `${result.region || "N/A"} (Coming)`,
      [STATUS.FAIL]: result.region || "No",
      [STATUS.TIMEOUT]: "Timeout",
      [STATUS.ERROR]: result.region || "Error"
    };
    
    // 优先显示具体失败原因（如 VPN、Region Blocked）
    let displayStatus = (result.status === STATUS.FAIL && result.region && result.region !== "No") 
      ? result.region 
      : statusMap[result.status];
    
    return `${name.padEnd(11)} ➟ ${displayStatus}${suffix ? ` | ${suffix}` : ""}`;
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
    } catch {
      return this.createResult(STATUS.FAIL);
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
        if (res.status === 403) return Utils.createResult(STATUS.FAIL);
        if (res.status === 404) return { ...Utils.createResult(STATUS.ERROR), code: 404 };
        
        if (res.status === 200) {
          const urlHeader = res.headers["x-originating-url"] || res.headers["X-Originating-URL"] || "";
          let region = urlHeader.split("/")[3]?.split("-")[0]?.toUpperCase();
          // 修复：如果提取到 "TITLE" 或为空，则默认为 US
          if (region === "TITLE" || !region) region = "US";
          return Utils.createResult(STATUS.OK, region);
        }
      } catch { return Utils.createResult(STATUS.ERROR); }
      return Utils.createResult(STATUS.FAIL);
    };

    // 使用两个不同的影片 ID 进行检测，提高准确性
    let result = await checkFilm(80062035);
    if (result.status !== STATUS.OK && result.code === 404) result = await checkFilm(80018499);
    return result.status === STATUS.OK ? result : Utils.createResult(STATUS.FAIL);
  }

  /**
   * Netflix 价格查询（辅助方法）
   * @param {string} region - 地区代码
   * @returns {Promise<string>} 价格字符串
   */
  static async getNetflixPrice(region) {
    try {
      const res = await Utils.request({ url: "https://raw.githubusercontent.com/tompec/netflix-prices/main/data/latest.json" });
      if (res.status !== 200) return "";
      const country = JSON.parse(res.body).find(i => i.country_code === region);
      const plan = country?.plans?.find(p => p.name === "premium");
      return plan ? `${plan.price} ${country.currency}` : "";
    } catch { return ""; }
  }

  /**
   * Disney+ 解锁检测
   * 东南亚 Hotstar 地区（ID, MY, PH, TH, VN，不含 SG 和 IN）显示为 Hotstar
   * @returns {Promise<Object>} 检测结果
   */
  static async checkDisney() {
    const HOTSTAR_REGIONS = ['ID', 'MY', 'PH', 'TH', 'VN'];
    
    const checkHomePage = async () => {
      try {
        const res = await Utils.request({ url: "https://www.disneyplus.com/" });
        if (res.status !== 200 || res.body.includes('Sorry, Disney+ is not available')) return { valid: false };
        const match = res.body.match(/Region: ([A-Za-z]{2})[\s\S]*?CNBL: ([12])/);
        return match ? { valid: true, region: match[1] } : { valid: true, region: "" };
      } catch { return { valid: false }; }
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
      } catch { return { valid: false }; }
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
        
        if (HOTSTAR_REGIONS.includes(region)) return { status: STATUS.COMING, region: `${region} (Hotstar)` };
        return Utils.createResult(isSupported ? STATUS.OK : STATUS.COMING, region);
      }
      
      // 修复：主页检测通过但无地区码时也返回 FAIL
      if (homeRes.valid) {
        return homeRes.region 
          ? Utils.createResult(STATUS.OK, homeRes.region)
          : Utils.createResult(STATUS.FAIL, "No");
      }
      
      return Utils.createResult(STATUS.FAIL);
    } catch { return Utils.createResult(STATUS.ERROR); }
  }

  /**
   * U-NEXT 解锁检测（内部辅助函数）
   * 用于 HBO Max JP 地区验证，不单独显示
   * @returns {Promise<Object>} 检测结果
   */
  static async checkUNext() {
    try {
      const payload = {
        "operationName": "cosmo_getPlaylistUrl",
        "variables": {
          "code": "ED00467205",
          "playMode": "caption",
          "bitrateLow": 192,
          "bitrateHigh": null,
          "validationOnly": false
        },
        "query": `query cosmo_getPlaylistUrl($code: String, $playMode: String, $bitrateLow: Int, $bitrateHigh: Int, $validationOnly: Boolean) {
  webfront_playlistUrl(
    code: $code
    playMode: $playMode
    bitrateLow: $bitrateLow
    bitrateHigh: $bitrateHigh
    validationOnly: $validationOnly
  ) {
    subTitle
    playToken
    playTokenHash
    beaconSpan
    result {
      errorCode
      errorMessage
      __typename
    }
    resultStatus
    licenseExpireDate
    urlInfo {
      code
      startPoint
      resumePoint
      endPoint
      endrollStartPosition
      holderId
      saleTypeCode
      sceneSearchList {
        IMS_AD1
        IMS_L
        IMS_M
        IMS_S
        __typename
      }
      movieProfile {
        cdnId
        type
        playlistUrl
        movieAudioList {
          audioType
          __typename
        }
        licenseUrlList {
          type
          licenseUrl
          __typename
        }
        __typename
      }
      umcContentId
      movieSecurityLevelCode
      captionFlg
      dubFlg
      commodityCode
      movieAudioList {
        audioType
        __typename
      }
      __typename
    }
    __typename
  }
}`
      };
      
      const tmpresult = await Utils.request({
        url: "https://cc.unext.jp/",
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": CONFIG.UA },
        body: JSON.stringify(payload)
      });
      
      if (!tmpresult.body) return Utils.createResult(STATUS.ERROR, "Error");
      
      const result = JSON.parse(tmpresult.body)?.data?.webfront_playlistUrl?.resultStatus;
      
      // 475/200 表示可用
      if (result === 475 || result === "475" || result === 200 || result === "200") {
        return Utils.createResult(STATUS.OK, "OK");
      } else if (result === 467 || result === "467") {
        return Utils.createResult(STATUS.FAIL, "No");
      } else {
        return Utils.createResult(STATUS.ERROR, `Code: ${result}`);
      }
    } catch {
      return Utils.createResult(STATUS.ERROR, "Error");
    }
  }

  /**
   * HBO Max 解锁检测（修复版 - 基于 Debug 验证）
   * JP 地区优先验证 U-NEXT 可用性，其他地区正常检测
   * @returns {Promise<Object>} 检测结果
   */
  /**
   * HBO Max 解锁检测
   * 特殊处理：JP (U-NEXT)、CA (Crave)、KR (Coupang Play)
   * 参考 RegionRestrictionCheck 项目逻辑
   * @returns {Promise<Object>} 检测结果
   */
  static async checkHBOMax() {
    try {
      // Step 1: 从主页提取可用地区列表
      let availableRegions = [];
      try {
        const homeRes = await Utils.request({ url: `https://www.hbomax.com/?t=${Date.now()}`, timeout: 8000 });
        if (homeRes.body) {
          // 提取所有 "url":"/xx/xx" 格式的地区链接
          const regex = /"url":"\/([a-z]{2})\/[a-z]{2}"/gi;
          let match;
          const regions = new Set();
          while ((match = regex.exec(homeRes.body)) !== null) {
            regions.add(match[1].toUpperCase());
          }
          availableRegions = Array.from(regions);
        }
      } catch {}

      // Step 2: Token 获取
      const tokenRes = await Utils.request({
        url: "https://default.any-any.prd.api.hbomax.com/token?realm=bolt&deviceId=afbb5daa-c327-461d-9460-d8e4b3ee4a1f",
        headers: {
          "x-device-info": "beam/5.0.0 (desktop/desktop; Windows/10; afbb5daa-c327-461d-9460-d8e4b3ee4a1f/da0cdd94-5a39-42ef-aa68-54cbc1b852c3)",
          "x-disco-client": "WEB:10:beam:5.2.1",
          "Accept": "application/json, text/plain, */*"
        }
      });
      if (tokenRes.status !== 200) return Utils.createResult(STATUS.FAIL, "No");
      
      let tokenData;
      try {
        tokenData = JSON.parse(tokenRes.body);
      } catch {
        return Utils.createResult(STATUS.FAIL, "No");
      }
      
      const token = tokenData?.data?.attributes?.token;
      if (!token) return Utils.createResult(STATUS.FAIL, "No");
      
      const commonHeaders = { "Cookie": `st=${token}`, "Accept": "application/json, text/plain, */*" };

      // Step 3: Bootstrap
      const bootstrapRes = await Utils.request({
        url: "https://default.any-any.prd.api.hbomax.com/session-context/headwaiter/v1/bootstrap",
        method: "POST",
        headers: commonHeaders
      });
      
      let bootstrapData;
      try {
        bootstrapData = JSON.parse(bootstrapRes.body);
      } catch {
        return Utils.createResult(STATUS.FAIL, "No");
      }
      
      const route = bootstrapData?.routing;
      if (!route?.domain) return Utils.createResult(STATUS.FAIL, "No");

      // Step 4: User Region
      const userRes = await Utils.request({
        url: `https://default.${route.tenant}-${route.homeMarket}.${route.env}.${route.domain}/users/me`,
        headers: commonHeaders
      });
      
      if (userRes.status === 401 || userRes.status === 403) {
        return Utils.createResult(STATUS.FAIL, "No");
      }
      
      let region = "";
      try {
        const userData = JSON.parse(userRes.body);
        region = userData?.data?.attributes?.currentLocationTerritory || "";
      } catch {}
      
      if (!region || region.length !== 2) {
        return Utils.createResult(STATUS.FAIL, "No");
      }

      // Step 5: JP 特殊处理 - 优先验证 U-NEXT
      if (region === "JP") {
        const unextResult = await ServiceChecker.checkUNext();
        if (unextResult.status === STATUS.OK) {
          return Utils.createResult(STATUS.COMING, "JP (U-NEXT)");
        } else {
          return Utils.createResult(STATUS.FAIL, "JP (No)");
        }
      }
      
      // Step 5.5: CA 和 KR 特殊处理 - 通过第三方平台提供
      if (region === "CA") {
        return Utils.createResult(STATUS.COMING, "CA (Crave)");
      }
      if (region === "KR") {
        return Utils.createResult(STATUS.COMING, "KR (Coupang Play)");
      }
      
      // Step 6: 判断 region 是否在可用地区列表中
      const isAvailable = availableRegions.includes(region);
      if (!isAvailable) {
        return Utils.createResult(STATUS.FAIL, `${region} (No)`);
      }
      
      // Step 7: VPN 检测
      let isVPN = false;
      try {
        const vpnRes = await Utils.request({
          url: "https://default.any-any.prd.api.hbomax.com/any/playback/v1/playbackInfo",
          headers: commonHeaders,
          timeout: 5000
        });
        if (vpnRes.body && /VPN/i.test(vpnRes.body)) {
          isVPN = true;
        }
      } catch {}

      if (isVPN) {
        return Utils.createResult(STATUS.FAIL, `${region} (VPN)`);
      }
      
      return Utils.createResult(STATUS.OK, region);
      
    } catch {
      return Utils.createResult(STATUS.FAIL, "No");
    }
  }

  /**
   * YouTube Premium 解锁检测
   * 采用双重请求机制（参考 RegionRestrictionCheck），提高检测准确性
   * @returns {Promise<Object>} 检测结果
   */
  static async checkYoutube() {
    try {
      // 第一次请求：带 Cookie
      const tmpresult1 = await Utils.request({
        url: "https://www.youtube.com/premium",
        headers: { 
          "Cookie": "YSC=BiCUU3-5Gdk; CONSENT=YES+cb.20220301-11-p0.en+FX+700; GPS=1; VISITOR_INFO1_LIVE=4VwPMkB7W5A; PREF=tz=Asia.Shanghai; _gcl_au=1.1.1809531354.1646633279",
          "Accept-Language": "en",
          "User-Agent": CONFIG.UA 
        }
      });
      
      // 第二次请求：不带 Cookie
      const tmpresult2 = await Utils.request({
        url: "https://www.youtube.com/premium",
        headers: {
          "Accept-Language": "en",
          "User-Agent": CONFIG.UA
        }
      });
      
      // 合并两次结果
      const combinedBody = tmpresult1.body + ":" + tmpresult2.body;
      
      // 检查是否为大陆
      if (combinedBody.includes('www.google.cn')) {
        return Utils.createResult(STATUS.FAIL, "CN");
      }
      
      // 提取地区码
      const region = combinedBody.match(/"countryCode":"([A-Z]{2})"/)?.[1];
      
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
      
    } catch { return Utils.createResult(STATUS.ERROR, "Error"); }
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
   * @returns {Promise<Object>} 检测结果
   */
  static checkChatGPT() {
    return Utils.checkByRegex("https://chat.openai.com/cdn-cgi/trace", /loc=([A-Z]{2})/);
  }

  /**
   * Claude AI 解锁检测
   * @returns {Promise<Object>} 检测结果
   */
  static async checkClaude() {
    try {
      const res = await Utils.request({ url: "https://claude.ai/login" });
      return (res.body && !res.body.includes("app-unavailable-in-region"))
        ? Utils.createResult(STATUS.OK, "OK")
        : Utils.createResult(STATUS.FAIL, "No");
    } catch { return Utils.createResult(STATUS.FAIL, "No"); }
  }

  /**
   * Gemini API 解锁检测
   * @returns {Promise<Object|null>} 检测结果或 null
   */
  static async checkGemini() {
    const args = Utils.parseArgs($argument);
    const apiKey = (args.geminiapikey || "").trim();
    if (!apiKey || ["{", "}", "0", "null"].some(k => apiKey.toLowerCase().includes(k))) return null;

    try {
      const res = await Utils.request({ url: `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}` });
      const body = res.body.toLowerCase();
      
      if (res.status === 200 && body.includes('"models"')) return Utils.createResult(STATUS.OK, "OK");
      if (res.status === 403 || body.includes("region not supported") || body.includes("location is not supported")) {
        return Utils.createResult(STATUS.FAIL, "Region Blocked");
      }
      if (res.status === 400 || body.includes("key not valid") || body.includes("api_key_invalid")) {
        return Utils.createResult(STATUS.ERROR, "Invalid API Key");
      }
      return Utils.createResult(STATUS.ERROR, "Invalid API Key");
    } catch { return Utils.createResult(STATUS.ERROR, "Invalid API Key"); }
  }

  /**
   * Reddit 解锁检测
   * @returns {Promise<Object>} 检测结果
   */
  static async checkReddit() {
    try {
      const res = await Utils.request({ url: "https://oauth.reddit.com", headers: { "Accept": "application/json" } });
      if (res.status === 200 || res.status === 401) return Utils.createResult(STATUS.OK, "OK");
      return Utils.createResult(STATUS.FAIL, res.status === 403 ? "IP Blocked" : "No");
    } catch { return Utils.createResult(STATUS.TIMEOUT, "Timeout"); }
  }
}

/**
 * 主流程 - 执行检测并输出结果
 */
(async () => {
  try {
    const results = await Promise.all([
      ServiceChecker.checkNetflix(),
      ServiceChecker.checkDisney(),
      ServiceChecker.checkHBOMax(),
      ServiceChecker.checkYoutube(),
      ServiceChecker.checkSpotify(),
      ServiceChecker.checkChatGPT(),
      ServiceChecker.checkClaude(),
      ServiceChecker.checkGemini(),
      ServiceChecker.checkReddit()
    ]);

    const [netflix, disney, hbomax, youtube, spotify, chatgpt, claude, gemini, reddit] = results;
    const args = Utils.parseArgs($argument);
    const netflixPrice = (netflix.status === STATUS.OK && args.nfprice !== "false")
      ? await ServiceChecker.getNetflixPrice(netflix.region)
      : "";

    const services = [
      { name: "Netflix", result: netflix, suffix: netflixPrice },
      { name: "Disney+", result: disney },
      { name: "HBO Max", result: hbomax },
      { name: "YouTube", result: youtube },
      { name: "Spotify", result: spotify },
      { name: "ChatGPT", result: chatgpt },
      { name: "Claude", result: claude },
      gemini && { name: "Gemini API", result: gemini },
      { name: "Reddit", result: reddit }
    ].filter(Boolean);

    const lines = services.map(s => Utils.buildLine(s.name, s.result, s.suffix));
    const totalCount = services.length;
    const goodCount = services.filter(s => s.result.status === STATUS.OK || s.result.status === STATUS.COMING).length;
    const hasFailed = services.some(s => [STATUS.FAIL, STATUS.ERROR, STATUS.TIMEOUT].includes(s.result.status));
    
    $done({
      title: `${hasFailed ? ICONS.WARNING : ICONS.SUCCESS} 可用性检测 ${goodCount}/${totalCount}`,
      content: lines.join("\n"),
      icon: "play.circle.fill",
      "icon-color": hasFailed ? ICONS.COLORS.WARNING : ICONS.COLORS.SUCCESS
    });
  } catch (error) {
    $done({
      title: "❌ 检测失败",
      content: `错误: ${error.message || error}`,
      icon: "exclamationmark.triangle.fill",
      "icon-color": "#FF6B6B"
    });
  }
})();
