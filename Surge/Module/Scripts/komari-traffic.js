// komari-traffic.js - Komari 节点流量监控（单面板聚合：实时速率 + 用量/配额 + 到期）
//
// 数据来源（Komari 公开 API，两次请求出全部节点）:
//   GET  /api/nodes  → 节点名称 / traffic_limit / traffic_limit_type / expired_at / weight
//   POST /api/rpc2 common:getNodesLatestStatus → net_in/net_out(实时速率) + net_total_up/down(累计流量) + online
// 配额、到期日、用量口径均由 Komari 后台维护，无需在参数里逐台配置。
//
// 用量口径与 Komari 面板一致：自开机累计流量对比 traffic_limit（重启后计数器清零）。
//
// 参数:
// - url: Komari 面板地址（必填，如 https://mon.example.com；无协议前缀默认 https）
// - token: 后台 API Key（可选；私有站点或需显示隐藏节点时以 Authorization: Bearer 发送）
// - nodes: 节点筛选（可选，不填显示全部并按权重排序）
//   · 名称或正则;名称或正则 → 只显示匹配的节点，顺序跟随条目（条目内按权重）
//   · "!" 开头 → 整体视作单个正则，匹配的不显示
// - title: 面板标题（默认:📊 Komari 流量统计）

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

const clean = v => {
  const s = (v === undefined || v === null) ? "" : String(v).trim();
  return s.toLowerCase() === "null" ? "" : s;
};

const title = clean(args.title) || "📊 Komari 流量统计";
const token = clean(args.token);
// 节点筛选："!" 开头 → 整体为排除正则；否则按 ";" 拆成逐条正则/名称
const rawNodes = clean(args.nodes);
let excludeRe = null, nodeItems = [], nodesError = "";
if (rawNodes.startsWith("!")) {
  try {
    excludeRe = new RegExp(rawNodes.slice(1));
  } catch (e) {
    nodesError = `nodes 排除正则无效：${e.message || e}`;
  }
} else if (rawNodes) {
  nodeItems = rawNodes.split(";").map(s => s.trim()).filter(Boolean);
}

let base = clean(args.url).replace(/\/+$/, "");
if (base && !/^https?:\/\//i.test(base)) base = "https://" + base;

// 输出去重 + 超时兜底（须小于 sgmodule 的 timeout，避免 Surge 先杀脚本导致面板空白）
let finished = false;
const done = o => {
  if (finished) return;
  finished = true;
  $done(o);
};
setTimeout(() => {
  done({ title, content: "请求超时", icon: "server.rack", "icon-color": "#9E9E9E" });
}, 9000);

const headers = token ? { Authorization: `Bearer ${token}` } : {};

const httpGet = url => new Promise((resolve, reject) => {
  $httpClient.get({ url, headers }, (err, resp, data) => {
    if (err || !resp) return reject(err || "no response");
    if (resp.status !== 200) return reject(`HTTP ${resp.status}`);
    resolve(data || "");
  });
});

const httpPost = (url, body) => new Promise((resolve, reject) => {
  $httpClient.post(
    { url, headers: { ...headers, "Content-Type": "application/json" }, body },
    (err, resp, data) => {
      if (err || !resp) return reject(err || "no response");
      if (resp.status !== 200) return reject(`HTTP ${resp.status}`);
      resolve(data || "");
    }
  );
});

const formatGB = bytes => (bytes / 1073741824).toFixed(2) + " GB";

const formatSpeed = bps => {
  if (!bps || bps < 0) bps = 0;
  if (bps >= 1048576) return (bps / 1048576).toFixed(2) + " MB/s";
  if (bps >= 1024) return (bps / 1024).toFixed(1) + " KB/s";
  return bps.toFixed(0) + " B/s";
};

// traffic_limit_type: sum / max / min / up / down（Komari 默认 max）
const calcUsage = (up, down, type) => {
  switch (type) {
    case "sum": return up + down;
    case "min": return Math.min(up, down);
    case "up": return up;
    case "down": return down;
    default: return Math.max(up, down); // max
  }
};

const usageLabel = type =>
  ({ sum: "⇅", up: "↑", down: "↓", min: "min" }[type] || "max");

// expired_at 零值（0001-01-01）或无效日期视为未设置
const formatExpire = raw => {
  if (!raw) return "";
  const s = String(raw);
  const d = new Date(s.replace(" ", "T"));
  if (isNaN(d) || d.getFullYear() < 2001) return "";
  // 日期部分直接取原文，避免跨时区换算偏移一天
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  const dateStr = m ? m[1]
    : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const days = Math.ceil((d - new Date()) / 86400000);
  if (days < 0) return `${dateStr}（已过期 ${-days} 天）`;
  if (days === 0) return `${dateStr}（今日到期）`;
  return `${dateStr}（剩余 ${days} 天）`;
};

if (!base) {
  done({ title, content: "未填写 url 参数", icon: "xmark.shield.fill", "icon-color": "#CD5C5C" });
} else if (nodesError) {
  done({ title, content: nodesError, icon: "xmark.shield.fill", "icon-color": "#CD5C5C" });
} else {
  const rpcBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "common:getNodesLatestStatus", params: {} });

  Promise.all([
    httpGet(`${base}/api/nodes`),
    httpPost(`${base}/api/rpc2`, rpcBody).catch(() => null) // 状态拉取失败时仍显示节点基础信息
  ]).then(([nodesRaw, statusRaw]) => {
    const nodesJson = JSON.parse(nodesRaw);
    // 兼容 {status,data:[…]} 包装与裸数组两种返回
    let nodes = Array.isArray(nodesJson) ? nodesJson
      : (Array.isArray(nodesJson.data) ? nodesJson.data : null);
    if (!nodes) throw new Error(nodesJson.message || "节点列表格式异常");

    let statusMap = null;
    if (statusRaw) {
      try {
        const rpc = JSON.parse(statusRaw);
        if (rpc.result && typeof rpc.result === "object") statusMap = rpc.result;
      } catch (e) {}
    }

    const byWeight = (a, b) => (b.weight || 0) - (a.weight || 0) || String(a.name).localeCompare(String(b.name));

    if (nodeItems.length) {
      // 逐条目匹配：正则命中或名称完全相等（兼容含元字符的精确名称），
      // 顺序跟随条目，条目内按权重
      const seen = new Set();
      const picked = [];
      nodeItems.forEach(pat => {
        let re = null;
        try { re = new RegExp(pat); } catch (e) {}
        const matched = nodes
          .filter(n => ((re && re.test(String(n.name))) || String(n.name) === pat) && !seen.has(n.uuid))
          .sort(byWeight);
        if (!matched.length) {
          picked.push({ name: pat, missing: true });
          return;
        }
        matched.forEach(n => { seen.add(n.uuid); picked.push(n); });
      });
      nodes = picked;
    } else {
      if (excludeRe) nodes = nodes.filter(n => !excludeRe.test(String(n.name)));
      // 与 Komari 面板一致：权重大的靠前，同权重按名称
      nodes.sort(byWeight);
    }

    if (!nodes.length) {
      done({
        title,
        content: excludeRe ? "无匹配 nodes 的节点" : "面板暂无节点",
        icon: "server.rack",
        "icon-color": "#9E9E9E"
      });
      return;
    }

    const blocks = nodes.map(node => {
      if (node.missing) return `${node.name}\n无匹配节点`;
      const rec = statusMap ? statusMap[node.uuid] : null;

      if (!statusMap) {
        var lines = [node.name, "状态获取失败"];
      } else if (!rec) {
        lines = [`${node.name} ｜ 离线`];
      } else {
        lines = [rec.online ? node.name : `${node.name} ｜ 离线`];
        if (rec.online) lines.push(`实时 ↓ ${formatSpeed(rec.net_in)}  ↑ ${formatSpeed(rec.net_out)}`);
        const type = String(node.traffic_limit_type || "max").toLowerCase();
        const used = calcUsage(rec.net_total_up || 0, rec.net_total_down || 0, type);
        const usedGB = used / 1073741824;
        if (node.traffic_limit > 0) {
          const quotaGB = node.traffic_limit / 1073741824;
          lines.push(`用量 ${usageLabel(type)} ${usedGB.toFixed(2)} / ${quotaGB.toFixed(0)}GB (${(usedGB / quotaGB * 100).toFixed(1)}%)`);
        } else {
          lines.push(`用量 ${usageLabel(type)} ${formatGB(used)}`);
        }
      }

      const expireStr = formatExpire(node.expired_at);
      if (expireStr) lines.push(`到期 ${expireStr}`);
      return lines.join("\n");
    });

    done({ title, content: blocks.join("\n\n"), icon: "server.rack", "icon-color": "#32CD32" });
  }).catch(err => {
    done({
      title,
      content: `连接失败：${err && err.message ? err.message : err}`,
      icon: "xmark.shield.fill",
      "icon-color": "#CD5C5C"
    });
  });
}
