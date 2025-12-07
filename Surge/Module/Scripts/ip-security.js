let finished = false;

function safeDone(obj) {
  if (finished) return;
  finished = true;
  $done(obj);
}

// 超时保护
setTimeout(() => {
  safeDone({
    title: "检测超时",
    content: "API 请求超时",
    icon: "xmark.shield.fill",
    "icon-color": "#CD5C5C"
  });
}, 10000);

// 通用 JSON 请求
function httpJSON(url, timeout = 5000, policy) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeout);
    const opts = policy ? { url, policy } : { url };

    $httpClient.get(opts, (err, resp, data) => {
      clearTimeout(timer);
      if (err || !data) return resolve(null);
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve(null);
      }
    });
  });
}

// 原始 HTML 请求（Scamalytics）
function httpRaw(url, timeout = 5000, policy) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeout);
    const opts = policy ? { url, policy } : { url };

    $httpClient.get(opts, (err, resp, data) => {
      clearTimeout(timer);
      if (err || !data) return resolve(null);
      resolve(data);
    });
  });
}

// ✅ 从 recent 反查 ipify 实际走的节点
function getProxyInfo() {
  return new Promise((resolve) => {
    if (typeof $httpAPI === "undefined") {
      return resolve({ policyName: "DIRECT" });
    }

    $httpAPI("GET", "/v1/requests/recent", null, (res) => {
      if (!res || !Array.isArray(res.requests)) {
        return resolve({ policyName: "DIRECT" });
      }

      const hit = res.requests.find(r =>
        typeof r.URL === "string" &&
        r.URL.includes("api.ipify.org") &&
        typeof r.policyName === "string"
      );

      resolve({
        policyName: hit?.policyName || "DIRECT"
      });
    });
  });
}

// 国旗
function flag(cc) {
  if (!cc || cc.length !== 2) return "";
  const base = 0x1f1e6;
  return (
    String.fromCodePoint(base + cc.charCodeAt(0) - 65) +
    String.fromCodePoint(base + cc.charCodeAt(1) - 65)
  );
}

// 风险描述
function riskText(score) {
  if (score <= 15) return { text: "极度纯净 IP", color: "#006400" };
  if (score <= 25) return { text: "纯净 IP", color: "#3CB371" };
  if (score <= 40) return { text: "一般 IP", color: "#9ACD32" };
  if (score <= 50) return { text: "微风险 IP", color: "#FFD700" };
  if (score <= 70) return { text: "一般风险 IP", color: "#FF8C00" };
  return { text: "极度风险 IP", color: "#CD5C5C" };
}

// 从 Scamalytics 页面抠 Fraud Score
function parseScamalyticsScore(html) {
  if (!html) return null;
  const m = html.match(/Fraud Score[^0-9]*([0-9]{1,3})/i);
  if (!m) return null;
  return Number(m[1]);
}

(async () => {
  // 1️⃣ 入口 IP（DIRECT）
  const enterIPData = await httpJSON(
    "https://api.bilibili.com/x/web-interface/zone",
    6000,
    "DIRECT"
  );

  // 2️⃣ 出口 IP（ipify，不绑策略）
  const exitIPData = await httpJSON(
    "https://api.ipify.org?format=json",
    6000
  );

  // 3️⃣ 反查 ipify 实际走的节点
  const proxy = await getProxyInfo();

  // 4️⃣ IPPure（可失败）
  const ippureData = await httpJSON(
    "https://my.ippure.com/v1/info",
    6000
  );

  // 解析入口 IP
  let enterIP = enterIPData?.data?.addr || null;

  // bilibili 失败 → DIRECT fallback
  if (!enterIP) {
    const fallback = await httpJSON(
      "https://api64.ipify.org?format=json",
      6000,
      "DIRECT"
    );
    enterIP = fallback?.ip || null;
  }

  // 解析出口 IP
  const exitIP = exitIPData?.ip || null;

  // 仅在入口或出口失败时报错
  if (!enterIP || !exitIP) {
    return safeDone({
      title: "出口 IP 获取失败",
      content: "无法获取入口或出口 IPv4",
      icon: "xmark.shield.fill",
      "icon-color": "#CD5C5C"
    });
  }

  // 地理信息
  const [enterGeo, exitGeo] = await Promise.all([
    httpJSON(`http://ip-api.com/json/${enterIP}?fields=countryCode,country,city,isp`),
    httpJSON(`http://ip-api.com/json/${exitIP}?fields=countryCode,country,city,isp`)
  ]);

  // Scamalytics 风控
  const scamHTML = await httpRaw(`https://scamalytics.com/ip/${exitIP}`, 6000);
  let fraudScore = parseScamalyticsScore(scamHTML);

  // 回退到 IPPure
  if (fraudScore == null || Number.isNaN(fraudScore)) {
    fraudScore = Number(ippureData?.fraudScore || 0);
  }

  const riskInfo = riskText(fraudScore);

  // IP 类型
  const ipProperty = ippureData?.isResidential ? "住宅 IP" : "机房 IP";
  const ipSource   = ippureData?.isBroadcast  ? "广播 IP" : "原生 IP";

  const enterLocation = `${flag(enterGeo.countryCode)} ${enterGeo.city} ${enterGeo.countryCode}`;
  const exitLocation  = `${flag(exitGeo.countryCode)} ${exitGeo.city} ${exitGeo.countryCode}`;

  const content = [
    `IP 风控值：${fraudScore}%  ${riskInfo.text}`,
    ``,
    `IP 类型：${ipProperty} | ${ipSource}`,
    ``,
    `入口 IP：${enterIP}`,
    `地区：${enterLocation}`,
    `运营商：${enterGeo.isp}`,
    ``,
    `出口 IP：${exitIP}`,
    `地区：${exitLocation}`,
    `运营商：${exitGeo.isp}`
  ].join("\n");

  const title = proxy.policyName
    ? `代理策略：${proxy.policyName}`
    : "代理策略：DIRECT";

  safeDone({
    title,
    content,
    icon: "shield.lefthalf.filled",
    "icon-color": riskInfo.color
  });

})();