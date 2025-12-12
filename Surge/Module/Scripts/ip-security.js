/**
 * Surge IP Security Check Script
 * 
 * 功能概述：
 * - 检测并显示入口/出口 IP 信息
 * - 评估 IP 风险等级和类型
 * - 显示地理位置和运营商信息
 * 
 * 数据来源：
 * ① 入口 IP: bilibili API (DIRECT)
 * ② 出口 IP: ipapi.co API
 * ③ 代理策略: Surge /v1/requests/recent
 * ④ 风险评分: Scamalytics (主) / IPPure (备)
 * ⑤ IP 类型: IPPure API
 * ⑥ 地理信息: ipapi.co API
 * 
 * @author JOEY&Claude
 * @version 2.0.1
 * @update 2025-12-12
 */

// 防止重复调用 $done
let finished = false;
function done(o) {
  if (finished) return;
  finished = true;
  $done(o);
}

// 设置 9 秒超时保护
setTimeout(() => {
  done({
    title: "检测超时",
    content: "API 请求超时",
    icon: "xmark.shield.fill",
    "icon-color": "#CD5C5C"
  });
}, 9000);

/**
 * 通用 HTTP JSON 请求
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
 * HTTP 原始内容请求
 * @param {string} url - 请求地址
 * @returns {Promise<string|null>} 原始响应文本或 null
 */
function httpRaw(url) {
  return new Promise(r => {
    $httpClient.get({ url }, (_, __, d) => r(d || null));
  });
}

/**
 * 从 Surge 最近请求中获取实际使用的代理策略
 * @returns {Promise<string>} 代理策略名称
 */
function getPolicy() {
  return new Promise(r => {
    $httpAPI("GET", "/v1/requests/recent", null, res => {
      const hit = res?.requests
        ?.slice(0, 10)
        .find(i => /ipapi\.co\/json/i.test(i.URL));
      r(hit?.policyName || "DIRECT");
    });
  });
}

/**
 * 将国家代码转换为国旗 emoji
 * @param {string} cc - ISO 3166-1 alpha-2 国家代码
 * @returns {string} 国旗 emoji 或空字符串
 */
function flag(cc) {
  if (!cc || cc.length !== 2) return "";
  
  // 台湾地区特殊处理：TW 回落到 CN
  if (cc.toUpperCase() === "TW") {
    // 先尝试显示台湾旗帜
    const twFlag = String.fromCodePoint(0x1f1f9, 0x1f1fc);
    // 测试是否能正常显示（通过检查长度）
    // 如果无法显示会变成单个字符或乱码
    if (twFlag.length === 2) {
      return twFlag;
    }
    // 回落到中国国旗
    cc = "CN";
  }
  
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
  if (s <= 15) return ["极度纯净 IP", "#006400"];
  if (s <= 25) return ["纯净 IP", "#3CB371"];
  if (s <= 40) return ["一般 IP", "#9ACD32"];
  if (s <= 50) return ["微风险 IP", "#FFD700"];
  if (s <= 70) return ["一般风险 IP", "#FF8C00"];
  return ["极度风险 IP", "#CD5C5C"];
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

/**
 * 格式化地理位置信息
 * @param {Object} geo - ipapi.co 返回的地理信息对象
 * @returns {string} 格式化的地址字符串
 */
function formatLocation(geo) {
  const parts = [];
  if (geo?.city) parts.push(geo.city);
  if (geo?.region && geo.region !== geo.city) parts.push(geo.region);
  if (geo?.country_code) parts.push(geo.country_code);
  return parts.join(", ");
}

// 主执行函数
(async () => {
  // ① 获取入口 IP（直连）
  const enter = await httpJSON(
    "https://api.bilibili.com/x/web-interface/zone",
    "DIRECT"
  );
  const inIP = enter?.data?.addr;

  // ② 获取出口 IP（代理）
  const exit = await httpJSON("https://ipapi.co/json/");
  const outIP = exit?.ip;

  // 验证 IP 获取成功
  if (!inIP || !outIP) {
    return done({
      title: "出口 IP 获取失败",
      content: "无法获取入口或出口 IPv4",
      icon: "xmark.shield.fill",
      "icon-color": "#CD5C5C"
    });
  }

  // ③ 获取真实代理策略
  const policy = await getPolicy();

  // ④ 获取 IP 风险评分（优先 Scamalytics，备用 IPPure）
  const ippure = await httpJSON("https://my.ippure.com/v1/info");
  let score = parseScore(await httpRaw(`https://scamalytics.com/ip/${outIP}`));
  if (score == null) score = Number(ippure?.fraudScore || 0);
  const [riskLabel, color] = riskText(score);

  // ⑤ 获取 IP 类型
  const ipType = ippure?.isResidential ? "住宅 IP" : "机房 IP";
  const ipSrc  = ippure?.isBroadcast  ? "广播 IP" : "原生 IP";

  // ⑥ 获取地理位置和运营商信息
  const [inGeo, outGeo] = await Promise.all([
    httpJSON(`https://ipapi.co/${inIP}/json/`),
    httpJSON(`https://ipapi.co/${outIP}/json/`)
  ]);

  // 构建显示内容
  const content = [
    `IP 风控值：${score}%  ${riskLabel}`,
    ``,
    `IP 类型：${ipType} | ${ipSrc}`,
    ``,
    `入口 IP：${inIP}`,
    `地区：${flag(inGeo?.country_code)} ${formatLocation(inGeo)}`,
    `运营商：${inGeo?.org || "Unknown"}`,
    ``,
    `出口 IP：${outIP}`,
    `地区：${flag(outGeo?.country_code)} ${formatLocation(outGeo)}`,
    `运营商：${outGeo?.org || "Unknown"}`
  ].join("\n");

  // 返回结果
  done({
    title: `代理策略：${policy}`,
    content,
    icon: "shield.lefthalf.filled",
    "icon-color": color
  });
})();
