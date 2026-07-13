/******************************************************
 * Surge Panel - 机场流量监控
 *
 * 作者: HotKids&Claude
 * 参考: @mieqq 的优秀实现
 *
 * 功能特性:
 * - 支持单机场/多机场并发查询
 * - 与 vps-traffic 同款配置语法（; 分隔多机场，名称:值 逐机覆盖）
 * - 自动从订阅获取流量和到期信息
 * - 支持手动配置到期日期和重置日
 *
 * 配置参数:
 * - sub: 订阅列表，格式：名称#订阅URL;名称#订阅URL（URL 需单独 URL encode；名称省略时自动编号）
 * - expire: 到期日期(YYYYMMDD/YYYY-MM-DD/Unix时间戳)，默认值;名称:值 逐机覆盖
 * - reset: 每月重置日(1-31)，默认值;名称:值 逐机覆盖
 * - title: 面板标题(默认:机场流量信息)
 * - icon: 图标(默认:airplane.departure)
 * - color: 颜色(默认:#007AFF)
 *****************************************************/

// 输出去重 + 超时兜底：任一订阅请求挂起时，看门狗先于 Surge 的脚本超时输出面板，
// 未返回的机场标注超时、其余正常显示
let finished = false;
function done(o) {
  if (finished) return;
  finished = true;
  $done(o);
}

(async () => {
  const args = getArgs();
  const title = args.title || "机场流量信息";
  const icon = args.icon || "airplane.departure";
  const color = args.color || "#007AFF";

  // 订阅列表: 名称#URL;名称#URL（名称省略时自动编号）
  const entries = toStr(args.sub).split(";").map(s => s.trim()).filter(Boolean).map((raw, i) => {
    const at = raw.indexOf("#");
    const name = at === -1 ? "" : raw.slice(0, at).trim();
    const url = at === -1 ? raw : raw.slice(at + 1).trim();
    return { name: name || `Airport-${i + 1}`, url };
  });

  if (!entries.length) {
    done({
      title: title,
      content: "未配置订阅链接",
      icon: "antenna.radiowaves.left.and.right",
      "icon-color": "#FA8072"
    });
    return;
  }

  const expireMap = parseKeyedMap(toStr(args.expire));
  const resetMap = parseKeyedMap(toStr(args.reset));

  const results = new Array(entries.length);
  const finish = () => {
    entries.forEach((e, i) => { if (results[i] === undefined) results[i] = `${e.name}\n用量：请求超时`; });
    const now = new Date();
    const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    done({
      title: `${title} | ${time}`,
      content: "\n" + results.join("\n\n"),
      icon: icon,
      "icon-color": color
    });
  };
  setTimeout(finish, 9000);

  // 并发请求所有机场
  await Promise.all(entries.map((entry, i) =>
    fetchAirportInfo(entry, expireMap, resetMap).then(r => { results[i] = r; })
  ));
  finish();
})();

// ========================================
// 核心函数
// ========================================

/**
 * 获取单个机场的流量信息
 */
function fetchAirportInfo(entry, expireMap, resetMap) {
  return new Promise((resolve) => {
    const name = entry.name;
    const expire = expireMap[name] !== undefined ? expireMap[name] : (expireMap.default || "");
    const resetDay = resetMap[name] !== undefined ? resetMap[name] : (resetMap.default || "");

    // 发起请求
    $httpClient.get(
      {
        url: entry.url,
        headers: { "User-Agent": "Quantumult%20X" },
        timeout: 10000
      },
      (error, response) => {
        // 错误处理
        if (error || !response || response.status !== 200) {
          resolve(buildErrorBlock(name));
          return;
        }

        // 查找订阅信息头(不区分大小写)
        const headers = response.headers || {};
        const headerKey = Object.keys(headers).find(
          key => key.toLowerCase() === "subscription-userinfo"
        );

        if (!headerKey || !headers[headerKey]) {
          resolve(buildErrorBlock(name));
          return;
        }

        // 解析流量信息
        const info = parseUserInfo(headers[headerKey]);
        if (!info || info.total === 0) {
          resolve(buildErrorBlock(name));
          return;
        }

        // 构建显示内容
        resolve(buildDisplayContent(name, info, expire, resetDay));
      }
    );
  });
}

/**
 * 构建显示内容
 */
function buildDisplayContent(name, info, expire, resetDay) {
  const used = info.upload + info.download;
  const remain = Math.max(info.total - used, 0);

  let result = `${name}\n用量：${bytesToSize(used)} ｜ ${bytesToSize(remain)}`;

  // 添加重置日期
  if (resetDay) {
    const daysLeft = getRemainingDays(parseInt(resetDay));
    if (daysLeft !== undefined) {
      result += `\n重置：每月 ${resetDay} 日（剩 ${daysLeft} 天）`;
    }
  }

  // 添加到期日期
  const expireTs = getExpireTimestamp(expire, info.expire);
  if (expireTs > 0) {
    const expireDate = formatDate(expireTs * 1000);
    const daysLeft = calcDaysRemaining(expireTs);
    const status = daysLeft >= 0 ? `剩 ${daysLeft} 天` : "已过期";
    result += `\n到期：${expireDate}（${status}）`;
  }

  return result;
}

// ========================================
// 参数解析
// ========================================

/**
 * 解析 URL 参数并 decode
 */
function getArgs() {
  if (!$argument) return {};
  return Object.fromEntries(
    $argument
      .split("&")
      .map(item => item.split("="))
      .map(([k, v]) => [k, decodeURIComponent(v || "")])
  );
}

/**
 * 转字符串(处理 null/undefined)
 */
function toStr(v) {
  if (v === undefined || v === null || v === "null" || v === "undefined") {
    return "";
  }
  return String(v);
}

/**
 * 解析「默认值;名称:值」式参数映射（与 vps-traffic 同款语法）
 * - 不含 ":" 的片段视为默认值 → map.default
 * - "名称:值" 逐机覆盖 → map[名称]
 */
function parseKeyedMap(str) {
  const map = {};
  if (!str) return map;

  str.split(";").forEach(item => {
    item = item.trim();
    if (!item) return;
    const at = item.indexOf(":");
    if (at === -1) {
      map.default = item;
    } else {
      const k = item.slice(0, at).trim();
      const v = item.slice(at + 1).trim();
      if (k && v) map[k] = v;
    }
  });

  return map;
}

// ========================================
// 数据解析
// ========================================

/**
 * 解析订阅信息头
 * 格式: upload=xxx; download=xxx; total=xxx; expire=xxx
 */
function parseUserInfo(str) {
  if (!str) return null;

  const obj = {};
  const matches = str.match(/\w+=[\d.eE+]+/g);
  if (!matches) return null;

  matches.forEach(item => {
    const [k, v] = item.split("=");
    if (k && v) obj[k] = Number(v);
  });

  return {
    upload: obj.upload || 0,
    download: obj.download || 0,
    total: obj.total || 0,
    expire: obj.expire || 0
  };
}

/**
 * 获取到期时间戳
 * 优先使用参数配置,否则使用订阅返回值
 */
function getExpireTimestamp(expire, infoExpire) {
  if (expire && expire !== "false") {
    if (/^\d{8}$/.test(expire)) {
      // YYYYMMDD 格式
      const y = expire.slice(0, 4);
      const m = expire.slice(4, 6);
      const d = expire.slice(6, 8);
      return Math.floor(Date.parse(`${y}-${m}-${d}T00:00:00`) / 1000);
    }
    if (/^[\d.]+$/.test(expire)) {
      // Unix 时间戳
      return parseInt(expire);
    }
    // ISO 日期字符串
    return Math.floor(Date.parse(expire) / 1000);
  }
  return infoExpire || 0;
}

// ========================================
// 日期计算
// ========================================

/**
 * 计算距离重置日的剩余天数
 * 重置日超过当月天数时按当月最后一天计（如 31 号重置遇 2 月 → 28/29 号）
 */
function getRemainingDays(resetDay) {
  if (!resetDay || resetDay < 1 || resetDay > 31) return;

  const now = new Date();
  const today = now.getDate();
  const month = now.getMonth();
  const year = now.getFullYear();
  const clampToMonth = (y, m) => Math.min(resetDay, new Date(y, m + 1, 0).getDate());

  const thisMonthReset = clampToMonth(year, month);
  if (thisMonthReset > today) {
    // 重置日在本月
    return thisMonthReset - today;
  } else {
    // 重置日在下月
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    return daysInMonth - today + clampToMonth(year, month + 1);
  }
}

/**
 * 计算剩余天数
 */
function calcDaysRemaining(ts) {
  const now = new Date();
  const end = new Date(ts * 1000);
  return Math.floor((end - now) / 86400000);
}

// ========================================
// 格式化函数
// ========================================

/**
 * 字节转可读格式
 */
function bytesToSize(bytes) {
  if (!bytes || bytes <= 0) return "0 B";

  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(k)),
    sizes.length - 1
  );

  return (bytes / Math.pow(k, i)).toFixed(2) + " " + sizes[i];
}

/**
 * 格式化日期 (YYYY-MM-DD)
 */
function formatDate(timestamp) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  return `${year}-${month}-${day}`;
}

/**
 * 数字补零
 */
function pad(n) {
  return n < 10 ? "0" + n : String(n);
}

/**
 * 构建错误信息
 */
function buildErrorBlock(name) {
  return `${name}\n用量：获取失败`;
}
