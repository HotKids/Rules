/**
 * mihomo 配置覆写脚本（HotKids/Rules 版）
 *
 * 参考：https://github.com/AIsouler/MyClash/blob/main/Script/mihomoScript.js
 * 用途：用于 Clash Verge（或其他支持 Script Provider 的 mihomo 客户端）的
 *       “覆写脚本”（Enhance Script），在任意订阅（如 https://sub.hotkids.me）
 *       导入时，动态生成与本仓库 Surge/Profile.conf 等效的策略组、规则与基础设置，
 *       无需依赖仓库自身的 sync-config.py 静态生成流程。
 * 仓库：https://github.com/HotKids/Rules
 *
 * 与本仓库 Clash/General.yaml、Clash/Sample.yaml 保持同源：
 * - proxy-groups / rules / rule-providers 与 Surge/Profile.conf 一一对应
 * - dns / tun / ntp / sniffer 与 Clash/General.yaml 一致
 */

// --- 策略组启用开关（对应 Surge Profile.conf 的可选分流分组）---
const ruleOptionsEnable = {
  Streaming: true, // 国外流媒体（含港/台/日/新/美分地区引流）
  CNTV: true, // 大陆系海外流媒体（iQIYI Intl / WeTV / Bilibili 等）
  Apple: true, // Apple 服务（Apple TV 除外，暂未纳入本脚本）
  Google: true, // Google 服务（含 Google AI Studio）
  Microsoft: true, // OneDrive / Microsoft 服务
  Telegram: true,
  AIGC: true, // 国外 AI 服务
  Crypto: true,
  Finance: true,
  Mail: true,
  AdGuard: true, // HTTPDNS 阻断 / 广告拦截
};

// --- 排除节点名中的机场信息类噪音（默认关闭：sub.hotkids.me 自建节点无此类噪音）---
const excludeFilterEnable = false;
const excludeFilter =
  /群|返利|循环|官网|客服|网站|网址|获取|订阅|流量|到期|机场|下次|版本|官址|备用|过期|已用|联系|邮箱|工单|通知|国内|地址|频道|无法|说明|使用|提示|特别|访问|支持|教程|关注|更新|作者|加入|超时|收藏|福利|邀请|好友|失联|选择|剩余|公益|发布|通路|登录|禁止|定时|渠道|牢记|永久|余额|阁下|本站|刷新|导航|建议|⚠️|@|Expire|http|com/u;

// --- 地区策略组（与 Profile.conf 的 policy-regex-filter 完全一致）---
const regionDefinitions = [
  {
    name: '🇭🇰 Hong Kong',
    filter: '🇭🇰|HK|Hong Kong|香港',
    icon: 'https://testingcf.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Hong_Kong.png',
  },
  {
    name: '🇨🇳 Taiwan',
    filter: '🇨🇳|🇹🇼|TW|Taiwan|台湾',
    icon: 'https://testingcf.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Taiwan.png',
  },
  {
    name: '🇸🇬 Singapore',
    filter: '🇸🇬|SG|Singapore|新加坡',
    icon: 'https://testingcf.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Singapore.png',
  },
  {
    name: '🇯🇵 Japan',
    filter: '🇯🇵|JP|Japan|日本',
    icon: 'https://testingcf.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Japan.png',
  },
  {
    name: '🇺🇸 America',
    filter: '🇺🇸|US|United States|美国',
    icon: 'https://testingcf.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/United_States.png',
  },
];

// --- Rule Provider 公共配置 ---
const rpClassical = { type: 'http', behavior: 'classical', interval: 86400 };
const rpDomain = { type: 'http', behavior: 'domain', interval: 86400 };
const rpIpcidr = { type: 'http', behavior: 'ipcidr', interval: 86400 };

// --- 常驻 Rule Providers（不受开关控制，始终生效）---
const baseRuleProviders = {
  Bypass: {
    ...rpClassical,
    path: './Provider/RuleSet/Bypass.yaml',
    url: 'https://testingcf.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Bypass.yaml',
  },
  Reroute: {
    ...rpClassical,
    path: './Provider/RuleSet/Reroute.yaml',
    url: 'https://testingcf.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Reroute.yaml',
  },
  Private: {
    ...rpDomain,
    path: './Provider/RuleSet/Private.yaml',
    url: 'https://testingcf.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/private.txt',
  },
  Global: {
    ...rpDomain,
    path: './Provider/RuleSet/Global.yaml',
    url: 'https://testingcf.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/proxy.txt',
  },
  China: {
    ...rpDomain,
    path: './Provider/RuleSet/China.yaml',
    url: 'https://testingcf.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/direct.txt',
  },
  CNASN: {
    ...rpClassical,
    path: './Provider/RuleSet/CNASN.yaml',
    url: 'https://testingcf.jsdelivr.net/gh/VirgilClyne/GetSomeFries@main/ruleset/ASN.China.yaml',
  },
  CNCIDR: {
    ...rpIpcidr,
    path: './Provider/RuleSet/CNCIDR.yaml',
    url: 'https://testingcf.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/cncidr.txt',
  },
  LAN: {
    ...rpIpcidr,
    path: './Provider/RuleSet/LANCIDR.yaml',
    url: 'https://testingcf.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/lancidr.txt',
  },
};

// --- 可选 Rule Providers（按 ruleOptionsEnable 开关裁剪）---
const optionalRuleProviders = {
  AdGuard: {
    HTTPDNS: {
      ...rpClassical,
      path: './Provider/RuleSet/HTTPDNS.yaml',
      url: 'https://testingcf.jsdelivr.net/gh/VirgilClyne/GetSomeFries@main/ruleset/HTTPDNS.Block.yaml',
    },
    Reject: {
      ...rpDomain,
      path: './Provider/RuleSet/Reject.yaml',
      url: 'https://testingcf.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/reject.txt',
    },
    AdBlock: {
      ...rpClassical,
      path: './Provider/RuleSet/AdBlock.yaml',
      url: 'https://testingcf.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Block.yaml',
    },
  },
  Streaming: {
    Streaming_TW: {
      ...rpClassical,
      path: './Provider/RuleSet/Streaming_TW.yaml',
      url: 'https://testingcf.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Streaming_TW.yaml',
    },
    Streaming_JP: {
      ...rpClassical,
      path: './Provider/RuleSet/Streaming_JP.yaml',
      url: 'https://testingcf.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Streaming_JP.yaml',
    },
    Streaming_US: {
      ...rpClassical,
      path: './Provider/RuleSet/Streaming_US.yaml',
      url: 'https://testingcf.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Streaming_US.yaml',
    },
    Streaming: {
      ...rpClassical,
      path: './Provider/RuleSet/Streaming.yaml',
      url: 'https://testingcf.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Streaming.yaml',
    },
  },
  CNTV: {
    CNTV: {
      ...rpClassical,
      path: './Provider/RuleSet/CNTV.yaml',
      url: 'https://testingcf.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/CNTV.yaml',
    },
  },
  Google: {
    'Google AI Studio': {
      ...rpClassical,
      path: './Provider/RuleSet/Google_AI_Studio.yaml',
      url: 'https://testingcf.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Gemini.yaml',
    },
    Google: {
      ...rpClassical,
      path: './Provider/RuleSet/Google.yaml',
      url: 'https://testingcf.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Google.yaml',
    },
  },
  AIGC: {
    AIGC: {
      ...rpClassical,
      path: './Provider/RuleSet/AIGC.yaml',
      url: 'https://testingcf.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/GenAI.yaml',
    },
  },
  Apple: {
    'Apple CN': {
      ...rpClassical,
      path: './Provider/RuleSet/Apple_CN.yaml',
      url: 'https://testingcf.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Apple%20CN.yaml',
    },
    Apple: {
      ...rpClassical,
      path: './Provider/RuleSet/Apple.yaml',
      url: 'https://testingcf.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Apple.yaml',
    },
  },
  Microsoft: {
    OneDrive: {
      ...rpClassical,
      path: './Provider/RuleSet/OneDrive.yaml',
      url: 'https://testingcf.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/OneDrive.yaml',
    },
    Microsoft: {
      ...rpClassical,
      path: './Provider/RuleSet/Microsoft.yaml',
      url: 'https://testingcf.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Microsoft.yaml',
    },
  },
  Telegram: {
    Telegram: {
      ...rpClassical,
      path: './Provider/RuleSet/Telegram.yaml',
      url: 'https://testingcf.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Telegram.yaml',
    },
  },
  Crypto: {
    Crypto: {
      ...rpClassical,
      path: './Provider/RuleSet/Crypto.yaml',
      url: 'https://testingcf.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Crypto.yaml',
    },
  },
  Finance: {
    Finance: {
      ...rpClassical,
      path: './Provider/RuleSet/Finance.yaml',
      url: 'https://testingcf.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Finance.yaml',
    },
  },
  Mail: {
    Spark: {
      ...rpClassical,
      path: './Provider/RuleSet/Spark.yaml',
      url: 'https://testingcf.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Spark.yaml',
    },
  },
};

function main(config) {
  if (!Array.isArray(config.proxies) || config.proxies.length === 0) {
    throw new Error('未找到任何代理节点，请先绑定含有效节点的订阅（如 https://sub.hotkids.me）再启用本脚本');
  }

  if (excludeFilterEnable) {
    config.proxies = config.proxies.filter((p) => !excludeFilter.test(p.name));
  }

  // --- 地区策略组 + 全部节点池（原生 include-all + filter，无需手动分类）---
  const regionGroups = regionDefinitions.map((r) => ({
    name: r.name,
    type: 'select',
    icon: r.icon,
    'include-all': true,
    filter: r.filter,
  }));
  const regionNames = regionGroups.map((g) => g.name);

  const serverGroup = {
    name: '🇺🇳 Server',
    type: 'select',
    icon: 'https://testingcf.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Color/Club.png',
    'include-all': true,
  };

  const proxyGroup = {
    name: '🔰 Proxy',
    type: 'select',
    icon: 'https://testingcf.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Color/Outbound.png',
    proxies: [...regionNames, '🇺🇳 Server', '🔘 DIRECT'],
  };

  // --- 隐藏的 DIRECT/REJECT 动作包装组（供分流组直接引用）---
  const actionWrapperGroups = [
    {
      name: '🔘 DIRECT',
      type: 'select',
      icon: 'https://testingcf.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Color/Direct.png',
      hidden: true,
      proxies: ['DIRECT'],
    },
    {
      name: '⛔️ REJECT',
      type: 'select',
      icon: 'https://testingcf.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Color/Reject.png',
      hidden: true,
      proxies: ['REJECT'],
    },
    {
      name: '📛 REJECT-DROP',
      type: 'select',
      icon: 'https://testingcf.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Color/Reject.png',
      hidden: true,
      proxies: ['REJECT-DROP'],
    },
  ];

  // --- 按开关裁剪 Rule Providers ---
  const ruleProviders = { ...baseRuleProviders };
  for (const [key, providers] of Object.entries(optionalRuleProviders)) {
    if (ruleOptionsEnable[key]) Object.assign(ruleProviders, providers);
  }

  // --- 分流策略组（顺序与 Surge Profile.conf / Clash Sample.yaml 一致）---
  const functionalGroups = [];

  if (ruleOptionsEnable.Streaming) {
    functionalGroups.push({
      name: '🎬 Streaming',
      type: 'select',
      icon: 'https://testingcf.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Color/Streaming.png',
      proxies: ['🔰 Proxy', ...regionNames, '🇺🇳 Server'],
    });
  }
  if (ruleOptionsEnable.CNTV) {
    functionalGroups.push({
      name: '📺 CNTV',
      type: 'select',
      icon: 'https://testingcf.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Color/StreamingCN.png',
      proxies: ['🔘 DIRECT', '🇨🇳 Taiwan', '🇭🇰 Hong Kong'],
    });
  }
  if (ruleOptionsEnable.Apple) {
    functionalGroups.push({
      name: '🍎 Apple',
      type: 'select',
      icon: 'https://testingcf.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Apple.png',
      proxies: ['🔘 DIRECT', '🔰 Proxy', '🇺🇸 America', '🇯🇵 Japan'],
    });
  }
  if (ruleOptionsEnable.Google) {
    functionalGroups.push({
      name: '🔍 Google',
      type: 'select',
      icon: 'https://testingcf.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Color/Google.png',
      proxies: ['🇺🇸 America', '🔰 Proxy'],
    });
  }
  if (ruleOptionsEnable.Microsoft) {
    functionalGroups.push(
      {
        name: '☁️ OneDrive',
        type: 'select',
        icon: 'https://testingcf.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Color/OneDrive.png',
        proxies: ['🔘 DIRECT', '🔰 Proxy'],
      },
      {
        name: 'Ⓜ️ Microsoft',
        type: 'select',
        icon: 'https://testingcf.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Microsoft.png',
        proxies: ['🔘 DIRECT', '🔰 Proxy'],
      },
    );
  }
  if (ruleOptionsEnable.Telegram) {
    functionalGroups.push({
      name: '📬 Telegram',
      type: 'select',
      icon: 'https://testingcf.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Telegram.png',
      proxies: ['🔰 Proxy', '🇸🇬 Singapore', '🔘 DIRECT'],
    });
  }
  if (ruleOptionsEnable.AIGC) {
    functionalGroups.push({
      name: '🤖 AIGC',
      type: 'select',
      icon: 'https://testingcf.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/ChatGPT.png',
      proxies: ['🇺🇸 America', '🇸🇬 Singapore', '🔰 Proxy'],
    });
  }
  if (ruleOptionsEnable.Crypto) {
    functionalGroups.push({
      name: '🪙 Crypto',
      type: 'select',
      icon: 'https://testingcf.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Cryptocurrency_3.png',
      proxies: ['🇺🇸 America', '🔰 Proxy', '🔘 DIRECT'],
    });
  }
  if (ruleOptionsEnable.Finance) {
    functionalGroups.push({
      name: '💳 Finance',
      type: 'select',
      icon: 'https://testingcf.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Color/Finance.png',
      proxies: ['🇺🇸 America', '🔰 Proxy', '🔘 DIRECT'],
    });
  }
  if (ruleOptionsEnable.Mail) {
    functionalGroups.push({
      name: '📧 Mail',
      type: 'select',
      icon: 'https://testingcf.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Mail.png',
      proxies: ['🔰 Proxy', '🔘 DIRECT'],
    });
  }
  if (ruleOptionsEnable.AdGuard) {
    functionalGroups.push({
      name: '🚧 AdGuard',
      type: 'select',
      icon: 'https://testingcf.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Color/Block.png',
      proxies: ['🔘 DIRECT', '⛔️ REJECT', '📛 REJECT-DROP'],
    });
  }

  // --- 规则（顺序与 Surge Profile.conf / Clash Sample.yaml 一致，按开关裁剪）---
  const rules = [
    // 标准 SSH 端口
    'AND,((DST-PORT,22),(NETWORK,TCP)),🔘 DIRECT',
    // 禁用国外 QUIC（UDP 443），强制回退 TCP；国内放行
    'AND,((NETWORK,UDP),(DST-PORT,443),(NOT,((OR,((GEOSITE,cn),(GEOIP,CN)))))),REJECT',
    // Unbreak 后续规则修正
    'RULE-SET,Bypass,🔘 DIRECT',
    'RULE-SET,Reroute,🔰 Proxy',
    // Private 私有网络
    'RULE-SET,Private,🔘 DIRECT',
  ];

  if (ruleOptionsEnable.AdGuard) {
    rules.push('RULE-SET,HTTPDNS,🚧 AdGuard', 'RULE-SET,Reject,🚧 AdGuard', 'RULE-SET,AdBlock,🚧 AdGuard');
  }
  if (ruleOptionsEnable.Streaming) {
    rules.push(
      'RULE-SET,Streaming_TW,🇨🇳 Taiwan',
      'RULE-SET,Streaming_JP,🇯🇵 Japan',
      'RULE-SET,Streaming_US,🇺🇸 America',
      'RULE-SET,Streaming,🎬 Streaming',
    );
  }
  if (ruleOptionsEnable.CNTV) {
    rules.push('RULE-SET,CNTV,📺 CNTV');
  }
  if (ruleOptionsEnable.Google) {
    rules.push('RULE-SET,Google AI Studio,🔍 Google');
  }
  if (ruleOptionsEnable.AIGC) {
    rules.push('RULE-SET,AIGC,🤖 AIGC');
  }
  if (ruleOptionsEnable.Apple) {
    rules.push('RULE-SET,Apple CN,🔘 DIRECT', 'RULE-SET,Apple,🍎 Apple');
  }
  if (ruleOptionsEnable.Google) {
    rules.push('RULE-SET,Google,🔍 Google');
  }
  if (ruleOptionsEnable.Microsoft) {
    rules.push('RULE-SET,OneDrive,☁️ OneDrive', 'RULE-SET,Microsoft,Ⓜ️ Microsoft');
  }
  if (ruleOptionsEnable.Telegram) {
    rules.push('RULE-SET,Telegram,📬 Telegram');
  }
  if (ruleOptionsEnable.Crypto) {
    rules.push('RULE-SET,Crypto,🪙 Crypto');
  }
  if (ruleOptionsEnable.Finance) {
    rules.push('RULE-SET,Finance,💳 Finance');
  }
  if (ruleOptionsEnable.Mail) {
    rules.push('RULE-SET,Spark,📧 Mail');
  }

  rules.push(
    // Global (DNS 污染 / IP 黑洞 / 地区限制 / 网络抖动)
    'RULE-SET,Global,🔰 Proxy',
    // China Area Network
    'RULE-SET,China,🔘 DIRECT',
    'RULE-SET,CNASN,🔘 DIRECT',
    'RULE-SET,CNCIDR,🔘 DIRECT',
    // Local Area Network
    'RULE-SET,LAN,🔘 DIRECT',
    // GeoIP
    'GEOSITE,cn,🔘 DIRECT',
    'GEOIP,CN,🔘 DIRECT,no-resolve',
    'GEOSITE,geolocation-!cn,🔰 Proxy',
    // Final
    'MATCH,🔰 Proxy',
  );

  // --- 基础设置（与 Clash/General.yaml 保持一致）---
  config['mixed-port'] = 7892;
  config['allow-lan'] = true;
  config['bind-address'] = '*';
  config['mode'] = 'rule';
  config['log-level'] = 'info';
  config['ipv6'] = false;
  config['external-controller'] = '127.0.0.1:9090';
  config['unified-delay'] = true;
  config['tcp-concurrent'] = true;
  config['find-process-mode'] = 'strict';
  config['geodata-loader'] = 'standard';
  config['global-ua'] = 'clash.meta';
  config['keep-alive-interval'] = 30;
  config['geo-auto-update'] = true;
  config['geo-update-interval'] = 24;
  config['geox-url'] = {
    geoip: 'https://testingcf.jsdelivr.net/gh/Loyalsoldier/v2ray-rules-dat@release/geoip.dat',
    geosite: 'https://testingcf.jsdelivr.net/gh/Loyalsoldier/v2ray-rules-dat@release/geosite.dat',
    mmdb: 'https://testingcf.jsdelivr.net/gh/Loyalsoldier/geoip@release/Country.mmdb',
    asn: 'https://testingcf.jsdelivr.net/gh/Loyalsoldier/geoip@release/GeoLite2-ASN.mmdb',
  };

  config['hosts'] = {
    '*.clash.dev': '127.0.0.1',
    localhost: '127.0.0.1',
  };

  config['profile'] = {
    'store-selected': true,
    'store-fake-ip': true,
  };

  config['ntp'] = {
    enable: true,
    'write-to-system': false,
    server: 'ntp.aliyun.com',
    port: 123,
    interval: 60,
  };

  config['sniffer'] = {
    enable: true,
    'override-destination': false,
    'force-dns-mapping': true,
    'parse-pure-ip': false,
    sniff: {
      HTTP: { ports: [80, '8080-8880'], 'override-destination': true },
      TLS: { ports: [443, 8443] },
      QUIC: { ports: [443, 8443] },
    },
    'skip-domain': ['+.push.apple.com', 'Mijia Cloud'],
  };

  config['dns'] = {
    enable: true,
    listen: '0.0.0.0:1053',
    ipv6: false,
    'use-system-hosts': true,
    'cache-algorithm': 'arc',
    'prefer-h3': false,
    'respect-rules': false,
    'default-nameserver': ['223.5.5.5', '119.29.29.29'],
    'enhanced-mode': 'fake-ip',
    'fake-ip-range': '198.18.0.1/16',
    'fake-ip-range6': '',
    'fake-ip-ttl': 1,
    'fake-ip-filter-mode': 'blacklist',
    'fake-ip-filter': [
      '*.lan',
      '+.lan',
      '*.local',
      '*.localdomain',
      '*.home.arpa',
      '*.localhost',
      'WORKGROUP',
      'time.*.com',
      'time.*.gov',
      'time.*.apple.com',
      'ntp.*.com',
      '+.pool.ntp.org',
      '*.ntp.org.cn',
      '+.stun.*',
      '*.stun.*.*',
      '*.turn.twilio.com',
      '*.stun.twilio.com',
      'stun.syncthing.net',
      '*.srv.nintendo.net',
      'xbox.*.microsoft.com',
      'xbox.*.*.microsoft.com',
      '*.xboxlive.com',
      '*.cm.steampowered.com',
      '*.steamcontent.com',
      '*.battlenet.com.cn',
      '*.battlenet.com',
      '*.blzstatic.cn',
      '*.battle.net',
      '*.msftncsi.com',
      '*.msftconnecttest.com',
      'connectivitycheck.gstatic.com',
      'connectivitycheck.android.com',
      'connectivitycheck.platform.hicloud.com',
      'connect.rom.miui.com',
      'captive.apple.com',
      'network-test.debian.org',
      'detectportal.firefox.com',
      'lens.l.google.com',
      '+.push.apple.com',
      '+.market.xiaomi.com',
      '*.tailscale.com',
      '*.zerotier.com',
      '*.spotify.com',
      '+.music.126.net',
      '*.mcdn.bilivideo.cn',
      'localhost.*.qq.com',
    ],
    nameserver: ['https://8.8.8.8/dns-query#proxy&disable-ipv6=true&ecs=114.114.114.114/24&ecs-override=true'],
    fallback: ['https://1.1.1.1/dns-query#proxy'],
    'fallback-filter': {
      geoip: true,
      'geoip-code': 'CN',
      ipcidr: ['240.0.0.0/4'],
    },
    'proxy-server-nameserver': ['https://doh.pub/dns-query'],
    'direct-nameserver': ['https://doh.pub/dns-query'],
    'direct-nameserver-follow-policy': false,
  };

  config['tun'] = {
    enable: true,
    stack: 'mixed',
    'dns-hijack': ['any:53'],
    'auto-route': true,
    'auto-detect-interface': true,
    'auto-redirect': true,
    gso: true,
    'gso-max-size': 65536,
    'strict-route': true,
    'endpoint-independent-nat': true,
    'disable-icmp-forwarding': true,
  };

  config['proxy-groups'] = [
    proxyGroup,
    ...functionalGroups,
    ...actionWrapperGroups,
    serverGroup,
    ...regionGroups,
  ];
  config['rule-providers'] = ruleProviders;
  config['rules'] = rules;

  return config;
}
