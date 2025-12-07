/*
① 入口 IP（bilibili，DIRECT）
② 出口 IP（ip-api，代理）
③ Surge /v1/requests/recent 回读真实代理策略
④ 风控等级（Scamalytics → IPPure 备用）
⑤ IP 类型（IPPure）
⑥ 地区 & 运营商（ip-api）
*/

let finished = false;
function done(o) {
  if (finished) return;
  finished = true;
  $done(o);
}

setTimeout(() => {
  done({
    title: "检测超时",
    content: "API 请求超时",
    icon: "xmark.shield.fill",
    "icon-color": "#CD5C5C"
  });
}, 9000);

function httpJSON(url, policy) {
  return new Promise(r => {
    $httpClient.get(policy ? { url, policy } : { url }, (_, __, d) => {
      try { r(JSON.parse(d)); } catch { r(null); }
    });
  });
}

function httpRaw(url) {
  return new Promise(r => {
    $httpClient.get({ url }, (_, __, d) => r(d || null));
  });
}

function getPolicy() {
  return new Promise(r => {
    $httpAPI("GET", "/v1/requests/recent", null, res => {
      const hit = res?.requests
        ?.slice(0, 10)
        .find(i => /ip-api\.com\/json/i.test(i.URL));
      r(hit?.policyName || "DIRECT");
    });
  });
}

function flag(cc) {
  const b = 0x1f1e6;
  return cc && cc.length === 2
    ? String.fromCodePoint(b + cc.charCodeAt(0) - 65, b + cc.charCodeAt(1) - 65)
    : "";
}

function riskText(s) {
  if (s <= 15) return ["极度纯净 IP", "#006400"];
  if (s <= 25) return ["纯净 IP", "#3CB371"];
  if (s <= 40) return ["一般 IP", "#9ACD32"];
  if (s <= 50) return ["微风险 IP", "#FFD700"];
  if (s <= 70) return ["一般风险 IP", "#FF8C00"];
  return ["极度风险 IP", "#CD5C5C"];
}

function parseScore(html) {
  const m = html && html.match(/Fraud Score[^0-9]*([0-9]{1,3})/i);
  return m ? Number(m[1]) : null;
}

(async () => {
  // ① 入口 IP
  const enter = await httpJSON(
    "https://api.bilibili.com/x/web-interface/zone",
    "DIRECT"
  );
  const inIP = enter?.data?.addr;

  // ② 出口 IP
  const exit = await httpJSON(
    "http://ip-api.com/json/?fields=query"
  );
  const outIP = exit?.query;

  if (!inIP || !outIP) {
    return done({
      title: "出口 IP 获取失败",
      content: "无法获取入口或出口 IPv4",
      icon: "xmark.shield.fill",
      "icon-color": "#CD5C5C"
    });
  }

  // ③ 真实代理策略
  const policy = await getPolicy();

  // ④ 风控等级
  const ippure = await httpJSON("https://my.ippure.com/v1/info");
  let score = parseScore(await httpRaw(`https://scamalytics.com/ip/${outIP}`));
  if (score == null) score = Number(ippure?.fraudScore || 0);
  const [riskLabel, color] = riskText(score);

  // ⑤ IP 类型
  const ipType = ippure?.isResidential ? "住宅 IP" : "机房 IP";
  const ipSrc  = ippure?.isBroadcast  ? "广播 IP" : "原生 IP";

  // ⑥ 地区 & 运营商
  const [inGeo, outGeo] = await Promise.all([
    httpJSON(`http://ip-api.com/json/${inIP}?fields=countryCode,country,city,isp`),
    httpJSON(`http://ip-api.com/json/${outIP}?fields=countryCode,country,city,isp`)
  ]);

  const content = [
    `IP 风控值：${score}%  ${riskLabel}`,
    ``,
    `IP 类型：${ipType} | ${ipSrc}`,
    ``,
    `入口 IP：${inIP}`,
    `地区：${flag(inGeo.countryCode)} ${inGeo.city} ${inGeo.countryCode}`,
    `运营商：${inGeo.isp}`,
    ``,
    `出口 IP：${outIP}`,
    `地区：${flag(outGeo.countryCode)} ${outGeo.city} ${outGeo.countryCode}`,
    `运营商：${outGeo.isp}`
  ].join("\n");

  done({
    title: `代理策略：${policy}`,
    content,
    icon: "shield.lefthalf.filled",
    "icon-color": color
  });

})();