/**
 * =============================================================================
 * @description  流媒体与AI服务解锁检测 (Stream Services & AI Unlock Check)
 * @version      1.3.5 (HBO Max Optimized)
 * @author       HotKids&ChatGPT
 * * 支持的服务：
 * - 流媒体: Netflix, Disney+, HBO Max, YouTube, Spotify
 * - AI 服务: ChatGPT Region, Claude AI, Gemini API
 * - 社交平台: Reddit
 * * 返回状态说明：
 * - 🟢 绿色: 所有检测服务均可用
 * - 🟡 黄色: 部分服务不可用、检测失败或检测到 VPN
 * * 外部参数 (Argument):
 * - geminiapikey=[API_KEY] : 启用 Gemini 检测 (需填写真实 Key)
 * - nfprice=false          : 关闭 Netflix 价格显示 (默认开启)
 * =============================================================================
 */

// --- 全局配置 ---
const CONFIG = {
  UA: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  TIMEOUT: 8000, // 略微增加超时以适应 HBO 复杂流程
  CHROME_VERSION: "131.0.6778"
};

// --- 状态常量 ---
const STATUS = {
  OK: 1,       // 正常解锁
  COMING: 2,   // 即将推出
  FAIL: 0,     // 解锁失败/不支持/检测到VPN
  TIMEOUT: -1, // 请求超时
  ERROR: -2    // 网络或脚本错误
};

// --- 图标与颜色 ---
const ICONS = {
  SUCCESS: "🟢",
  WARNING: "🟡",
  COLORS: { SUCCESS: "#3CB371", WARNING: "#DAA520" }
};

// --- 基础工具类 ---
class Utils {
  static request(options) {
    return new Promise((resolve, reject) => {
      const { url, method = "GET", headers = {}, body = null, timeout = CONFIG.TIMEOUT } = options;
      const finalHeaders = { "User-Agent": CONFIG.UA, ...headers }; // 基础 UA
      
      const timer = setTimeout(() => reject("Timeout"), timeout);
      const cb = (err, resp, data) => {
        clearTimeout(timer);
        if (err) return reject(err);
        resolve({ status: resp.status, headers: resp.headers || {}, body: data || "" });
      };

      if (method === "POST") $httpClient.post({ url, headers: finalHeaders, body }, cb);
      else $httpClient.get({ url, headers: finalHeaders, body }, cb);
    });
  }

  static parseArgs(argStr) {
    if (!argStr) return {};
    return Object.fromEntries(argStr.split("&").map(i => {
      const [k, ...v] = i.split("=");
      return [k, v.join("=")];
    }));
  }

  static createResult(status, region = "") {
    return { status, region };
  }

  static async checkByRegex(url, regex) {
    try {
      const res = await this.request({ url });
      const match = res.body.match(regex);
      return match ? this.createResult(STATUS.OK, match[1].toUpperCase()) : this.createResult(STATUS.FAIL);
    } catch {
      return this.createResult(STATUS.FAIL);
    }
  }

  static buildLine(name, result, suffix = "") {
    const statusText = {
      [STATUS.OK]: result.region || "OK",
      [STATUS.COMING]: `${result.region || "N/A"} (Coming)`,
      [STATUS.FAIL]: result.region || "No",
      [STATUS.TIMEOUT]: "Timeout",
      [STATUS.ERROR]: result.region || "Error"
    };
    // 如果是 Fail 且有具体原因（如 VPN），显示具体原因
    let displayStatus = statusText[result.status];
    if (result.status === STATUS.FAIL && result.region && result.region !== "No") {
      displayStatus = result.region; 
    }
    
    return `${name.padEnd(11)} ➟ ${displayStatus}${suffix ? ` | ${suffix}` : ""}`;
  }
}

// --- 服务检测核心类 ---
class ServiceChecker {
  // 1. Netflix
  static async checkNetflix() {
    const checkId = async (id) => {
      try {
        const res = await Utils.request({ url: `https://www.netflix.com/title/${id}` });
        if (res.status === 200) {
          const region = (res.headers["x-originating-url"] || res.headers["X-Originating-URL"] || "").split("/")[3]?.split("-")[0]?.toUpperCase() || "US";
          return Utils.createResult(STATUS.OK, region);
        }
        if (res.status === 404) return { status: STATUS.ERROR, code: 404 };
        return Utils.createResult(STATUS.FAIL);
      } catch { return Utils.createResult(STATUS.ERROR); }
    };
    let r = await checkId(80062035);
    if (r.status === STATUS.ERROR && r.code === 404) r = await checkId(80018499);
    return r.status === STATUS.OK ? r : Utils.createResult(STATUS.FAIL);
  }

  static async getNetflixPrice(region) {
    try {
      const res = await Utils.request({ url: "https://raw.githubusercontent.com/tompec/netflix-prices/main/data/latest.json" });
      if (res.status !== 200) return "";
      const country = JSON.parse(res.body).find(i => i.country_code === region);
      const plan = country?.plans?.find(p => p.name === "premium");
      return plan ? `${plan.price} ${country.currency}` : "";
    } catch { return ""; }
  }

  // 2. Disney+
  static async checkDisney() {
    try {
      const home = Utils.request({ url: "https://www.disneyplus.com/" });
      const api = Utils.request({
        url: 'https://disney.api.edge.bamgrid.com/graph/v1/device/graphql',
        method: 'POST',
        headers: { "Authorization": "ZGlzbmV5JmJyb3dzZXImMS4wLjA.Cu56AgSfBTDag5NiRA81oLHkDZfu5L3CKadnefEAY84", "Content-Type": "application/json" },
        body: JSON.stringify({ query: 'mutation registerDevice($input: RegisterDeviceInput!) { registerDevice(registerDevice: $input) { grant { grantType assertion } } }', variables: { input: { applicationRuntime: 'chrome', attributes: { browserName: 'chrome', browserVersion: CONFIG.CHROME_VERSION, operatingSystem: 'macintosh', operatingSystemVersion: '10.15.7' }, deviceFamily: 'browser', deviceLanguage: 'en', deviceProfile: 'macosx' } } })
      });

      const [hRes, aRes] = await Promise.all([home, api]);
      let apiValid = false, apiRegion = "", supported = false;
      if (aRes.status === 200) {
        try {
          const d = JSON.parse(aRes.body);
          if (!d.errors) {
            apiValid = true;
            const s = d.extensions?.sdk?.session;
            supported = s?.inSupportedLocation !== false && s?.inSupportedLocation !== 'false';
            apiRegion = s?.location?.countryCode;
          }
        } catch {}
      }
      let homeRegion = "";
      if (hRes.status === 200 && !hRes.body.includes('not available')) {
        const m = hRes.body.match(/Region: ([A-Za-z]{2})/);
        homeRegion = m ? m[1] : "";
      }
      const finalRegion = apiRegion || homeRegion || "";
      if (apiValid) return Utils.createResult(supported ? STATUS.OK : STATUS.COMING, finalRegion);
      return homeRegion ? Utils.createResult(STATUS.OK, homeRegion) : Utils.createResult(STATUS.FAIL);
    } catch { return Utils.createResult(STATUS.ERROR); }
  }

  // 3. HBO Max (完全恢复 max-debug.js 逻辑)
  static async checkHBOMax() {
    try {
      // Step 1: Token
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

      // Step 2: Bootstrap
      const bootstrapRes = await Utils.request({
        url: "https://default.any-any.prd.api.hbomax.com/session-context/headwaiter/v1/bootstrap",
        method: "POST",
        headers: { "Cookie": cookieSt, "Accept": "application/json, text/plain, */*" }
      });
      const route = JSON.parse(bootstrapRes.body)?.routing;
      if (!route || !route.domain) return Utils.createResult(STATUS.ERROR, "Route Error");

      // Step 3: User Region
      const userRes = await Utils.request({
        url: `https://default.${route.tenant}-${route.homeMarket}.${route.env}.${route.domain}/users/me`,
        headers: { "Cookie": cookieSt, "Accept": "application/json, text/plain, */*" }
      });

      if (userRes.status >= 400) return Utils.createResult(STATUS.FAIL, `HTTP ${userRes.status}`);
      const region = JSON.parse(userRes.body)?.data?.attributes?.currentLocationTerritory;
      if (!region) return Utils.createResult(STATUS.FAIL, "No Region");

      // Step 4: Website Check (重要: 还原官网列表校验)
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

      // Step 5: VPN Check
      let isVPN = false;
      try {
        const vpnRes = await Utils.request({
          url: "https://default.any-any.prd.api.hbomax.com/any/playback/v1/playbackInfo",
          headers: { "Cookie": cookieSt, "Accept": "application/json, text/plain, */*" }
        });
        if (vpnRes.body && /VPN/i.test(vpnRes.body)) isVPN = true;
      } catch {}

      // 综合判断逻辑 (严格一致)
      const inList = !allowed.length || allowed.includes(region);
      if (!inList) return Utils.createResult(STATUS.FAIL, region); // 虽然有地区，但不在官网支持列表 -> 视为失败
      if (isVPN) return Utils.createResult(STATUS.FAIL, `${region} (VPN)`); // 虽然有地区，但检测到 VPN -> 视为失败
      
      return Utils.createResult(STATUS.OK, region);

    } catch (e) {
      return Utils.createResult(STATUS.ERROR, "Error");
    }
  }

  // 4. YouTube
  static async checkYoutube() {
    try {
      const res = await Utils.request({ url: "https://www.youtube.com/premium" });
      if (res.body.includes("www.google.cn")) return Utils.createResult(STATUS.FAIL, "CN");
      if (res.body.includes("Premium is not available")) return Utils.createResult(STATUS.FAIL);
      const region = res.body.match(/"countryCode":"(.*?)"/)?.[1];
      return region ? Utils.createResult(STATUS.OK, region) : Utils.createResult(STATUS.FAIL);
    } catch { return Utils.createResult(STATUS.ERROR); }
  }

  // 5. Spotify
  static checkSpotify() {
    return Utils.checkByRegex("https://www.spotify.com/premium/", /spotify\.com\/([a-z]{2})\//);
  }

  // 6. ChatGPT
  static checkChatGPT() {
    return Utils.checkByRegex("https://chat.openai.com/cdn-cgi/trace", /loc=([A-Z]{2})/);
  }

  // 7. Claude
  static async checkClaude() {
    try {
      const res = await Utils.request({ url: "https://claude.ai/login" });
      return (res.body && !res.body.includes("app-unavailable-in-region")) ? Utils.createResult(STATUS.OK, "OK") : Utils.createResult(STATUS.FAIL, "No");
    } catch { return Utils.createResult(STATUS.FAIL, "No"); }
  }

  // 8. Gemini
  static async checkGemini() {
    const args = Utils.parseArgs($argument);
    const key = (args.geminiapikey || "").trim();
    if (!key || ["{", "null"].some(k => key.includes(k))) return null; 
    try {
      const res = await Utils.request({ url: `https://generativelanguage.googleapis.com/v1beta/models?key=${key}` });
      if (res.status === 200 && res.body.includes('"models"')) return Utils.createResult(STATUS.OK, "OK");
      if (res.status === 403 || res.body.includes("region not supported")) return Utils.createResult(STATUS.FAIL, "No");
      return Utils.createResult(STATUS.ERROR, "Invalid Key");
    } catch { return Utils.createResult(STATUS.ERROR, "Error"); }
  }

  // 9. Reddit
  static async checkReddit() {
    try {
      const res = await Utils.request({ url: "https://oauth.reddit.com", headers: { "Accept": "application/json" } });
      if (res.status === 200 || res.status === 401) return Utils.createResult(STATUS.OK, "OK");
      return Utils.createResult(STATUS.FAIL, res.status === 403 ? "IP Blocked" : "No");
    } catch { return Utils.createResult(STATUS.TIMEOUT, "Timeout"); }
  }
}

// --- 主程序入口 ---
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

    const [nf, dy, hbo, yt, sp, gpt, claude, gemini, reddit] = results;

    const args = Utils.parseArgs($argument);
    const nfPrice = (nf.status === STATUS.OK && args.nfprice !== "false") 
      ? await ServiceChecker.getNetflixPrice(nf.region) 
      : "";

    const list = [
      { name: "Netflix", res: nf, ext: nfPrice },
      { name: "Disney+", res: dy },
      { name: "HBO Max", res: hbo },
      { name: "YouTube", res: yt },
      { name: "Spotify", res: sp },
      { name: "ChatGPT", res: gpt },
      { name: "Claude", res: claude },
      gemini ? { name: "Gemini API", res: gemini } : null,
      { name: "Reddit", res: reddit }
    ].filter(Boolean);

    const content = list.map(i => Utils.buildLine(i.name, i.res, i.ext)).join("\n");
    
    // 任何非 OK 状态或 region 中包含文字说明（如 VPN）都视为 issue
    const hasIssue = list.some(i => 
      [STATUS.FAIL, STATUS.ERROR, STATUS.TIMEOUT].includes(i.res.status)
    );

    $done({
      title: `${hasIssue ? ICONS.WARNING : ICONS.SUCCESS} 可用性检测 ${list.filter(i => i.res.status === STATUS.OK || i.res.status === STATUS.COMING).length}/${list.length}`,
      content: content,
      icon: "play.circle.fill",
      "icon-color": hasIssue ? ICONS.COLORS.WARNING : ICONS.COLORS.SUCCESS
    });

  } catch (err) {
    $done({
      title: "❌ 脚本执行失败",
      content: `Error: ${err.message || err}`,
      icon: "exclamationmark.triangle.fill",
      "icon-color": "#FF6B6B"
    });
  }
})();