// vps-traffic.js - VPS 流量监控（多 VPS 顺序输出 + 上下行 + 用量）

function getArgument() {
  try {
    return typeof $argument !== "undefined" ? ($argument || "") : "";
  } catch (e) {
    return "";
  }
}

function parseArgs(str) {
  const obj = {};
  if (!str) return obj;
  str.split("&").forEach(kv => {
    const [k, v] = kv.split("=");
    if (k) obj[k] = decodeURIComponent(v || "");
  });
  return obj;
}

const args  = parseArgs(getArgument());
const title = args.title && args.title !== "null" ? args.title : "📊 VPS 流量统计";
const rawList = (args.ip || "").split(";").map(s => s.trim()).filter(Boolean);

// 未填写 ip
if (!rawList.length) {
  $done({
    title,
    content: "未填写 ip 参数",
    icon: "xmark.shield.fill",
    "icon-color": "#CD5C5C"
  });
} else {

  // ===== quota 解析 =====
  let defaultQuota = 1000;       // 全局默认 1000GB
  const quotaMap = {};           // 按名称单独用量

  if (args.quota) {
    args.quota.split(";").forEach(item => {
      item = item.trim();
      if (!item) return;
      if (/^\d+$/.test(item)) {
        // 纯数字 → 覆盖全局默认
        defaultQuota = Number(item);
      } else if (item.includes(":")) {
        const [k, v] = item.split(":");
        const n = Number(v);
        if (k && !isNaN(n)) quotaMap[k.trim()] = n;
      }
    });
  }

  function formatGB(bytes) {
    return (bytes / 1024 / 1024 / 1024).toFixed(2) + " GB";
  }

  let finished = 0;
  const results = new Array(rawList.length); // 按索引占位，保证显示顺序

  rawList.forEach((item, index) => {
    let name  = "";
    let ip    = "";
    let port  = "8686";
    let iface = "eth0";

    // 名称#地址
    if (item.includes("#")) {
      const arr = item.split("#");
      name = arr[0].trim();
      item = arr[1].trim();
    } else {
      name = item;
      ip   = item;
    }

    // 地址@网卡
    if (item.includes("@")) {
      const arr = item.split("@");
      item  = arr[0].trim();
      iface = arr[1].trim() || "eth0";
    }

    // 地址:端口
    if (item.includes(":")) {
      const arr = item.split(":");
      ip   = arr[0].trim();
      port = arr[1].trim() || "8686";
    } else if (!ip) {
      ip = item.trim();
    }

    const quota = quotaMap[name] || defaultQuota;
    const url   = `http://${ip}:${port}`;

    $httpClient.get(url, (err, resp, data) => {
      if (err || !data) {
        results[index] = `${name}\n连接失败`;
        return finalize();
      }

      try {
        const json = JSON.parse(data);
        const ifaceData = (json.interfaces || []).find(i => i.name === iface);

        if (!ifaceData || !ifaceData.traffic) {
          results[index] = `${name}\n无接口数据 (${iface})`;
          return finalize();
        }

        const day   = ifaceData.traffic.day?.[0]   || {};
        const month = ifaceData.traffic.month?.[0] || {};

        const dayRx    = day.rx   || 0;
        const dayTx    = day.tx   || 0;
        const monthRx  = month.rx || 0;
        const monthTx  = month.tx || 0;
        const monthTot = monthRx + monthTx;

        const usedGB  = monthTot / 1024 / 1024 / 1024;
        const percent = ((usedGB / quota) * 100).toFixed(1);

        results[index] =
          `${name}\n` +
          `今日 ↓ ${formatGB(dayRx)}  ↑ ${formatGB(dayTx)}\n` +
          `本月 ↓ ${formatGB(monthRx)}  ↑ ${formatGB(monthTx)}\n` +
          `用量 ${usedGB.toFixed(2)} / ${quota}GB (${percent}%)`;

      } catch (e) {
        results[index] = `${name}\n数据解析失败`;
      }

      finalize();
    });
  });

  function finalize() {
    finished++;
    if (finished !== rawList.length) return;

    $done({
      title,
      content: results.join("\n\n"),
      icon: "server.rack",
      "icon-color": "#32CD32"
    });
  }
}
