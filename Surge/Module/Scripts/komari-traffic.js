// komari-traffic.js - Komari 节点流量监控（单面板聚合：累计流量 + 用量/配额 + 到期）
//
// 数据来源（Komari 公开 API，两次请求出全部节点）:
//   POST /api/rpc2 common:getNodes → 名称 / 地区 / IP / 配额 / 用量口径 / 到期 / 价格 / 权重
//     （失败回退 GET /api/nodes，该接口不含 IP；IP 完整值需 token，访客视后台开关为打码或空）
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
// - 显示项开关（各自独立参数）：
//   · overview 顶部概览：在线数/点亮地区/全站流量总和，统计全部节点不受 nodes 筛选影响（默认 true）
//   · traffic 流量↑↓（默认 true）/ expire 到期（默认 true）
//   · usage 用量对比配额，三态（默认 true）：true=累计口径 / false=隐藏 /
//     cycle=本计费周期精确用量（跨重启；周期起点取 expired_at 的每月对应日，
//     无到期日按每月 1 号，从 /api/records/load 历史正增量累加，
//     每节点多一次请求，失败自动回退累计口径）
//   · sys CPU·内存·磁盘 / uptime 在线时长 / ping 延迟 / price 价格 / region 名称行加地区前缀 /
//     ip 节点 IP（默认 false；完整 IP 需 token，无 token 时视后台「向访客发送 IP」开关显示打码或隐藏；
//       显示时默认打码，点击面板刷新在明文/打码间切换，自动刷新不切换——判定依赖 panel_interval）
// - panel_interval: 面板 update-interval（秒），默认 300；改了 [Panel] 的刷新间隔需同步，
//   否则 IP 打码点击切换的判定会失准
//   行序固定：名称·在线（同一行） → IP → 流量 → 用量 → 系统 → 价格 → 到期 → 延迟
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
// usage 三态：true=累计口径 / false=隐藏 / cycle=周期口径
const wantCycle = clean(args.usage).toLowerCase() === "cycle";
const show = {
  overview: showFlag(args.overview, true),
  traffic: showFlag(args.traffic, true),
  usage: wantCycle || showFlag(args.usage, true),
  expire: showFlag(args.expire, true),
  sys: showFlag(args.sys, false),
  uptime: showFlag(args.uptime, false),
  ping: showFlag(args.ping, false),
  price: showFlag(args.price, false),
  ip: showFlag(args.ip, false)
};
const infoItems = ["ip", "traffic", "usage", "sys", "price", "expire", "ping"].filter(k => show[k]);
const showRegion = showFlag(args.region, false);

// IP 打码：默认打码；点击面板刷新切换明文/打码，自动刷新（update-interval 整数倍间隔）不切换
// 与 ip-security 同款时间判定，misfire 容忍 15s
const store = typeof $persistentStore !== "undefined"
  ? $persistentStore
  : { read: () => null, write: () => {} };
let ipMask = 1;
if (show.ip) {
  const stored = parseInt(store.read("komariIpMask"), 10);
  ipMask = Number.isInteger(stored) ? stored : 1;
  const now = Math.floor(Date.now() / 1000);
  const lastRun = parseInt(store.read("komariIpLastRun"), 10) || 0;
  store.write(String(now), "komariIpLastRun");
  const interval = parseInt(clean(args.panel_interval), 10) || 300;
  const tolerance = 15;
  const elapsed = now - lastRun;
  const remainder = elapsed % interval;
  const isAutoRefresh = lastRun > 0 && elapsed > tolerance
    && (remainder <= tolerance || remainder >= interval - tolerance);
  if (lastRun > 0 && !isAutoRefresh) {
    ipMask = ipMask === 1 ? 0 : 1;
    store.write(String(ipMask), "komariIpMask");
  }
}

// IPv4: a.***.***.d；IPv6: 首尾段保留，中间打码
// 访客模式下服务端已给打码形式（203.*.*.*），不再二次打码
const maskIPAddr = ip => {
  if (!ip || ip.includes("*")) return ip;
  if (ip.includes(":")) {
    if (ip.includes("::")) {
      const [left = "", right = ""] = ip.split("::");
      const lg = left ? left.split(":") : [];
      const rg = right ? right.split(":") : [];
      const first = lg[0] || rg[0];
      const last = rg[rg.length - 1] || lg[lg.length - 1];
      if (!first || !last) return ip;
      return first === last ? "::" + first : first + "::**:" + last;
    }
    const parts = ip.split(":");
    if (parts.length <= 2) return ip;
    return parts[0] + ":" + parts.slice(1, -1).map(() => "**").join(":") + ":" + parts[parts.length - 1];
  }
  const parts = ip.split(".");
  if (parts.length !== 4) return ip;
  return parts[0] + ".***.***." + parts[3];
};
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

// 输出去重 + 超时兜底：须小于 sgmodule 的 timeout=30，留 5s 余量，
// 避免 Surge 先杀脚本导致面板空白（cycle 模式有两段串行请求，需要宽松的窗口）
let finished = false;
const done = o => {
  if (finished) return;
  finished = true;
  $done(o);
};
setTimeout(() => {
  done({ title, content: "请求超时", icon: "server.rack", "icon-color": "#9E9E9E" });
}, 25000);

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

// 单级精度：面板场景只需分辨「是否最近重启」，同时控制名称行宽度
const formatUptime = sec => {
  if (sec >= 86400) return `${Math.floor(sec / 86400)} 天`;
  if (sec >= 3600) return `${Math.floor(sec / 3600)} 时`;
  return `${Math.max(1, Math.floor(sec / 60))} 分`;
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
  if (days < 0) return `${dateStr} 已过期 ${-days} 天`;
  if (days === 0) return `${dateStr} 今日到期`;
  return `${dateStr} 余 ${days} 天`;
};

if (!base) {
  done({ title, content: "未填写 url 参数", icon: "xmark.shield.fill", "icon-color": "#CD5C5C" });
} else if (nodesError) {
  done({ title, content: nodesError, icon: "xmark.shield.fill", "icon-color": "#CD5C5C" });
} else {
  const rpcBody = method => JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} });

  // 节点列表：rpc2 getNodes 优先（带 IP 字段），失败回退 REST /api/nodes（无 IP）
  const fetchNodes = () =>
    httpPost(`${base}/api/rpc2`, rpcBody("common:getNodes")).then(raw => {
      const rpc = JSON.parse(raw);
      if (rpc.result && typeof rpc.result === "object") return Object.values(rpc.result);
      throw new Error("getNodes 返回异常");
    }).catch(() => httpGet(`${base}/api/nodes`).then(raw => {
      const j = JSON.parse(raw);
      // 兼容 {status,data:[…]} 包装与裸数组两种返回
      const list = Array.isArray(j) ? j : (Array.isArray(j.data) ? j.data : null);
      if (!list) throw new Error(j.message || "节点列表格式异常");
      return list;
    }));

  Promise.all([
    fetchNodes(),
    httpPost(`${base}/api/rpc2`, rpcBody("common:getNodesLatestStatus")).catch(() => null) // 状态拉取失败时仍显示节点基础信息
  ]).then(([nodesList, statusRaw]) => {
    let nodes = nodesList;

    let statusMap = null;
    if (statusRaw) {
      try {
        const rpc = JSON.parse(statusRaw);
        if (rpc.result && typeof rpc.result === "object") statusMap = rpc.result;
      } catch (e) {}
    }

    // 顶部概览：与 Komari 首页口径一致，统计全部节点（不受 nodes 筛选影响）
    let overview = "";
    if (show.overview && statusMap) {
      let online = 0, up = 0, down = 0;
      const regions = new Set();
      nodes.forEach(n => {
        if (n.region && String(n.region).trim()) regions.add(String(n.region).trim());
        const r = statusMap[n.uuid];
        if (r) {
          if (r.online) online++;
          up += r.net_total_up || 0;
          down += r.net_total_down || 0;
        }
      });
      overview = `在线 ${online}/${nodes.length}｜点亮地区 ${regions.size}\n总量 ↑ ${formatGB(up)} ↓ ${formatGB(down)}`;
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
      // 完整 IP 需 token；访客视后台开关为打码形式或空（空则该行隐藏）
      // 双栈分行显示，上标角标区分（对齐 ip-security 的 IP⁴/IP⁶）；单栈不带角标
      ip: node => {
        const m = v => ipMask ? maskIPAddr(v) : v;
        const v4 = node.ipv4 ? m(node.ipv4) : "";
        const v6 = node.ipv6 ? m(node.ipv6) : "";
        if (v4 && v6) return `IP 地址⁴ ${v4}\nIP 地址⁶ ${v6}`;
        const one = v4 || v6;
        return one ? `IP 地址 ${one}` : "";
      },
      // 对齐 Komari 卡片：↑ 在前
      traffic: (node, rec) => rec &&
        `流量 ↑ ${formatGB(rec.net_total_up || 0)} ↓ ${formatGB(rec.net_total_down || 0)}`,
      usage: (node, rec) => {
        const hasQuota = node.traffic_limit > 0;
        // 有配额：口径严格跟随 Komari 的流量阈值类型（与后台告警一致）；
        // 无配额：Komari 默认的 max 没有对比意义，固定按 sum 显示总流量
        const type = hasQuota ? String(node.traffic_limit_type || "max").toLowerCase() : "sum";
        const cyc = cycleMap[node.uuid];
        const label = cyc ? "周期" : "用量";
        const src = cyc ? cyc : (rec ? { up: rec.net_total_up || 0, down: rec.net_total_down || 0 } : null);
        // 累计口径下无配额不显示（与总流量行重复）；周期口径无配额仍有意义
        if (!src || (!cyc && !hasQuota)) return "";
        const usedGB = calcUsage(src.up, src.down, type) / 1073741824;
        if (!hasQuota) return `${label} ${usageLabel(type)} ${usedGB.toFixed(2)} GB`;
        const quotaGB = node.traffic_limit / 1073741824;
        return `${label} ${usageLabel(type)} ${usedGB.toFixed(2)} / ${quotaGB.toFixed(0)}GB (${(usedGB / quotaGB * 100).toFixed(1)}%)`;
      },
      expire: node => {
        const s = formatExpire(node.expired_at);
        return s && `到期 ${s}`;
      },
      sys: (node, rec) => rec && rec.online &&
        `CPU ${Math.round(rec.cpu || 0)}%｜内存 ${pct(rec.ram, rec.ram_total)}｜磁盘 ${pct(rec.disk, rec.disk_total)}`,
      price: node => {
        if (!(node.price > 0)) return "";
        const unit = cycleLabel(node.billing_cycle);
        // 符号型货币前置（$36.9），字母代码后置（36.9 CNY）
        const cur = node.currency || "$";
        const amount = /^[A-Za-z]/.test(cur) ? `${node.price} ${cur}` : `${cur}${node.price}`;
        return `价格 ${amount}${unit ? "/" + unit : ""}`;
      },
      ping: (node, rec) => {
        if (!rec || !rec.online || !rec.ping) return "";
        const parts = Object.values(rec.ping)
          .filter(p => p && p.latest >= 0)
          .map(p => `${p.name} ${p.latest}ms${p.loss > 0 ? ` 丢${Math.round(p.loss)}%` : ""}`);
        if (!parts.length) return "";
        // 一行一项；后续行用全角空格缩进，与「延迟 」前缀对齐
        return `延迟 ${parts.join("\n　　 ")}`;
      }
    };

    const blocks = nodes.map(node => {
      if (node.missing) return `${node.name}\n无匹配节点`;
      const rec = statusMap ? statusMap[node.uuid] : null;
      const flag = showRegion ? regionFlag(node.region) : "";
      const displayName = flag ? `${flag} ${node.name}` : node.name;

      const lines = [];
      if (!statusMap) lines.push(displayName, "状态获取失败");
      else {
        let nameLine = rec && rec.online ? displayName : `${displayName} ｜ 离线`;
        if (show.uptime && rec && rec.online && rec.uptime > 0) nameLine += ` ｜ 在线 ${formatUptime(rec.uptime)}`;
        lines.push(nameLine);
      }

      infoItems.forEach(key => {
        const build = lineBuilders[key];
        const line = build && build(node, rec);
        if (line) lines.push(line);
      });
      return lines.join("\n");
    });

    const content = (overview ? overview + "\n\n" : "") + blocks.join("\n\n");
    done({ title, content, icon: "server.rack", "icon-color": "#32CD32" });
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
