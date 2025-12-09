/**
 * =============================================================================
 * 流媒体解锁检测脚本 - Surge Panel Script
 * =============================================================================
 * 
 * @description  检测代理节点对各大流媒体和 AI 服务的解锁状态
 * @version      1.3.0
 * @author       HotKids&ChatGPT
 * 
 * 支持的服务：
 * - 流媒体: Netflix (含价格), Disney+, YouTube Premium, Spotify
 * - AI 服务: ChatGPT, Claude AI, Gemini API (需配置 API Key)
 * - 社交平台: Reddit (测试中不保证准确)
 * 
 * 功能特性：
 * - 并发检测，响应速度快
 * - 自动识别地区代码
 * - Netflix 价格显示（默认开启，可通过 nfprice=false 关闭）
 * - Gemini API 检测（可选，需提供有效 API Key）
 * - 统一的状态显示（可用/即将推出/不可用/超时/错误）
 * 
 * 使用方法：
 * 1. 添加到 Surge Module 或 Panel
 * 2. 可选参数（在 argument 中配置）：
 *    - geminiapikey=YOUR_API_KEY  启用 Gemini API 检测
 *    - nfprice=false              关闭 Netflix 价格显示（默认开启）
 * 3. 切换代理节点后点击面板即可查看解锁状态
 * 
 * 返回状态说明：
 * - 🟢 绿色: 所有检测服务均可用
 * - 🟡 黄色: 部分服务不可用或检测失败
 * 
 * =============================================================================
 */

/**
 * =============================================================================
 * 全局配置
 * =============================================================================
 */

// 请求配置
const CONFIG = {
  UA: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  TIMEOUT: 6000,
  CHROME_VERSION: "131.0.6778"
};

// 检测状态码
const STATUS = {
  OK: 1,          // 服务可用
  COMING: 2,      // 即将推出
  FAIL: 0,        // 不可用
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

      const reqOpts = { url, headers, body };
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
   * @param {string} price - 价格信息（可选）
   * @returns {string} 格式化的显示行
   */
  static buildLine(name, result, price = "") {
    const statusMap = {
      [STATUS.OK]: result.region || "OK",
      [STATUS.COMING]: `${result.region || "N/A"} (Coming)`,
      [STATUS.FAIL]: result.region || "No",
      [STATUS.TIMEOUT]: "Timeout",
      [STATUS.ERROR]: result.region || "Error"
    };
    
    const regionStr = statusMap[result.status] || "N/A";
    const priceStr = price ? ` | ${price}` : "";
    
    return `${name.padEnd(11)} ➟ ${regionStr}${priceStr}`;
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
 * Netflix 价格查询（默认开启）
 * =============================================================================
 * 从 GitHub 仓库获取最新的 Netflix 各地区价格数据
 * 
 * 使用参数：nfprice=false 可关闭价格显示（默认开启）
 * 
 * @param {string} region - 地区代码（如 US, JP, HK）
 * @returns {Promise<string>} 价格字符串（如 "22.99 USD"）或空字符串
 */
async function getNetflixPriceByRegion(region) {
  if (!region) return "";
  
  try {
    const res = await Utils.request({ 
      url: "https://raw.githubusercontent.com/tompec/netflix-prices/main/data/latest.json" 
    });
    if (res.status !== 200) return "";

    const data = JSON.parse(res.body);
    const country = data.find(i => i.country_code === region);
    const premium = country?.plans?.find(p => p.name === "premium");
    
    return premium ? `${premium.price} ${country.currency}` : "";
  } catch {
    return "";
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
   * Disney+ 解锁检测
   * 通过主页和 API 双重验证，判断是否解锁及即将推出状态
   * @returns {Promise<Object>} 检测结果
   */
  static async checkDisney() {
    const checkHomePage = async () => {
      try {
        const res = await Utils.request({ url: "https://www.disneyplus.com/" });

        if (res.status !== 200 || res.body.includes('Sorry, Disney+ is not available in your region.')) {
          return { valid: false };
        }

        const match = res.body.match(/Region: ([A-Za-z]{2})[\s\S]*?CNBL: ([12])/);
        return match
          ? { valid: true, region: match[1] }
          : { valid: true, region: "" };
      } catch {
        return { valid: false };
      }
    };

    const checkAPI = async () => {
      try {
        const res = await Utils.request({
          url: 'https://disney.api.edge.bamgrid.com/graph/v1/device/graphql',
          method: 'POST',
          headers: {
            "User-Agent": CONFIG.UA,
            "Accept-Language": "en",
            "Authorization": "ZGlzbmV5JmJyb3dzZXImMS4wLjA.Cu56AgSfBTDag5NiRA81oLHkDZfu5L3CKadnefEAY84",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            query: 'mutation registerDevice($input: RegisterDeviceInput!) { registerDevice(registerDevice: $input) { grant { grantType assertion } } }',
            variables: {
              input: {
                applicationRuntime: 'chrome',
                attributes: {
                  browserName: 'chrome',
                  browserVersion: CONFIG.CHROME_VERSION,
                  manufacturer: 'apple',
                  model: null,
                  operatingSystem: 'macintosh',
                  operatingSystemVersion: '10.15.7',
                  osDeviceIds: []
                },
                deviceFamily: 'browser',
                deviceLanguage: 'en',
                deviceProfile: 'macosx'
              }
            }
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
      } catch {
        return { valid: false };
      }
    };

    try {
      const [homeRes, apiRes] = await Promise.all([checkHomePage(), checkAPI()]);
      const region = apiRes.countryCode || homeRes.region || "";

      if (apiRes.valid) {
        const isSupported = apiRes.inSupportedLocation !== false && apiRes.inSupportedLocation !== 'false';
        return Utils.createResult(isSupported ? STATUS.OK : STATUS.COMING, region);
      }

      return homeRes.valid
        ? Utils.createResult(STATUS.OK, region)
        : Utils.createResult(STATUS.FAIL);
    } catch {
      return Utils.createResult(STATUS.ERROR);
    }
  }

  /**
   * YouTube Premium 解锁检测
   * @returns {Promise<Object>} 检测结果
   */
  static async checkYoutube() {
    try {
      const res = await Utils.request({ url: "https://www.youtube.com/premium" });

      if (res.body.includes("Premium is not available in your country")) {
        return Utils.createResult(STATUS.FAIL);
      }

      const match = res.body.match(/"countryCode":"(.*?)"/);
      return match
        ? Utils.createResult(STATUS.OK, match[1])
        : Utils.createResult(STATUS.FAIL);
    } catch {
      return Utils.createResult(STATUS.ERROR);
    }
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
    } catch {
      return Utils.createResult(STATUS.FAIL, "No");
    }
  }

  /**
   * Gemini API 解锁检测
   * 需要用户提供有效的 API Key（通过参数 geminiapikey 传入）
   * 
   * 检测逻辑：
   * - 无效 Key 或模板占位符：返回 null（不显示）
   * - API Key 错误：显示 "Invalid API Key"
   * - 地区限制：显示 "No"
   * - 正常可用：显示 "OK"
   * 
   * @returns {Promise<Object|null>} 检测结果或 null
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
   * 
   * @returns {Promise<Object>} 检测结果
   */
  static async checkReddit() {
    try {
      const res = await Utils.request({
        url: "https://oauth.reddit.com",
        headers: {
          "User-Agent": CONFIG.UA,
          "Accept": "application/json"
        }
      });

      if (res.status === 200 || res.status === 401) {
        return Utils.createResult(STATUS.OK, "OK");
      }

      return res.status === 403
        ? Utils.createResult(STATUS.FAIL, "IP Blocked")
        : Utils.createResult(STATUS.FAIL, "No");
    } catch {
      return Utils.createResult(STATUS.TIMEOUT, "Timeout");
    }
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
    const [netflix, disney, youtube, spotify, chatgpt, claude, gemini, reddit] = await Promise.all([
      ServiceChecker.checkNetflix(),
      ServiceChecker.checkDisney(),
      ServiceChecker.checkYoutube(),
      ServiceChecker.checkSpotify(),
      ServiceChecker.checkChatGPT(),
      ServiceChecker.checkClaude(),
      ServiceChecker.checkGemini(),
      ServiceChecker.checkReddit()
    ]);

    // 获取 Netflix 价格（默认开启，可通过 nfprice=false 关闭）
    const args = Utils.parseArgs($argument);
    const showPrice = args.nfprice !== "false";
    const netflixPrice = (netflix.status === STATUS.OK && showPrice)
      ? await getNetflixPriceByRegion(netflix.region) 
      : "";

    // 构建服务列表（过滤掉 Gemini 和 Reddit 的 null 结果）
    const services = [
      { name: "Netflix", result: netflix, price: netflixPrice },
      { name: "Disney+", result: disney },
      { name: "YouTube", result: youtube },
      { name: "Spotify", result: spotify },
      { name: "ChatGPT", result: chatgpt },
      { name: "Claude", result: claude },
      gemini && { name: "Gemini API", result: gemini },
      { name: "Reddit", result: reddit }
    ].filter(Boolean);

    // 生成显示内容
    const lines = services.map(s => Utils.buildLine(s.name, s.result, s.price));
    
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
    // 全局错误处理：捕获未预期的异常
    $done({
      title: "❌ 检测失败",
      content: `错误: ${error.message || error}`,
      icon: "exclamationmark.triangle.fill",
      "icon-color": "#FF6B6B"
    });
  }
})();
