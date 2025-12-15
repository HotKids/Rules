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
 * ② 出口 IP: ip.sb API
 * ③ 代理策略: Surge /v1/requests/recent
 * ④ 风险评分: IPQualityScore (主，需 API) → ProxyCheck (备) → Scamalytics (兜底)
 * ⑤ IP 类型: IPPure API
 * ⑥ 地理信息: ip.sb, ip-api.com API
 * 
 * 参数说明：
 * - TYPE: 设为 EVENT 表示网络变化触发（自动判断，无需手动设置）
 * - ipqs_key: IPQualityScore API Key (可选)
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
 * @version 3.0.1
 * @date 2025-12-15
 */

// ==================== 全局配置 ====================
const NAME = "ip-security";
const TIMEOUT = 10000; // 超时时间（毫秒）
const STORE_KEY_LAST_EVENT = "lastNetworkInfoEvent"; // 上次网络事件记录的存储键
const STORE_KEY_LAST_POLICY = "lastProxyPolicy"; // 上次代理策略的存储键

// ==================== 参数解析 ====================
let arg = {};
if (typeof $argument !== "undefined") {
  arg = Object.fromEntries($argument.split("&").map(i => i.split("=")));
}

// 从持久化存储读取参数（可选）
const storedArg = $persistentStore.read(NAME);
if (storedArg) {
  try {
    arg = { ...arg, ...JSON.parse(storedArg) };
  } catch (e) {}
}

// 自动判断触发类型
const isPanel = typeof $input !== "undefined" && $input.purpose === "panel";
const isRequest = typeof $request !== "undefined";

// 如果不是面板且不是请求，则认为是网络变化事件触发
if (!isPanel && !isRequest) {
  arg.TYPE = "EVENT";
}

// 提取配置参数
const IPQS_API_KEY = (arg.ipqs_key && arg.ipqs_key !== "null") ? arg.ipqs_key : "";
const EVENT_DELAY = parseFloat(arg.event_delay) || 2;

console.log("触发类型: " + (arg.TYPE === "EVENT" ? "EVENT" : "MANUAL"));

// ==================== 全局状态控制 ====================
let finished = false;

/**
 * 完成脚本执行并返回结果
 * @param {Object} o - 返回对象
 */
function done(o) {
  if (finished) return;
  finished = true;
  $done(o);
}

// 超时保护
setTimeout(() => {
  done({
    title: "检测超时",
    content: "API 请求超时",
    icon: "leaf",
    "icon-color": "#9E9E9E"
  });
}, TIMEOUT);

// ==================== HTTP 请求工具 ====================
/**
 * 发送 HTTP 请求并解析 JSON
 * @param {string} url - 请求地址
 * @param {string} [policy] - 可选的代理策略
 * @returns {Promise<Object|null>} JSON 对象或 null
 */
function httpJSON(url, policy) {
  return new Promise(r => {
    $httpClient.get(policy ? { url, policy } : { url }, (_, __, d) => {
      try { r(JSON.parse(d)); } catch { r(null); }
    });
  });
}

/**
 * 发送 HTTP 请求并返回原始文本
 * @param {string} url - 请求地址
 * @returns {Promise<string|null>} 原始响应文本或 null
 */
function httpRaw(url) {
  return new Promise(r => {
    $httpClient.get({ url }, (_, __, d) => r(d || null));
  });
}

/**
 * 延迟等待
 * @param {number} ms - 等待时间（毫秒）
 * @returns {Promise<void>}
 */
function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ==================== Surge API 交互 ====================
/**
 * 从 Surge 最近请求中获取实际使用的代理策略
 * 如果找不到匹配请求，会发送测试请求后重试
 * 如果仍然找不到，返回上次保存的策略
 * @returns {Promise<string>} 代理策略名称
 */
async function getPolicy() {
  return new Promise(r => {
    $httpAPI("GET", "/v1/requests/recent", null, res => {
      const hit = res?.requests
        ?.slice(0, 10)
        .find(i => /(api\.ip\.sb|ip-api\.com)/i.test(i.URL));
      r(hit?.policyName || null);
    });
  }).then(async policy => {
    if (policy) {
      console.log("找到代理策略: " + policy);
      // 保存策略供下次使用
      $persistentStore.write(policy, STORE_KEY_LAST_POLICY);
      return policy;
    }
    
    // 如果没找到，发一个测试请求
    console.log("未找到策略记录，发送测试请求");
    await httpJSON("https://api.ip.sb/geoip");
    
    // 等待请求完成后再查一次
    return new Promise(r => {
      setTimeout(() => {
        $httpAPI("GET", "/v1/requests/recent", null, res => {
          const hit = res?.requests
            ?.slice(0, 5)
            .find(i => /api\.ip\.sb/i.test(i.URL));
          
          if (hit?.policyName) {
            console.log("重试后找到策略: " + hit.policyName);
            // 保存策略供下次使用
            $persistentStore.write(hit.policyName, STORE_KEY_LAST_POLICY);
            r(hit.policyName);
          } else {
            // 如果还是找不到，读取上次保存的策略
            const lastPolicy = $persistentStore.read(STORE_KEY_LAST_POLICY);
            if (lastPolicy) {
              console.log("使用上次保存的策略: " + lastPolicy);
              r(lastPolicy);
            } else {
              console.log("无法找到任何策略信息");
              r("Unknown");
            }
          }
        });
      }, 500);  // 等待 500ms
    });
  });
}

// ==================== 数据处理工具 ====================
/**
 * 将国家代码转换为国旗 emoji
 * @param {string} cc - ISO 3166-1 alpha-2 国家代码
 * @returns {string} 国旗 emoji 或空字符串
 */
function flag(cc) {
  if (!cc || cc.length !== 2) return "";
  // 台湾地区回落到中国国旗（国行设备兼容）
  if (cc.toUpperCase() === "TW") cc = "CN";
  const b = 0x1f1e6;
  return String.fromCodePoint(
    b + cc.charCodeAt(0) - 65, 
    b + cc.charCodeAt(1) - 65
  );
}

/**
 * 根据风险分数返回对应的描述和颜色
 * @param {number} s - 风险分数 (0-100)
 * @returns {Array} [描述文本, 颜色代码]
 */
function riskText(s) {
  if (s <= 15) return ["极度纯净 IP", "#0D6E3D"];
  if (s <= 25) return ["纯净 IP", "#2E9F5E"];
  if (s <= 40) return ["一般 IP", "#8BC34A"];
  if (s <= 50) return ["微风险 IP", "#FFC107"];
  if (s <= 70) return ["一般风险 IP", "#FF9800"];
  return ["极度风险 IP", "#F44336"];
}

/**
 * 从 Scamalytics HTML 中解析风险分数
 * @param {string} html - HTML 内容
 * @returns {number|null} 风险分数或 null
 */
function parseScore(html) {
  const m = html?.match(/Fraud Score[^0-9]*([0-9]{1,3})/i);
  return m ? Number(m[1]) : null;
}

// ==================== 风险评分获取（三级回落） ====================
/**
 * 获取 IP 风险分数（三级回落策略）
 * 优先级：IPQualityScore → ProxyCheck → Scamalytics
 * @param {string} ip - 要检测的 IP
 * @returns {Promise<Object>} 包含分数和来源的对象 {score, source}
 */
async function getRiskScore(ip) {
  let score = null;
  let source = "";
  
  // 1. 尝试 IPQualityScore（需要 API Key）
  if (IPQS_API_KEY) {
    try {
      const ipqs = await httpJSON(
        "https://ipqualityscore.com/api/json/ip/" + IPQS_API_KEY + "/" + ip + "?strictness=1"
      );
      if (ipqs?.success && ipqs?.fraud_score !== undefined) {
        score = ipqs.fraud_score;
        source = "IPQS";
      }
    } catch (e) {
      console.log("IPQS 查询失败");
    }
  }
  
  // 2. 回落到 ProxyCheck.io（免费）
  if (score === null) {
    try {
      const proxycheck = await httpJSON(
        "https://proxycheck.io/v2/" + ip + "?risk=1&vpn=1"
      );
      if (proxycheck?.[ip]?.risk !== undefined) {
        score = proxycheck[ip].risk;
        source = "ProxyCheck";
      }
    } catch (e) {
      console.log("ProxyCheck 查询失败");
    }
  }
  
  // 3. 兜底使用 Scamalytics（免费）
  if (score === null) {
    try {
      const html = await httpRaw("https://scamalytics.com/ip/" + ip);
      score = parseScore(html);
      if (score !== null) {
        source = "Scamalytics";
      }
    } catch (e) {
      console.log("Scamalytics 查询失败");
    }
  }
  
  // 如果全部失败，返回默认值
  return { 
    score: score !== null ? score : 50, 
    source: source || "Default" 
  };
}

// ==================== 通知函数 ====================
/**
 * 发送系统通知（仅在 EVENT 模式下）
 * @param {string} title - 通知标题
 * @param {string} subtitle - 通知副标题
 * @param {string} content - 通知内容
 */
function notify(title, subtitle, content) {
  if (arg.TYPE === "EVENT") {
    $notification.post(title, subtitle, content);
  }
}

// ==================== 主执行函数 ====================
(async () => {
  console.log("=== IP 安全检测开始 ===");
  
  // EVENT 触发时延迟等待网络稳定
  if (arg.TYPE === "EVENT" && EVENT_DELAY > 0) {
    console.log("等待网络稳定 " + EVENT_DELAY + " 秒");
    await wait(EVENT_DELAY * 1000);
  }

  // ========== 1. 获取入口 IP（直连）==========
  const enter = await httpJSON(
    "https://api.bilibili.com/x/web-interface/zone",
    "DIRECT"
  );
  const inIP = enter?.data?.addr;

  // ========== 2. 获取出口 IP（代理）==========
  const exit = await httpJSON("https://api.ip.sb/geoip");
  const outIP = exit?.ip;
  
  // 尝试获取 IPv6（带超时）
  const exit6 = await Promise.race([
    httpJSON("https://api64.ip.sb/geoip"), 
    new Promise(r => setTimeout(() => r(null), 1500))
  ]);
  const outIP6 = exit6?.ip;

  // 验证 IP 获取成功
  if (!inIP || !outIP) {
    console.log("IP 获取失败");
    return done({
      title: "IP 获取失败",
      content: "无法获取入口或出口 IPv4",
      icon: "leaf",
      "icon-color": "#9E9E9E"
    });
  }

  console.log("入口 IP: " + inIP + ", 出口 IP: " + outIP);

  // ========== 3. EVENT 触发时检查 IP 是否变化 ==========
  if (arg.TYPE === "EVENT") {
    const lastEvent = $persistentStore.read(STORE_KEY_LAST_EVENT);
    let lastData = {};
    if (lastEvent) {
      try {
        lastData = JSON.parse(lastEvent);
      } catch (e) {}
    }
    
    // 比对 IP 是否变化
    if (
      inIP === lastData.inIP &&
      outIP === lastData.outIP &&
      outIP6 === lastData.outIP6
    ) {
      console.log("网络信息未变化，跳过");
      return done({});
    }
    
    // 保存新的 IP 记录
    console.log("网络信息已变化");
    $persistentStore.write(
      JSON.stringify({ inIP, outIP, outIP6 }),
      STORE_KEY_LAST_EVENT
    );
  }

  // ========== 4. 获取代理策略 ==========
  const policy = await getPolicy();

  // ========== 5. 获取 IP 风险评分 ==========
  const riskInfo = await getRiskScore(outIP);
  const riskData = riskText(riskInfo.score);
  const riskLabel = riskData[0];
  const color = riskData[1];
  
  // ========== 6. 获取 IP 类型 ==========
  const ippure = await httpJSON("https://my.ippure.com/v1/info");
  const ipType = ippure?.isResidential ? "住宅 IP" : "机房 IP";
  const ipSrc = ippure?.isBroadcast ? "广播 IP" : "原生 IP";

  // ========== 7. 获取地理位置和运营商信息 ==========
  const [inGeo, outGeo, inISP, outISP] = await Promise.all([
    httpJSON("http://ip-api.com/json/" + inIP + "?fields=country,countryCode,regionName,city"),
    httpJSON("http://ip-api.com/json/" + outIP + "?fields=country,countryCode,regionName,city"),
    httpJSON("https://api.ip.sb/geoip/" + inIP),
    httpJSON("https://api.ip.sb/geoip/" + outIP)
  ]);
  
  // ========== 8. 构建面板显示内容 ==========
  const contentParts = [
    "IP 风控值：" + riskInfo.score + "% " + riskLabel + " (" + riskInfo.source + ")",
    "",
    "IP 类型：" + ipType + " | " + ipSrc,
    "",
    "入口 IP：" + inIP,
    "地区：" + flag(inGeo?.countryCode) + " " + [inGeo?.city, inGeo?.regionName, inGeo?.countryCode].filter(Boolean).join(", "),
    "运营商：" + (inISP?.organization || "Unknown"),
    ""
  ];

  // 处理 IPv6 显示
  if (outIP6) {
    const same = outGeo?.countryCode === exit6?.country_code && outISP?.organization === exit6?.organization;
    if (same) {
      // IPv4 和 IPv6 同地区同运营商
      contentParts.push("出口 IP⁴：" + outIP);
      contentParts.push("出口 IP⁶：" + outIP6);
      contentParts.push("地区：" + flag(outGeo?.countryCode) + " " + [outGeo?.city, outGeo?.regionName, outGeo?.countryCode].filter(Boolean).join(", "));
      contentParts.push("运营商：" + (outISP?.organization || "Unknown"));
    } else {
      // IPv4 和 IPv6 不同地区或运营商
      contentParts.push("出口 IP⁴：" + outIP);
      contentParts.push("地区⁴：" + flag(outGeo?.countryCode) + " " + [outGeo?.city, outGeo?.regionName, outGeo?.countryCode].filter(Boolean).join(", "));
      contentParts.push("运营商⁴：" + (outISP?.organization || "Unknown"));
      contentParts.push("");
      contentParts.push("出口 IP⁶：" + outIP6);
      contentParts.push("地区⁶：" + flag(exit6?.country_code) + " " + [exit6?.city, exit6?.region, exit6?.country_code].filter(Boolean).join(", "));
      contentParts.push("运营商⁶：" + (exit6?.organization || "Unknown"));
    }
  } else {
    // 仅有 IPv4
    contentParts.push("出口 IP：" + outIP);
    contentParts.push("地区：" + flag(outGeo?.countryCode) + " " + [outGeo?.city, outGeo?.regionName, outGeo?.countryCode].filter(Boolean).join(", "));
    contentParts.push("运营商：" + (outISP?.organization || "Unknown"));
  }

  const content = contentParts.join("\n");

  // ========== 9. 根据触发类型决定输出方式 ==========
  if (arg.TYPE === "EVENT") {
    // 网络变化时发送通知
    const notifyTitle = "🔄 网络已切换 | " + policy;
    const notifySubtitle = "Ⓓ " + inIP + " 🅟 " + outIP;
    const notifyContentParts = [
      "Ⓓ " + flag(inGeo?.countryCode) + " " + [inGeo?.city, inGeo?.country].filter(Boolean).join(", ") + " · " + (inISP?.organization || "Unknown"),
      "🅟 " + flag(outGeo?.countryCode) + " " + [outGeo?.city, outGeo?.country].filter(Boolean).join(", ") + " · " + (outISP?.organization || "Unknown"),
      "🅟 风控：" + riskInfo.score + "% " + riskLabel + " | 类型：" + ipType + " · " + ipSrc
    ];
    
    notify(notifyTitle, notifySubtitle, notifyContentParts.join("\n"));
    
    console.log("=== 已发送通知 ===");
    done({});
  } else {
    // 面板显示
    console.log("=== 面板显示 ===");
    done({
      title: "代理策略：" + policy,
      content: content,
      icon: "leaf.fill",
      "icon-color": color
    });
  }
})();
