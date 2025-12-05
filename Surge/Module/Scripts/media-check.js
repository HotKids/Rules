/*
 * 流媒体解锁检测脚本
 * 包含：Netflix, Disney+, YouTube Premium, Spotify, ChatGPT, Claude
 * 更新：修复 Claude 检测逻辑，移除严格状态码限制
 */

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.61 Safari/537.36";
const REQUEST_HEADERS = {
  "User-Agent": UA,
  "Accept-Language": "en"
};

// ===== 状态常量 =====
const STATUS = {
  OK: 1,
  COMING: 2,
  FAIL: 0,
  TIMEOUT: -1,
  ERROR: -2
};

// ===== 核心工具函数：统一请求封装 =====
/**
 * 发送请求的通用函数，内置超时处理
 * @param {Object} options - { url, method, headers, body, timeout }
 */
function request(options) {
  return new Promise((resolve, reject) => {
    const { url, method = "GET", headers = REQUEST_HEADERS, body = null, timeout = 6000 } = options;
    
    // 超时计时器
    const timer = setTimeout(() => reject("Timeout"), timeout);
    
    const callback = (error, response, data) => {
      clearTimeout(timer);
      if (error) return reject(error);
      resolve({ status: response.status, headers: response.headers || {}, body: data || "" });
    };

    const reqOpts = { url, headers, body };
    if (method === "POST") {
      $httpClient.post(reqOpts, callback);
    } else {
      $httpClient.get(reqOpts, callback);
    }
  });
}

// ===== UI 辅助函数 =====
function buildLine(name, result) {
  let regionStr = result.region || "N/A";
  // 如果是 Coming Soon 状态，添加标注
  if (result.status === STATUS.COMING) regionStr += " (Coming)";
  // 如果是失败状态，根据具体错误显示
  if (result.status === STATUS.TIMEOUT) regionStr = "Timeout";
  if (result.status === STATUS.ERROR) regionStr = "Error";
  if (result.status === STATUS.FAIL) regionStr = "No";
  
  // 对于 Claude 这种只需判断是否可用的，特殊处理显示 OK/No
  if (name === "Claude" && result.status === STATUS.OK) regionStr = "OK";

  return `${name.padEnd(9, " ")} ➟ ${regionStr}`;
}

// ===== 各大流媒体检测逻辑 =====

// 1. YouTube Premium
async function checkYoutube() {
  try {
    const res = await request({ url: "https://www.youtube.com/premium" });
    if (res.body.includes("Premium is not available in your country")) {
      return { status: STATUS.FAIL, region: "" };
    }
    const regionMatch = res.body.match(/"countryCode":"(.*?)"/);
    if (regionMatch) {
      return { status: STATUS.OK, region: regionMatch[1] };
    }
    return { status: STATUS.FAIL, region: "" };
  } catch (e) {
    return { status: STATUS.ERROR, region: "" };
  }
}

// 2. Netflix
async function checkNetflix() {
  const checkFilm = async (id) => {
    try {
      const res = await request({ url: "https://www.netflix.com/title/" + id });
      if (res.status === 403) return { status: STATUS.FAIL };
      if (res.status === 404) return { status: STATUS.ERROR, code: 404 }; // 特殊标记用于重试
      if (res.status === 200) {
        // 尝试从 header 获取地区，如果获取不到默认为 US
        const url = res.headers["x-originating-url"] || res.headers["X-Originating-URL"] || "";
        const region = url.split("/")[3]?.split("-")[0]?.toUpperCase() || "US";
        return { status: STATUS.OK, region };
      }
    } catch { return { status: STATUS.ERROR }; }
    return { status: STATUS.FAIL };
  };

  // 第一次检测
  let res = await checkFilm(80062035);
  if (res.status === STATUS.OK) return res;
  if (res.code === 404) {
    // 第一次 404，尝试第二个影片（检测自制剧）
    res = await checkFilm(80018499);
  }
  return res.status === STATUS.OK ? res : { status: STATUS.FAIL, region: "" };
}

// 3. Spotify
async function checkSpotify() {
  try {
    const res = await request({ url: "https://www.spotify.com/premium/" });
    const match = res.body.match(/spotify\.com\/([a-z]{2})\//);
    if (match) {
      return { status: STATUS.OK, region: match[1].toUpperCase() };
    }
    return { status: STATUS.FAIL, region: "" };
  } catch {
    return { status: STATUS.FAIL, region: "" };
  }
}

// 4. ChatGPT
async function checkChatGPT() {
  try {
    const res = await request({ url: "https://chat.openai.com/cdn-cgi/trace" });
    const match = res.body.match(/loc=([A-Z]{2})/);
    if (match) {
      return { status: STATUS.OK, region: match[1] };
    }
    return { status: STATUS.FAIL, region: "" };
  } catch {
    return { status: STATUS.FAIL, region: "" };
  }
}

// 5. Claude (修复：放宽状态码判定)
async function checkClaude() {
  try {
    // 使用 /login 路径通常更稳定，也可以改回首页
    const res = await request({ url: "https://claude.ai/login" });
    
    // 逻辑修复：不检查 res.status === 200。
    // 因为 Claude 经常返回 403 (Cloudflare) 或 302 (跳转)，这些在之前的脚本里只要有 body 就视为 Good。
    // 只有明确包含 "app-unavailable-in-region" 才视为 Bad。
    if (res.body && !res.body.includes("app-unavailable-in-region")) {
      return { status: STATUS.OK, region: "OK" };
    }
    return { status: STATUS.FAIL, region: "" };
  } catch {
    return { status: STATUS.FAIL, region: "" };
  }
}

// 6. Disney+ (核心逻辑优化版)
async function checkDisney() {
  // 子任务：检测主页 (获取 Region 和 CNBL)
  const testHomePage = async () => {
    try {
      const res = await request({ url: "https://www.disneyplus.com/" });
      if (res.status !== 200 || res.body.indexOf('Sorry, Disney+ is not available in your region.') !== -1) {
        return { valid: false };
      }
      const match = res.body.match(/Region: ([A-Za-z]{2})[\s\S]*?CNBL: ([12])/);
      return match ? { valid: true, region: match[1], cnbl: match[2] } : { valid: true, region: "", cnbl: "" };
    } catch { return { valid: false }; }
  };

  // 子任务：获取 API 位置信息
  const getLocationInfo = async () => {
    try {
      const graphqlQuery = {
        query: 'mutation registerDevice($input: RegisterDeviceInput!) { registerDevice(registerDevice: $input) { grant { grantType assertion } } }',
        variables: {
          input: {
            applicationRuntime: 'chrome',
            attributes: {
              browserName: 'chrome', browserVersion: '94.0.4606', manufacturer: 'apple', model: null,
              operatingSystem: 'macintosh', operatingSystemVersion: '10.15.7', osDeviceIds: [],
            },
            deviceFamily: 'browser', deviceLanguage: 'en', deviceProfile: 'macosx',
          },
        },
      };
      
      const res = await request({
        url: 'https://disney.api.edge.bamgrid.com/graph/v1/device/graphql',
        method: 'POST',
        headers: {
          ...REQUEST_HEADERS,
          'Authorization': 'ZGlzbmV5JmJyb3dzZXImMS4wLjA.Cu56AgSfBTDag5NiRA81oLHkDZfu5L3CKadnefEAY84',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(graphqlQuery)
      });

      if (res.status !== 200) return { valid: false };
      
      const data = JSON.parse(res.body);
      if (data?.errors) return { valid: false };

      const { session } = data?.extensions?.sdk || {};
      return { 
        valid: true, 
        inSupportedLocation: session?.inSupportedLocation, 
        countryCode: session?.location?.countryCode 
      };
    } catch { return { valid: false }; }
  };

  // 并行执行 Disney 的两个检测请求
  try {
    const [homeRes, locRes] = await Promise.all([testHomePage(), getLocationInfo()]);
    
    // 综合判定
    // 优先使用 API 返回的 countryCode，其次是主页的 Region
    const region = locRes.countryCode || homeRes.region || "";
    
    // 判定逻辑
    if (locRes.valid) {
      if (locRes.inSupportedLocation === false || locRes.inSupportedLocation === 'false') {
        return { status: STATUS.COMING, region };
      }
      return { status: STATUS.OK, region };
    } else if (homeRes.valid) {
      // API 失败但主页成功，兜底逻辑
      return { status: STATUS.OK, region };
    }
    
    return { status: STATUS.FAIL, region: "" };
  } catch (e) {
    return { status: STATUS.ERROR, region: "" };
  }
}

// ===== 主流程 =====

;(async () => {
  // 并发执行所有检测任务
  const [nf, dy, yt, sp, cg, cl] = await Promise.all([
    checkNetflix(),
    checkDisney(),
    checkYoutube(),
    checkSpotify(),
    checkChatGPT(),
    checkClaude()
  ]);

  // 构建面板内容
  const lines = [
    buildLine("Netflix", nf),
    buildLine("Disney+", dy),
    buildLine("YouTube", yt),
    buildLine("Spotify", sp),
    buildLine("ChatGPT", cg),
    buildLine("Claude", cl)
  ];

  // 计算状态颜色
  const allResults = [nf, dy, yt, sp, cg, cl];
  const goodCount = allResults.filter(r => r.status === STATUS.OK || r.status === STATUS.COMING).length;
  // 只要有一个是 Fail/Error，图标就变黄，全绿才变绿
  const hasBad = allResults.some(r => r.status === STATUS.FAIL || r.status === STATUS.ERROR || r.status === STATUS.TIMEOUT);
  
  const titleIcon = hasBad ? "🟡" : "🟢";
  const iconColor = hasBad ? "#DAA520" : "#3CB371";

  $done({
    title: `${titleIcon} 可用性检测 ${goodCount}/6`,
    content: lines.join("\n"),
    icon: "play.circle.fill",
    "icon-color": iconColor
  });
})();
