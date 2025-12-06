let finished = false;
function safeDone(obj) {
  if (finished) return;
  finished = true;
  $done(obj);
}

setTimeout(() => {
  safeDone({
    title: "检测超时",
    content: "API 请求超时",
    icon: "xmark.shield.fill",
    "icon-color": "#CD5C5C"
  });
}, 10000);

function httpJSON(url, timeout = 5000, policy) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        resolve(null);
      }
    }, timeout);

    const opts = policy
      ? { url, policy }
      : { url };

    $httpClient.get(opts, (err, resp, data) => {
      if (done) return;
      done = true;
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

// ✅ 新增：获取原始 HTML，用于抓取 Scamalytics 网页
function httpRaw(url, timeout = 5000, policy) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        resolve(null);
      }
    }, timeout);

    const opts = policy
      ? { url, policy }
      : { url };

    $httpClient.get(opts, (err, resp, data) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err || !data) return resolve(null);
      resolve(data);
    });
  });
}

function getProxyInfo() {
  return new Promise((resolve) => {
    if (typeof $httpAPI === "undefined") {
      return resolve({ policyName: "DIRECT" });
    }

    $httpAPI("GET", "/v1/requests/recent", null, (res) => {
      if (!res || !res.requests) {
        return resolve({ policyName: "DIRECT" });
      }

      // ✅ 只匹配：出口 IP 的 ip-api 请求（必须是 (Proxy)）
      const hit = res.requests.find(r =>
        /ip-api\.com\/json\/\?fields=query/i.test(r.URL) &&
        typeof r.remoteAddress === "string" &&
        r.remoteAddress.includes("(Proxy)")
      );

      resolve({
        policyName: hit?.policyName || "DIRECT"
      });
    });
  });
}

function flag(cc) {
  if (!cc || cc.length !== 2) return "";
  const base = 0x1f1e6;
  return String.fromCodePoint(base + cc.charCodeAt(0) - 65)
       + String.fromCodePoint(base + cc.charCodeAt(1) - 65);
}

function riskText(score) {
  if (score <= 15) return { text: "极度纯净 IP", color: "#006400" };
  if (score <= 25) return { text: "纯净 IP", color: "#3CB371" };
  if (score <= 40) return { text: "一般 IP", color: "#9ACD32" };
  if (score <= 50) return { text: "微风险 IP", color: "#FFD700" };
  if (score <= 70) return { text: "一般风险 IP", color: "#FF8C00" };
  return { text: "极度风险 IP", color: "#CD5C5C" };
}

// ✅ 只用于从 Scamalytics 网页里抠出 Fraud Score
function parseScamalyticsScore(html) {
  if (!html) return null;
  const m = html.match(/Fraud Score[^0-9]*([0-9]{1,3})/i);
  if (!m) return null;
  return Number(m[1]);
}

(async () => {
  const [enterIPData, exitIPData, ippureData, proxy] = await Promise.all([
    httpJSON("http://ip-api.com/json/?fields=query", 6000, "DIRECT"),
    httpJSON("http://ip-api.com/json/?fields=query", 6000),
    httpJSON("https://my.ippure.com/v1/info", 6000),
    getProxyInfo()
  ]);

  const enterIP = enterIPData?.query || null;
  const exitIP  = exitIPData?.query  || null;

  if (!enterIP || !exitIP || !ippureData) {
    return safeDone({
      title: "出口 IP 获取失败",
      content: "无法获取入口或出口 IPv4",
      icon: "xmark.shield.fill",
      "icon-color": "#CD5C5C"
    });
  }

  const [enterGeo, exitGeo] = await Promise.all([
    httpJSON(`http://ip-api.com/json/${enterIP}?fields=countryCode,country,city,isp`),
    httpJSON(`http://ip-api.com/json/${exitIP}?fields=countryCode,country,city,isp`)
  ]);

  // ✅ 1. 先从 Scamalytics 抓风险值（只改这一块）
  const scamHTML = await httpRaw(`https://scamalytics.com/ip/${exitIP}`, 6000);
  let fraudScore = parseScamalyticsScore(scamHTML);

  // ✅ 2. 如果 Scamalytics 失败，就回退到 IPPure 的 fraudScore（保持兼容）
  if (fraudScore == null || Number.isNaN(fraudScore)) {
    fraudScore = Number(ippureData.fraudScore || 0);
  }

  const riskInfo = riskText(fraudScore);

  // ✅ 仍然用 IPPure 判断 IP 类型（保持原逻辑不变）
  const ipProperty = ippureData.isResidential ? "住宅 IP" : "机房 IP";
  const ipSource   = ippureData.isBroadcast  ? "广播 IP" : "原生 IP";

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
    title: title,
    content: content,
    icon: "shield.lefthalf.filled",
    "icon-color": riskInfo.color
  });

})();