/**
 * mihomo 覆写脚本（Enhance Script）· HotKids/Rules
 *
 * 用途：在 Clash Verge 等支持「覆写脚本」的 mihomo 客户端里，对任意订阅
 * （如 https://sub.hotkids.me）动态套用与本仓库 Surge/Profile.conf 等效的
 * 策略组、分流规则与基础设置，不必依赖机场自带配置。
 *
 * 自动生成，请勿手改：由 sync-config.py 从 Surge/Profile.conf（经
 * Clash/Sample.yaml）转译而来，直接改本文件会在下次同步时被覆盖；
 * 要改内容请改 Surge/Profile.conf。
 *
 * 本地唯一可临时修改的是下方 ruleOptionsEnable 的取值，用于按需开关某个分组。
 *
 * 仓库：https://github.com/HotKids/Rules
 */

// 分流分组开关：true 启用 / false 关闭对应分组（连同其专属 rules /
// rule-providers 一并裁剪，无需改动 Profile.conf）。默认值见下方——
// 大多默认启用，个别按需默认关闭的直接标成 false，本地可随时改回 true。
const ruleOptionsEnable = {
  '🎬 Streaming': true,
  '📺 CNTV': true,
  '🍎 Apple': true,
  '🔍 Google': true,
  '☁️ OneDrive': true,
  'Ⓜ️ Microsoft': true,
  '📬 Telegram': true,
  '🤖 AIGC': true,
  '🪙 Crypto': true,
  '💳 Finance': true,
  '📧 Mail': true,
  '🚧 AdGuard': true,
};

function main(config) {
  if (!Array.isArray(config.proxies) || config.proxies.length === 0) {
    throw new Error('未找到任何代理节点，请先绑定含有效节点的订阅（如 https://sub.hotkids.me）再启用本脚本');
  }

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
    geoip: 'https://fastly.jsdelivr.net/gh/Loyalsoldier/v2ray-rules-dat@release/geoip.dat',
    geosite: 'https://fastly.jsdelivr.net/gh/Loyalsoldier/v2ray-rules-dat@release/geosite.dat',
    mmdb: 'https://fastly.jsdelivr.net/gh/Loyalsoldier/geoip@release/Country.mmdb',
    asn: 'https://fastly.jsdelivr.net/gh/Loyalsoldier/geoip@release/GeoLite2-ASN.mmdb',
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
      HTTP: {
        ports: [
          80,
          '8080-8880',
        ],
        'override-destination': true,
      },
      TLS: {
        ports: [
          443,
          8443,
        ],
      },
      QUIC: {
        ports: [
          443,
          8443,
        ],
      },
    },
    'skip-domain': [
      '+.push.apple.com',
      'Mijia Cloud',
    ],
  };

  config['dns'] = {
    enable: true,
    listen: '0.0.0.0:1053',
    ipv6: false,
    'use-system-hosts': true,
    'cache-algorithm': 'arc',
    'prefer-h3': false,
    'respect-rules': false,
    'default-nameserver': [
      '223.5.5.5',
      '119.29.29.29',
    ],
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
    nameserver: [
      'https://8.8.8.8/dns-query#proxy&disable-ipv6=true&ecs=114.114.114.114/24&ecs-override=true',
    ],
    fallback: [
      'https://1.1.1.1/dns-query#proxy',
    ],
    'fallback-filter': {
      geoip: true,
      'geoip-code': 'CN',
      ipcidr: [
        '240.0.0.0/4',
      ],
    },
    'proxy-server-nameserver': [
      'https://doh.pub/dns-query',
    ],
    'direct-nameserver': [
      'https://doh.pub/dns-query',
    ],
    'direct-nameserver-follow-policy': false,
  };

  config['tun'] = {
    enable: true,
    stack: 'mixed',
    'dns-hijack': [
      'any:53',
    ],
    'auto-route': true,
    'auto-detect-interface': true,
    'auto-redirect': true,
    gso: true,
    'gso-max-size': 65536,
    'strict-route': true,
    'endpoint-independent-nat': true,
    'disable-icmp-forwarding': true,
  };

  const proxyGroups = [
    {
      name: '🔰 Proxy',
      type: 'select',
      icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Color/Outbound.png',
      proxies: [
        '🇭🇰 Hong Kong',
        '🇨🇳 Taiwan',
        '🇸🇬 Singapore',
        '🇯🇵 Japan',
        '🇺🇸 America',
        '🇺🇳 Server',
        '🔘 DIRECT',
      ],
    },
    {
      name: '🎬 Streaming',
      type: 'select',
      icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Color/Streaming.png',
      proxies: [
        '🔰 Proxy',
        '🇭🇰 Hong Kong',
        '🇨🇳 Taiwan',
        '🇸🇬 Singapore',
        '🇯🇵 Japan',
        '🇺🇸 America',
        '🇺🇳 Server',
      ],
    },
    {
      name: '📺 CNTV',
      type: 'select',
      icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Color/StreamingCN.png',
      proxies: [
        '🔘 DIRECT',
        '🇨🇳 Taiwan',
        '🇭🇰 Hong Kong',
      ],
    },
    {
      name: '🍎 Apple',
      type: 'select',
      icon: 'https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Apple.png',
      proxies: [
        '🔘 DIRECT',
        '🔰 Proxy',
        '🇺🇸 America',
        '🇯🇵 Japan',
      ],
    },
    {
      name: '🔍 Google',
      type: 'select',
      icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Color/Google.png',
      proxies: [
        '🇺🇸 America',
        '🔰 Proxy',
      ],
    },
    {
      name: '☁️ OneDrive',
      type: 'select',
      icon: 'https://testingcf.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Color/OneDrive.png',
      proxies: [
        '🔘 DIRECT',
        '🔰 Proxy',
      ],
    },
    {
      name: 'Ⓜ️ Microsoft',
      type: 'select',
      icon: 'https://testingcf.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Microsoft.png',
      proxies: [
        '🔘 DIRECT',
        '🔰 Proxy',
      ],
    },
    {
      name: '📬 Telegram',
      type: 'select',
      icon: 'https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Telegram.png',
      proxies: [
        '🔰 Proxy',
        '🇸🇬 Singapore',
        '🔘 DIRECT',
      ],
    },
    {
      name: '🤖 AIGC',
      type: 'select',
      icon: 'https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/ChatGPT.png',
      proxies: [
        '🇺🇸 America',
        '🇸🇬 Singapore',
        '🔰 Proxy',
      ],
    },
    {
      name: '🪙 Crypto',
      type: 'select',
      icon: 'https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Cryptocurrency_3.png',
      proxies: [
        '🇺🇸 America',
        '🔰 Proxy',
        '🔘 DIRECT',
      ],
    },
    {
      name: '💳 Finance',
      type: 'select',
      icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Color/Finance.png',
      proxies: [
        '🇺🇸 America',
        '🔰 Proxy',
        '🔘 DIRECT',
      ],
    },
    {
      name: '📧 Mail',
      type: 'select',
      icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Color/Mail.png',
      proxies: [
        '🔰 Proxy',
        '🔘 DIRECT',
      ],
    },
    {
      name: '🚧 AdGuard',
      type: 'select',
      icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Color/Block.png',
      proxies: [
        '🔘 DIRECT',
        '⛔️ REJECT',
        '📛 REJECT-DROP',
      ],
    },
    {
      name: '🔘 DIRECT',
      type: 'select',
      icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Color/Direct.png',
      hidden: true,
      proxies: [
        'DIRECT',
      ],
    },
    {
      name: '⛔️ REJECT',
      type: 'select',
      icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Color/Reject.png',
      hidden: true,
      proxies: [
        'REJECT',
      ],
    },
    {
      name: '📛 REJECT-DROP',
      type: 'select',
      icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Color/Reject.png',
      hidden: true,
      proxies: [
        'REJECT-DROP',
      ],
    },
    {
      name: '🇺🇳 Server',
      type: 'select',
      icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Color/Club.png',
    },
    {
      name: '🇭🇰 Hong Kong',
      type: 'select',
      icon: 'https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Hong_Kong.png',
    },
    {
      name: '🇨🇳 Taiwan',
      type: 'select',
      icon: 'https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Taiwan.png',
    },
    {
      name: '🇸🇬 Singapore',
      type: 'select',
      icon: 'https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Singapore.png',
    },
    {
      name: '🇯🇵 Japan',
      type: 'select',
      icon: 'https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Japan.png',
    },
    {
      name: '🇺🇸 America',
      type: 'select',
      icon: 'https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/United_States.png',
    },
  ];

  // 节点池分组（对应 Sample.yaml 的 use:[Server]+filter）：手动按正则过滤
  // config.proxies 并保持原始顺序，不用 mihomo 的 include-all —— 它对候选
  // 节点做隐式字母序排序（mihomo config/config.go: slices.Sort(AllProxies)），
  // 无条件执行、无开关可关闭，会打乱订阅原始顺序。
  // 已有静态 proxies（如 📧 Mail 原有的 🔰 Proxy/🔘 DIRECT）会保留在前面，
  // 过滤/全量结果追加在后面，而不是整体覆盖。
  const allProxyNames = config.proxies.map((p) => p.name);
  const poolGroupFilters = {
    '🇺🇳 Server': null,
    '🇭🇰 Hong Kong': '🇭🇰|HK|Hong Kong|香港',
    '🇨🇳 Taiwan': '🇨🇳|🇹🇼|TW|Taiwan|台湾',
    '🇸🇬 Singapore': '🇸🇬|SG|Singapore|新加坡',
    '🇯🇵 Japan': '🇯🇵|JP|Japan|日本',
    '🇺🇸 America': '🇺🇸|US|United States|美国',
  };
  for (const g of proxyGroups) {
    if (!(g.name in poolGroupFilters)) continue;
    const filter = poolGroupFilters[g.name];
    const matched = filter ? allProxyNames.filter((n) => new RegExp(filter).test(n)) : allProxyNames;
    const base = Array.isArray(g.proxies) ? g.proxies : [];
    const merged = [...base, ...matched];
    g.proxies = merged.length > 0 ? merged : ['COMPATIBLE'];
  }

  const ruleProviders = {
    Bypass: {
      type: 'http',
      behavior: 'classical',
      path: './Provider/RuleSet/Bypass.yaml',
      url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Bypass.yaml',
      interval: 86400,
    },
    Reroute: {
      type: 'http',
      behavior: 'classical',
      path: './Provider/RuleSet/Reroute.yaml',
      url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Reroute.yaml',
      interval: 86400,
    },
    Private: {
      type: 'http',
      behavior: 'domain',
      path: './Provider/RuleSet/Private.yaml',
      url: 'https://fastly.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/private.txt',
      interval: 86400,
    },
    HTTPDNS: {
      type: 'http',
      behavior: 'classical',
      path: './Provider/RuleSet/HTTPDNS.yaml',
      url: 'https://fastly.jsdelivr.net/gh/VirgilClyne/GetSomeFries@main/ruleset/HTTPDNS.Block.yaml',
      interval: 86400,
    },
    Reject: {
      type: 'http',
      behavior: 'domain',
      path: './Provider/RuleSet/Reject.yaml',
      url: 'https://fastly.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/reject.txt',
      interval: 86400,
    },
    AdBlock: {
      type: 'http',
      behavior: 'classical',
      path: './Provider/RuleSet/AdBlock.yaml',
      url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Block.yaml',
      interval: 86400,
    },
    Streaming_TW: {
      type: 'http',
      behavior: 'classical',
      path: './Provider/RuleSet/Streaming_TW.yaml',
      url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Streaming_TW.yaml',
      interval: 86400,
    },
    Streaming_JP: {
      type: 'http',
      behavior: 'classical',
      path: './Provider/RuleSet/Streaming_JP.yaml',
      url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Streaming_JP.yaml',
      interval: 86400,
    },
    Streaming_US: {
      type: 'http',
      behavior: 'classical',
      path: './Provider/RuleSet/Streaming_US.yaml',
      url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Streaming_US.yaml',
      interval: 86400,
    },
    Streaming: {
      type: 'http',
      behavior: 'classical',
      path: './Provider/RuleSet/Streaming.yaml',
      url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Streaming.yaml',
      interval: 86400,
    },
    CNTV: {
      type: 'http',
      behavior: 'classical',
      path: './Provider/RuleSet/CNTV.yaml',
      url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/CNTV.yaml',
      interval: 86400,
    },
    'Google AI Studio': {
      type: 'http',
      behavior: 'classical',
      path: './Provider/RuleSet/Google_AI_Studio.yaml',
      url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Gemini.yaml',
      interval: 86400,
    },
    AIGC: {
      type: 'http',
      behavior: 'classical',
      path: './Provider/RuleSet/AIGC.yaml',
      url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/GenAI.yaml',
      interval: 86400,
    },
    'Apple CN': {
      type: 'http',
      behavior: 'classical',
      path: './Provider/RuleSet/Apple_CN.yaml',
      url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Apple%20CN.yaml',
      interval: 86400,
    },
    Apple: {
      type: 'http',
      behavior: 'classical',
      path: './Provider/RuleSet/Apple.yaml',
      url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Apple.yaml',
      interval: 86400,
    },
    Google: {
      type: 'http',
      behavior: 'classical',
      path: './Provider/RuleSet/Google.yaml',
      url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Google.yaml',
      interval: 86400,
    },
    OneDrive: {
      type: 'http',
      behavior: 'classical',
      path: './Provider/RuleSet/OneDrive.yaml',
      url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/OneDrive.yaml',
      interval: 86400,
    },
    Microsoft: {
      type: 'http',
      behavior: 'classical',
      path: './Provider/RuleSet/Microsoft.yaml',
      url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Microsoft.yaml',
      interval: 86400,
    },
    Telegram: {
      type: 'http',
      behavior: 'classical',
      path: './Provider/RuleSet/Telegram.yaml',
      url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Telegram.yaml',
      interval: 86400,
    },
    Crypto: {
      type: 'http',
      behavior: 'classical',
      path: './Provider/RuleSet/Crypto.yaml',
      url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Crypto.yaml',
      interval: 86400,
    },
    Finance: {
      type: 'http',
      behavior: 'classical',
      path: './Provider/RuleSet/Finance.yaml',
      url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Finance.yaml',
      interval: 86400,
    },
    Spark: {
      type: 'http',
      behavior: 'classical',
      path: './Provider/RuleSet/Spark.yaml',
      url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Spark.yaml',
      interval: 86400,
    },
    Global: {
      type: 'http',
      behavior: 'domain',
      path: './Provider/RuleSet/Global.yaml',
      url: 'https://fastly.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/proxy.txt',
      interval: 86400,
    },
    China: {
      type: 'http',
      behavior: 'domain',
      path: './Provider/RuleSet/China.yaml',
      url: 'https://fastly.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/direct.txt',
      interval: 86400,
    },
    CNASN: {
      type: 'http',
      behavior: 'classical',
      path: './Provider/RuleSet/CNASN.yaml',
      url: 'https://fastly.jsdelivr.net/gh/VirgilClyne/GetSomeFries@main/ruleset/ASN.China.yaml',
      interval: 86400,
    },
    CNCIDR: {
      type: 'http',
      behavior: 'ipcidr',
      path: './Provider/RuleSet/CNCIDR.yaml',
      url: 'https://fastly.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/cncidr.txt',
      interval: 86400,
    },
    LAN: {
      type: 'http',
      behavior: 'ipcidr',
      path: './Provider/RuleSet/LANCIDR.yaml',
      url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/lancidr.txt',
      interval: 86400,
    },
  };

  const rules = [
    'AND,((DST-PORT,22),(NETWORK,TCP)),🔘 DIRECT',
    'AND,((NETWORK,UDP),(DST-PORT,443),(NOT,((OR,((GEOSITE,cn),(GEOIP,CN)))))),📛 REJECT-DROP',
    'RULE-SET,Bypass,🔘 DIRECT',
    'RULE-SET,Reroute,🔰 Proxy',
    'RULE-SET,Private,🔘 DIRECT',
    'RULE-SET,HTTPDNS,🚧 AdGuard',
    'RULE-SET,Reject,🚧 AdGuard',
    'RULE-SET,AdBlock,🚧 AdGuard',
    'RULE-SET,Streaming_TW,🇨🇳 Taiwan',
    'RULE-SET,Streaming_JP,🇯🇵 Japan',
    'RULE-SET,Streaming_US,🇺🇸 America',
    'RULE-SET,Streaming,🎬 Streaming',
    'RULE-SET,CNTV,📺 CNTV',
    'RULE-SET,Google AI Studio,🔍 Google',
    'RULE-SET,AIGC,🤖 AIGC',
    'RULE-SET,Apple CN,🔘 DIRECT',
    'RULE-SET,Apple,🍎 Apple',
    'RULE-SET,Google,🔍 Google',
    'RULE-SET,OneDrive,☁️ OneDrive',
    'RULE-SET,Microsoft,Ⓜ️ Microsoft',
    'RULE-SET,Telegram,📬 Telegram',
    'RULE-SET,Crypto,🪙 Crypto',
    'RULE-SET,Finance,💳 Finance',
    'RULE-SET,Spark,📧 Mail',
    'RULE-SET,Global,🔰 Proxy',
    'RULE-SET,China,🔘 DIRECT',
    'RULE-SET,CNASN,🔘 DIRECT',
    'RULE-SET,CNCIDR,🔘 DIRECT',
    'RULE-SET,LAN,🔘 DIRECT',
    'GEOSITE,cn,🔘 DIRECT',
    'GEOIP,CN,🔘 DIRECT,no-resolve',
    'GEOSITE,geolocation-!cn,🔰 Proxy',
    'MATCH,🔰 Proxy',
  ];

  const disabledGroups = new Set(
    Object.keys(ruleOptionsEnable).filter((name) => !ruleOptionsEnable[name]),
  );

  // 移除被关闭的组，并从其余组的候选列表中剔除对已删组的引用，
  // 避免任何组指向不存在的策略导致 mihomo 启动失败。
  config['proxy-groups'] = proxyGroups
    .filter((g) => !disabledGroups.has(g.name))
    .map((g) =>
      Array.isArray(g.proxies)
        ? { ...g, proxies: g.proxies.filter((p) => !disabledGroups.has(p)) }
        : g,
    );

  const enabledRules = rules.filter((r) => {
    const parts = r.split(',');
    return !(parts[0] === 'RULE-SET' && parts.length >= 3 && disabledGroups.has(parts[2]));
  });

  const usedProviders = new Set();
  for (const r of enabledRules) {
    const parts = r.split(',');
    if (parts[0] === 'RULE-SET' && parts.length >= 2) usedProviders.add(parts[1]);
  }
  config['rule-providers'] = Object.fromEntries(
    Object.entries(ruleProviders).filter(([name]) => usedProviders.has(name)),
  );

  config['rules'] = enabledRules;

  return config;
}
