/**
 * =============================================================================
 * @description  流媒体与AI服务解锁检测 (Stream Services & AI Unlock Check)
 * @version      1.4.3 (HBO Max Optimized)
 * @author       HotKids&ChatGPT
 * * 支持的服务：
 * - 流媒体: Netflix (含价格), Disney+, HBO Max, YouTube Premium, Spotify
 * - AI 服务: ChatGPT, Claude AI, Gemini API (需配置 API Key)
 * - 社交平台: Reddit
 * * 功能特性：
 * - 并发检测，响应速度快
 * - 自动识别地区代码
 * - Netflix 价格显示（默认开启，可通过 nfprice=false 关闭）
 * - Gemini API 检测（可选，需提供有效 API Key）
 * - HBO Max 严格风控检测（模拟官方完整握手流程）
 * - 统一的状态显示（可用/即将推出/不可用/超时/错误）
 * * 使用方法：
 * 1. 添加到 Surge Module 或 Panel
 * 2. 可选参数（在 argument 中配置）：
 * - geminiapikey=YOUR_API_KEY  启用 Gemini API 检测
 * - nfprice=false              关闭 Netflix 价格显示（默认开启）
 * 3. 切换代理节点后点击面板即可查看解锁状态
 * * 返回状态说明：
 * - 🟢 绿色: 所有检测服务均可用
 * - 🟡 黄色: 部分服务不可用、检测失败或检测到 VPN
 * * =============================================================================
 */

/**
 * =============================================================================
 * 全局配置
 * =============================================================================
 */

// 请求配置
const CONFIG = {
  UA: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  TIMEOUT: 8000, // 适当增加超时以适应 HBO 复杂流程
  CHROME_VERSION: "131.0.6778"
};

// 检测状态码
const STATUS = {
  OK: 1,          // 服务可用
  COMING: 2,      // 即将推出
  FAIL: 0,        // 不可用/检测到VPN
  TIMEOUT: -1,    // 请求超时
  ERROR: -2       // 检测错误
};

// 显示图标和颜色
const ICONS = {
  SUCCESS: "🟢",
  WARNING: "🟡",
  COLORS: {
    SUCCESS: "#3CB371",
    WARNING: "#DAA520"
  }
};

/**
 * =============================================================================
 * 工具类 - 提供通用方法
 * =============================================================================
 */
class Utils {
  /**
   * 发起 HTTP 请求（支持 GET/POST）
   * @param {Object} options - 请求配置
   * @returns {Promise<{status: number, headers: Object, body: string}>}
   */
  static request(options) {
    return new Promise((resolve, reject) => {
      const {
        url,
        method = "GET",
        headers = { "User-Agent": CONFIG.UA, "Accept-Language": "en" },
        body = null,
        timeout = CONFIG.TIMEOUT
      } = options;

      // 自动合并基础 UA
      const finalHeaders = { ...headers };
      if (!finalHeaders["User-Agent"]) {
        finalHeaders["User-Agent"] = CONFIG.UA;
      }

      const timer = setTimeout(() => reject("Timeout"), timeout);

      const callback = (error, response, data) => {
        clearTimeout(timer);
        if (error) return reject(error);
        resolve({
          status: response.status,
          headers: response.headers || {},
          body: data || ""
        });
      };

      const reqOpts = { url, headers: finalHeaders, body };
      method === "POST"
        ? $httpClient.post(reqOpts, callback)
        : $httpClient.get(reqOpts, callback);
    });
  }

  /**
   * 解析 Surge 参数字符串
   * @param {string} argString - 参数字符串 (key1=value1&key2=value2)
   * @returns {Object} 解析后的参数对象
   */
  static parseArgs(argString) {
    if (!argString) return {};
    return Object.fromEntries(
      argString.split("&").map(p => {
        const [key, ...valueParts] = p.split("=");
        return [key, valueParts.join("=")];
      })
    );
  }

  /**
   * 构建显示行
   * @param {string} name - 服务名称
   * @param {Object} result - 检测结果 {status, region}
   * @param {string} suffix - 额外信息（价格/VPN提示）
   * @returns {string} 格式化的显示行
   */
  static buildLine(name, result, suffix = "") {
    const statusMap = {
      [STATUS.OK]: result.region || "OK",
      [STATUS.COMING]: `${result.region || "N/A"} (Coming)`,
      [STATUS.FAIL]: result.region || "No",
      [STATUS.TIMEOUT]: "Timeout",
      [STATUS.ERROR]: result.region || "Error"
    };
    
    let displayStatus = statusMap[result.status];
    // 如果是 Fail 且有具体原因（如 VPN），优先显示具体原因
    if (result.status === STATUS.FAIL && result.region && result.region !== "No") {
      displayStatus = result.region; 
    }
    
    const suffixStr = suffix ? ` | ${suffix}` : "";
    
    return `${name.padEnd(11)} ➟ ${displayStatus}${suffixStr}`;
  }

  /**
   * 创建标准检测结果对象
   * @param {number} status - 状态码
   * @param {string} region - 地区代码
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
      return match
        ? this.createResult(STATUS.OK, match[1]?.toUpperCase())
        : this.createResult(STATUS.FAIL);
    } catch {
      return this.createResult(STATUS.FAIL);
    }
  }
}

/**
 * =============================================================================
 * 服务检测器 - 各平台解锁检测实现
 * =============================================================================
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
          const region = urlHeader.split("/")[3]?.split("-")[0]?.toUpperCase() || "US";
          return Utils.createResult(STATUS.OK, region);
        }
      } catch {
        return Utils.createResult(STATUS.ERROR);
      }
      return Utils.createResult(STATUS.FAIL);
    };

    let result = await checkFilm(80062035);
    if (result.status !== STATUS.OK && result.code === 404) {
      result = await checkFilm(80018499);
    }
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
   * 通过主页和 API 双重验证，判断是否解锁及即将推出状态
   * @returns {Promise<Object>} 检测结果
   */
  static async checkDisney() {
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
        return Utils.createResult(isSupported ? STATUS.OK : STATUS.COMING, region);
      }
      return homeRes.valid ? Utils.createResult(STATUS.OK, region) : Utils.createResult(STATUS.FAIL);
    } catch { return Utils.createResult(STATUS.ERROR); }
  }

  /**
   * HBO Max 解锁检测 (Strict Mode)
   * 模拟官方完整流程：Token -> Bootstrap -> User Region -> Website List -> VPN Check
   * @returns {Promise<Object>} 检测结果
   */
  static async checkHBOMax() {
    try {
      // Step 1: 获取匿名 Token (使用完整 Headers 避免风控)
      const tokenRes = await Utils.request({
        url: "https://default.any-any.prd.api.hbomax.com/token?realm=bolt&deviceId=afbb5daa-c327-461d-9460-d8e4b3ee4a1f",
        headers: {
          "x-device-info": "beam/5.0.0 (desktop/desktop; Windows/10; afbb5daa-c327-461d-9460-d8e4b3ee4a1f/da0cdd94-5a39-42ef-aa68-54cbc1b852c3)",
          "x-disco-client": "WEB:10:beam:5.2.1",
          "Accept": "application/json, text/plain, */*"
        }
      });

      if (tokenRes.status !== 200) return Utils.createResult(STATUS.ERROR, "Network Error");
      const token = JSON.parse(tokenRes.body)?.data?.attributes?.token;
      if (!token) return Utils.createResult(tokenRes.status >= 400 ? STATUS.FAIL : STATUS.ERROR, "Token Error");
      
      const cookieSt = `st=${token}`;

      // Step 2: 获取 Bootstrap 信息 (Routing)
      const bootstrapRes = await Utils.request({
        url: "https://default.any-any.prd.api.hbomax.com/session-context/headwaiter/v1/bootstrap",
        method: "POST",
        headers: { "Cookie": cookieSt, "Accept": "application/json, text/plain, */*" }
      });
      const route = JSON.parse(bootstrapRes.body)?.routing;
      if (!route || !route.domain) return Utils.createResult(STATUS.ERROR, "Route Error");

      // Step 3: 获取用户地区 (/users/me)
      const userRes = await Utils.request({
        url: `https://default.${route.tenant}-${route.homeMarket}.${route.env}.${route.domain}/users/me`,
        headers: { "Cookie": cookieSt, "Accept": "application/json, text/plain, */*" }
      });

      if (userRes.status >= 400) return Utils.createResult(STATUS.FAIL, `HTTP ${userRes.status}`);
      const region = JSON.parse(userRes.body)?.data?.attributes?.currentLocationTerritory;
      if (!region) return Utils.createResult(STATUS.FAIL, "No Region");

      // Step 4: 官网支持列表校验 (Double Check)
      let allowed = [];
      try {
        const homeRes = await Utils.request({ url: "https://www.max.com/" });
        if (homeRes.body) {
          const matches = homeRes.body.match(/"url":"\/([a-z]{2})\/[a-z]{2}"/g) || [];
          allowed = matches.map(m => {
            const m2 = m.match(/"url":"\/([a-z]{2})\/[a-z]{2}"/);
            return m2 ? m2[1].toUpperCase() : null;
          }).filter(Boolean);
        }
      } catch {}

      // Step 5: 播放接口 VPN 检测
      let isVPN = false;
      try {
        const vpnRes = await Utils.request({
          url: "https://default.any-any.prd.api.hbomax.com/any/playback/v1/playbackInfo",
          headers: { "Cookie": cookieSt, "Accept": "application/json, text/plain, */*" }
        });
        if (vpnRes.body && /VPN/i.test(vpnRes.body)) isVPN = true;
      } catch {}

      // 综合判断
      const inList = !allowed.length || allowed.includes(region);
      if (!inList) return Utils.createResult(STATUS.FAIL, region); // 地区不在官网列表
      if (isVPN) return Utils.createResult(STATUS.FAIL, `${region} (VPN)`); // 检测到 VPN
      
      return Utils.createResult(STATUS.OK, region);

    } catch (e) {
      return Utils.createResult(STATUS.ERROR, "Error");
    }
  }

  /**
   * YouTube Premium 解锁检测
   * 检测是否被重定向到 google.cn
   * @returns {Promise<Object>} 检测结果
   */
  static async checkYoutube() {
    try {
      const res = await Utils.request({ url: "https://www.youtube.com/premium" });
      if (res.body.includes("www.google.cn")) return Utils.createResult(STATUS.FAIL, "CN");
      if (res.body.includes("Premium is not available")) return Utils.createResult(STATUS.FAIL);
      const region = res.body.match(/"countryCode":"(.*?)"/)?.[1];
      return region ? Utils.createResult(STATUS.OK, region) : Utils.createResult(STATUS.FAIL);
    } catch { return Utils.createResult(STATUS.ERROR); }
  }

  /**
   * Spotify 解锁检测
   * 通过正则匹配 URL 中的地区代码
   * @returns {Promise<Object>} 检测结果
   */
  static checkSpotify() {
    return Utils.checkByRegex("https://www.spotify.com/premium/", /spotify\.com\/([a-z]{2})\//);
  }

  /**
   * ChatGPT 解锁检测
   * 通过 Cloudflare trace 获取 IP 地区
   * @returns {Promise<Object>} 检测结果
   */
  static checkChatGPT() {
    return Utils.checkByRegex("https://chat.openai.com/cdn-cgi/trace", /loc=([A-Z]{2})/);
  }

  /**
   * Claude AI 解锁检测
   * 通过访问登录页判断是否有地区限制
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
   * 需要用户提供有效的 API Key（通过参数 geminiapikey 传入）
   * * 检测逻辑：
   * - 无效 Key 或模板占位符：返回 null（不显示）
   * - API Key 错误：显示 "Invalid API Key"
   * - 地区限制：显示 "No"
   * - 正常可用：显示 "OK"
   * * @returns {Promise<Object|null>} 检测结果或 null
   */
  static async checkGemini() {
    const args = Utils.parseArgs($argument);
    const apiKey = (args.geminiapikey || "").trim();

    // 过滤无效 API Key：空值、模板占位符、特殊字符
    const invalidKeys = ["{", "}", "0", "null"];
    if (!apiKey || invalidKeys.some(k => apiKey.toLowerCase().includes(k))) {
      return null;
    }

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
      const res = await Utils.request({ url });
      const body = res.body.toLowerCase();

      if (res.status === 200 && body.includes('"models"')) {
        return Utils.createResult(STATUS.OK, "OK");
      }

      if (res.status === 400 || body.includes("key not valid") || body.includes("api_key_invalid")) {
        return Utils.createResult(STATUS.ERROR, "Invalid API Key");
      }

      if (res.status === 403 || body.includes("region not supported") || body.includes("location is not supported")) {
        return Utils.createResult(STATUS.FAIL, "No");
      }

      return Utils.createResult(STATUS.ERROR, "Invalid API Key");
    } catch {
      return Utils.createResult(STATUS.ERROR, "Invalid API Key");
    }
  }

  /**
   * Reddit 解锁检测
   * 检测 Reddit 可访问性
   * @returns {Promise<Object>} 检测结果
   */
  static async checkReddit() {
    try {
      const res = await Utils.request({
        url: "https://oauth.reddit.com",
        headers: { "Accept": "application/json" }
      });
      if (res.status === 200 || res.status === 401) return Utils.createResult(STATUS.OK, "OK");
      return Utils.createResult(STATUS.FAIL, res.status === 403 ? "IP Blocked" : "No");
    } catch { return Utils.createResult(STATUS.TIMEOUT, "Timeout"); }
  }
}

/**
 * =============================================================================
 * 主流程 - 执行检测并输出结果
 * =============================================================================
 */
(async () => {
  try {
    // 并发执行所有服务检测
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

    // 获取 Netflix 价格（默认开启，可通过 nfprice=false 关闭）
    const args = Utils.parseArgs($argument);
    const netflixPrice = (netflix.status === STATUS.OK && args.nfprice !== "false")
      ? await ServiceChecker.getNetflixPrice(netflix.region) 
      : "";

    // 构建服务列表（过滤掉 Gemini 和 Reddit 的 null 结果）
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

    // 生成显示内容
    const lines = services.map(s => Utils.buildLine(s.name, s.result, s.suffix));
    
    // 统计可用服务数量
    const totalCount = services.length;
    const goodCount = services.filter(s => 
      s.result.status === STATUS.OK || s.result.status === STATUS.COMING
    ).length;

    // 判断整体状态（有任何失败/错误/超时则显示警告）
    const hasFailed = services.some(s => 
      [STATUS.FAIL, STATUS.ERROR, STATUS.TIMEOUT].includes(s.result.status)
    );

    // 设置图标和颜色
    const icon = hasFailed ? ICONS.WARNING : ICONS.SUCCESS;
    const color = hasFailed ? ICONS.COLORS.WARNING : ICONS.COLORS.SUCCESS;

    // 输出到 Surge Panel
    $done({
      title: `${icon} 可用性检测 ${goodCount}/${totalCount}`,
      content: lines.join("\n"),
      icon: "play.circle.fill",
      "icon-color": color
    });
  } catch (error) {
    // 全局错误处理
    $done({
      title: "❌ 检测失败",
      content: `错误: ${error.message || error}`,
      icon: "exclamationmark.triangle.fill",
      "icon-color": "#FF6B6B"
    });
  }
})();