// komari-traffic.js - Komari 节点流量监控（单面板聚合：累计流量 + 用量/配额 + 到期）
//
// 数据来源（Komari 公开 API，两次请求出全部节点）:
//   GET  /api/nodes  → 名称 / 地区 / 配额 / 用量口径 / 到期 / 价格 / 权重
//   POST /api/rpc2 common:getNodesLatestStatus → 累计流量 / CPU / 内存 / 磁盘 / 在线时长 / ping 统计
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
// - 显示项开关（各自独立参数，true/false）：
//   · traffic 累计↓↑（默认 true）/ usage 用量对比配额（默认 true）/ expire 到期（默认 true）
//   · sys CPU·内存·磁盘 / uptime 在线时长 / ping 延迟 / price 价格 / region 名称行加地区前缀（默认 false）
//   行序固定：累计 → 用量 → 系统 → 在线 → 延迟 → 价格 → 到期
// - cycle: 周期用量（默认 false）。开启后用量行改为本计费周期精确用量（跨重启）：
//   周期起点取 expired_at 的每月对应日（无到期日按每月 1 号），从 /api/records/load
//   历史正增量累加得出；每节点多一次请求，失败自动回退累计口径
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

// 显示项开关（各自独立参数）；region 不是独立行，作用于名称行
const showFlag = (v, def) => {
  const s = clean(v).toLowerCase();
  return (s === "true" || s === "1") ? true : (s === "false" || s === "0") ? false : def;
};
const show = {
  traffic: showFlag(args.traffic, true),
  usage: showFlag(args.usage, true),
  expire: showFlag(args.expire, true),
  sys: showFlag(args.sys, false),
  uptime: showFlag(args.uptime, false),
  ping: showFlag(args.ping, false),
  price: showFlag(args.price, false)
};
const infoItems = ["traffic", "usage", "sys", "uptime", "ping", "price", "expire"].filter(k => show[k]);
const showRegion = showFlag(args.region, false);
const wantCycle = showFlag(args.cycle, false);
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

// region 字段：ISO 两字母代码转国旗（JP → 🇯🇵），其余原样显示
const regionFlag = raw => {
  const s = String(raw || "").trim();
  if (/^[A-Za-z]{2}$/.test(s)) {
    const up = s.toUpperCase();
    return String.fromCodePoint(0x1F1E6 + up.charCodeAt(0) - 65, 0x1F1E6 + up.charCodeAt(1) - 65);
  }
  return s;
};

const formatUptime = sec => {
  if (sec >= 86400) return `${Math.floor(sec / 86400)} 天`;
  if (sec >= 3600) return `${Math.floor(sec / 3600)} 小时`;
  return `${Math.max(1, Math.floor(sec / 60))} 分钟`;
};

// billing_cycle（天）→ 周期文案
const cycleLabel = days => {
  if (days >= 360) return "年";
  if (days >= 175) return "半年";
  if (days >= 85) return "季";
  if (days >= 27) return "月";
  return days > 0 ? `${days}天` : "";
};

// 计费周期起点：expired_at 的每月对应日（到期日即周年日，流量按月在该日重置的惯例），
// 无有效到期日按每月 1 号；重置日超过当月天数时按当月最后一天计
const getCycleStart = node => {
  let day = 1;
  const m = String(node.expired_at || "").match(/^\d{4}-\d{2}-(\d{2})/);
  if (m) day = parseInt(m[1], 10);
  const now = new Date();
  const y = now.getFullYear(), mo = now.getMonth();
  const clamp = (yy, mm) => Math.min(day, new Date(yy, mm + 1, 0).getDate());
  return now.getDate() >= clamp(y, mo)
    ? new Date(y, mo, clamp(y, mo))
    : new Date(y, mo - 1, clamp(y, mo - 1));
};

// 本周期精确用量：历史 net_total 序列逐点正增量累加（计数器重启清零时增量为负 →
// 跳过并从新值继续，故跨重启准确），失败返回 null 由调用方回退累计口径
const fetchCycleUsage = (node, rec) => {
  const start = getCycleStart(node).getTime();
  // 多取 1 小时，用周期起点前最后一个采样做增量基线
  const hours = Math.max(1, Math.ceil((Date.now() - start) / 3600000) + 1);
  const url = `${base}/api/records/load?uuid=${encodeURIComponent(node.uuid)}&load_type=network&hours=${hours}`;
  return httpGet(url).then(raw => {
    const j = JSON.parse(raw);
    const body = j && typeof j === "object" && j.data ? j.data : j;
    const recs = body && Array.isArray(body.records) ? body.records : null;
    if (!recs || !recs.length) return null;

    let pts = recs
      .map(r => ({
        t: Date.parse(String(r.time).replace(" ", "T")) || 0,
        up: r.net_total_up || 0,
        down: r.net_total_down || 0
      }))
      .sort((a, b) => a.t - b.t);
    const pre = pts.filter(p => p.t < start);
    pts = pts.filter(p => p.t >= start);
    if (pre.length) pts.unshift(pre[pre.length - 1]);
    if (rec) pts.push({ t: Date.now(), up: rec.net_total_up || 0, down: rec.net_total_down || 0 });
    if (pts.length < 2) return null;

    let up = 0, down = 0;
    for (let i = 1; i < pts.length; i++) {
      const du = pts[i].up - pts[i - 1].up;
      const dd = pts[i].down - pts[i - 1].down;
      up += du >= 0 ? du : pts[i].up;
      down += dd >= 0 ? dd : pts[i].down;
    }
    return { up, down };
  }).catch(() => null);
};

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

    // 与 Komari 面板一致：weight 升序（数值小的靠前），同权重按名称
    const byWeight = (a, b) => (a.weight || 0) - (b.weight || 0) || String(a.name).localeCompare(String(b.name));

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

    // 周期用量预取：仅对显示中的节点发起，单节点失败回退累计口径
    const cycleTargets = wantCycle && show.usage ? nodes.filter(n => !n.missing) : [];
    return Promise.all(cycleTargets.map(n =>
      fetchCycleUsage(n, statusMap ? statusMap[n.uuid] : null).then(v => [n.uuid, v])
    )).then(cycleEntries => {
    const cycleMap = {};
    cycleEntries.forEach(([uuid, v]) => { if (v) cycleMap[uuid] = v; });

    const pct = (used, total) => total > 0 ? Math.round(used / total * 100) + "%" : "-";

    // 各内容行构造器；返回空则跳过该行。
    // 静态信息（expire/price）离线也显示；累计/用量取最后一次上报，离线仍有意义；
    // sys/uptime/ping 是瞬时数据，仅在线显示，避免陈旧值误导
    const lineBuilders = {
      traffic: (node, rec) => rec &&
        `累计 ↓ ${formatGB(rec.net_total_down || 0)} ↑ ${formatGB(rec.net_total_up || 0)}`,
      usage: (node, rec) => {
        const type = String(node.traffic_limit_type || "max").toLowerCase();
        const cyc = cycleMap[node.uuid];
        // 周期口径：本计费周期精确用量（无配额也有意义）；否则累计口径，仅设有配额时显示
        const label = cyc ? "周期" : "用量";
        const src = cyc ? cyc : (rec ? { up: rec.net_total_up || 0, down: rec.net_total_down || 0 } : null);
        if (!src || (!cyc && !(node.traffic_limit > 0))) return "";
        const usedGB = calcUsage(src.up, src.down, type) / 1073741824;
        // 无配额时口径标签没有对比意义，省掉
        if (!(node.traffic_limit > 0)) return `${label} ${usedGB.toFixed(2)} GB`;
        const quotaGB = node.traffic_limit / 1073741824;
        return `${label} ${usageLabel(type)} ${usedGB.toFixed(2)} / ${quotaGB.toFixed(0)}GB (${(usedGB / quotaGB * 100).toFixed(1)}%)`;
      },
      expire: node => {
        const s = formatExpire(node.expired_at);
        return s && `到期 ${s}`;
      },
      sys: (node, rec) => rec && rec.online &&
        `CPU ${Math.round(rec.cpu || 0)}%｜内存 ${pct(rec.ram, rec.ram_total)}｜磁盘 ${pct(rec.disk, rec.disk_total)}`,
      uptime: (node, rec) => rec && rec.online && rec.uptime > 0 &&
        `在线 ${formatUptime(rec.uptime)}`,
      price: node => {
        if (!(node.price > 0)) return "";
        const unit = cycleLabel(node.billing_cycle);
        return `价格 ${node.price} ${node.currency || "$"}${unit ? "/" + unit : ""}`;
      },
      ping: (node, rec) => {
        if (!rec || !rec.online || !rec.ping) return "";
        const parts = Object.values(rec.ping)
          .filter(p => p && p.latest >= 0)
          .map(p => `${p.name} ${p.latest}ms${p.loss > 0 ? ` 丢${Math.round(p.loss)}%` : ""}`);
        if (!parts.length) return "";
        // 每行两项，避免任务多时折行成一大段
        const rows = [];
        for (let i = 0; i < parts.length; i += 2) rows.push(parts.slice(i, i + 2).join("｜"));
        return `延迟 ${rows.join("\n")}`;
      }
    };

    const blocks = nodes.map(node => {
      if (node.missing) return `${node.name}\n无匹配节点`;
      const rec = statusMap ? statusMap[node.uuid] : null;
      const flag = showRegion ? regionFlag(node.region) : "";
      const displayName = flag ? `${flag} ${node.name}` : node.name;

      const lines = [];
      if (!statusMap) lines.push(displayName, "状态获取失败");
      else lines.push(rec && rec.online ? displayName : `${displayName} ｜ 离线`);

      infoItems.forEach(key => {
        const build = lineBuilders[key];
        const line = build && build(node, rec);
        if (line) lines.push(line);
      });
      return lines.join("\n");
    });

    done({ title, content: blocks.join("\n\n"), icon: "server.rack", "icon-color": "#32CD32" });
    }); // cycle 预取 then 结束
  }).catch(err => {
    done({
      title,
      content: `连接失败：${err && err.message ? err.message : err}`,
      icon: "xmark.shield.fill",
      "icon-color": "#CD5C5C"
    });
  });
}
