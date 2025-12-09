/******************************************************
 * Surge Panel - 机场流量监控
 * 
 * 作者: HotKids&Claude
 * 参考: @mieqq 的优秀实现
 * 
 * 功能特性:
 * - 支持单机场/多机场并发查询
 * - 使用 emoji 数字(1️⃣2️⃣3️⃣)分隔多机场配置
 * - 自动从订阅获取流量和到期信息
 * - 支持手动配置到期日期和重置日
 * 
 * 配置参数:
 * - name: 机场名称
 * - sub: 订阅链接(必须 URL encode)
 * - expire: 到期日期(YYYYMMDD/YYYY-MM-DD/Unix时间戳)
 * - reset: 每月重置日(1-31)
 * - title: 面板标题(默认:机场流量信息)
 * - icon: 图标(默认:airplane.departure)
 * - color: 颜色(默认:#007AFF)
 *****************************************************/

(async () => {
  const args = getArgs();
  const title = args.title || "机场流量信息";
  const icon = args.icon || "airplane.departure";
  const color = args.color || "#007AFF";

  // 解析所有参数
  const nameMap = parseSmartMap(toStr(args.name));
  const subMap = parseSmartMap(toStr(args.sub));
  const expireMap = parseSmartMap(toStr(args.expire));
  const resetMap = parseSmartMap(toStr(args.reset));

  const indexes = Object.keys(subMap).sort((a, b) => Number(a) - Number(b));

  if (!indexes.length) {
    $done({
      title: title,
      content: "未配置订阅链接",
      icon: "antenna.radiowaves.left.and.right",
      "icon-color": "#FA8072"
    });
    return;
  }

  // 并发请求所有机场
  const promises = indexes.map(idx => 
    fetchAirportInfo(idx, subMap, nameMap, expireMap, resetMap)
  );
  const results = await Promise.all(promises);
  const validResults = results.filter(r => r !== null);

  if (!validResults.length) {
    $done({
      title: title,
      content: "所有机场获取失败",
      icon: "exclamationmark.triangle",
      "icon-color": "#FA8072"
    });
    return;
  }

  // 生成显示内容
  const now = new Date();
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;

  $done({
    title: `${title} | ${time}`,
    content: "\n" + validResults.join("\n\n"),
    icon: icon,
    "icon-color": color
  });
})();

// ========================================
// 核心函数
// ========================================

/**
 * 获取单个机场的流量信息
 */
function fetchAirportInfo(idx, subMap, nameMap, expireMap, resetMap) {
  return new Promise((resolve) => {
    const subURL = subMap[idx];
    if (!subURL) {
      resolve(null);
      return;
    }

    const name = nameMap[idx] || `Airport-${idx}`;
    const expire = expireMap[idx] || "";
    const resetDay = resetMap[idx] || "";

    // 发起请求
    $httpClient.get(
      {
        url: subURL,
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
 * 智能解析参数映射
 * - 单机场: 直接填值 → {1: value}
 * - 多机场: emoji 数字分隔 → {1: value1, 2: value2}
 */
function parseSmartMap(str) {
  const map = {};
  if (!str) return map;

  const emojiNumbers = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
  const hasEmoji = emojiNumbers.some(emoji => str.includes(emoji));

  if (hasEmoji) {
    // 多机场模式
    emojiNumbers.forEach((emoji, index) => {
      const emojiIndex = str.indexOf(emoji);
      if (emojiIndex === -1) return;

      const startPos = emojiIndex + emoji.length;
      let endPos = str.length;

      // 查找下一个 emoji 位置
      for (let i = index + 1; i < emojiNumbers.length; i++) {
        const nextPos = str.indexOf(emojiNumbers[i], startPos);
        if (nextPos !== -1) {
          endPos = nextPos;
          break;
        }
      }

      const value = str.substring(startPos, endPos).trim();
      if (value) map[String(index + 1)] = value;
    });
  } else {
    // 单机场模式
    map["1"] = str.trim();
  }

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
 */
function getRemainingDays(resetDay) {
  if (!resetDay || resetDay < 1 || resetDay > 31) return;

  const now = new Date();
  const today = now.getDate();
  const month = now.getMonth();
  const year = now.getFullYear();

  if (resetDay > today) {
    // 重置日在本月
    return resetDay - today;
  } else {
    // 重置日在下月
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    return daysInMonth - today + resetDay;
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