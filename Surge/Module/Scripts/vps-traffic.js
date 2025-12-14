// vps-traffic.js - VPS 流量监控（多 VPS 顺序输出 + 上下行 + 用量）

const args = (() => {
  const obj = {};
  try {
    ($argument || "").split("&").forEach(kv => {
      const [k, v] = kv.split("=");
      if (k) obj[k] = decodeURIComponent(v || "");
    });
  } catch (e) {}
  return obj;
})();

const title = args.title || "📊 VPS 流量统计";
const rawList = (args.ip || "").split(";").map(s => s.trim()).filter(Boolean);
const resetDay = parseInt(args.resetday) || 1;

// 流量计算模式: both(双向), rx(仅下行), tx(仅上行)
// 支持全局默认值和按 VPS 单独配置，格式同 quota: mode=rx;VPS1:both;VPS2:tx
let defaultMode = "both";
const modeMap = {};
(args.mode || "").split(";").forEach(item => {
  item = item.trim();
  if (!item) return;
  if (/^(both|rx|tx)$/i.test(item)) {
    defaultMode = item.toLowerCase();
  } else if (item.includes(":")) {
    const [k, v] = item.split(":");
    if (k && /^(both|rx|tx)$/i.test(v)) modeMap[k.trim()] = v.trim().toLowerCase();
  }
});

if (!rawList.length) {
  $done({ title, content: "未填写 ip 参数", icon: "xmark.shield.fill", "icon-color": "#CD5C5C" });
} else {
  // 解析 quota 配置
  let defaultQuota = 1000;
  const quotaMap = {};
  (args.quota || "").split(";").forEach(item => {
    item = item.trim();
    if (!item) return;
    if (/^\d+$/.test(item)) {
      defaultQuota = Number(item);
    } else if (item.includes(":")) {
      const [k, v] = item.split(":");
      if (k && !isNaN(v)) quotaMap[k.trim()] = Number(v);
    }
  });

  const formatGB = bytes => (bytes / 1073741824).toFixed(2) + " GB";

  // 根据模式计算用量
  const calcUsage = (rx, tx, mode) => {
    if (mode === "rx") return rx;
    if (mode === "tx") return tx;
    return rx + tx; // both
  };

  // 获取模式标签
  const getModeLabel = mode => {
    if (mode === "rx") return "↓";
    if (mode === "tx") return "↑";
    return "⇅";
  };

  // 获取计费周期起始日期
  const getBillingStart = () => {
    const now = new Date();
    const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
    return new Date(y, d >= resetDay ? m : m - 1, resetDay);
  };

  // 计算计费周期内流量
  const calcBillingTraffic = (traffic) => {
    if (!traffic?.day) return { rx: 0, tx: 0 };
    const start = getBillingStart();
    let rx = 0, tx = 0;
    traffic.day.forEach(d => {
      if (!d.date) return;
      if (new Date(d.date.year, d.date.month - 1, d.date.day) >= start) {
        rx += d.rx || 0;
        tx += d.tx || 0;
      }
    });
    return { rx, tx };
  };

  let finished = 0;
  const results = new Array(rawList.length);

  rawList.forEach((raw, index) => {
    let name = "", ip = "", port = "8686", iface = "eth0";

    // 解析: 名称#地址@网卡:端口
    let item = raw;
    if (item.includes("#")) [name, item] = item.split("#").map(s => s.trim());
    if (item.includes("@")) [item, iface] = item.split("@").map(s => s.trim());
    if (item.includes(":")) [ip, port] = item.split(":").map(s => s.trim());
    else ip = item.trim();
    if (!name) name = ip;
    iface = iface || "eth0";
    port = port || "8686";

    $httpClient.get(`http://${ip}:${port}`, (err, resp, data) => {
      if (err || !data) {
        results[index] = `${name}\n连接失败`;
      } else {
        try {
          const json = JSON.parse(data);
          const ifaceData = json.interfaces?.find(i => i.name === iface);

          if (!ifaceData?.traffic) {
            results[index] = `${name}\n无接口数据 (${iface})`;
          } else {
            const day = ifaceData.traffic.day?.[0] || {};
            const billing = calcBillingTraffic(ifaceData.traffic);
            const mode = modeMap[name] || defaultMode;
            const usage = calcUsage(billing.rx, billing.tx, mode);
            const quota = quotaMap[name] || defaultQuota;
            const usedGB = usage / 1073741824;
            const modeLabel = getModeLabel(mode);

            results[index] =
              `${name}\n` +
              `今日 ↓ ${formatGB(day.rx || 0)}  ↑ ${formatGB(day.tx || 0)}\n` +
              `周期 ↓ ${formatGB(billing.rx)}  ↑ ${formatGB(billing.tx)}\n` +
              `用量 ${modeLabel} ${usedGB.toFixed(2)} / ${quota}GB (${((usedGB / quota) * 100).toFixed(1)}%)`;
          }
        } catch (e) {
          results[index] = `${name}\n数据解析失败`;
        }
      }

      if (++finished === rawList.length) {
        $done({ title, content: results.join("\n\n"), icon: "server.rack", "icon-color": "#32CD32" });
      }
    });
  });
}
