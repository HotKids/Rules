/**
 * mihomo 覆写脚本（Enhance Script）· HotKids/Rules
 *
 * 用途：在 Clash Verge Rev / FlClash / Bettbox 等支持「覆写脚本」的 mihomo 客户端里，对任意订阅
 * （如 https://sub.hotkids.me）动态套用与本仓库 Surge/Profile.conf 等效的
 * 策略组、分流规则与基础设置，不必依赖机场自带配置。
 *
 * 自动生成，请勿手改：由 sync-config.py 从 Surge/Profile.conf（经
 * Clash/Mihomo.yaml）叠加 sync-config/Enhanced/clashbox.overlay.json（私人差异声明）
 * 而来，直接改本文件会在下次同步时被覆盖。公共部分请改 Surge/Profile.conf；
 * 私人差异（改名 / 换图标 / 额外分组 / 分组类型 / 候选节点 / 默认开关等）
 * 请改 clashbox.overlay.json。
 *
 * 本地唯一可临时修改的是下方 ruleOptionsEnable 的取值，用于按需开关某个分组。
 *
 * 仓库：https://github.com/HotKids/Rules
 */

// 分流分组开关：true 启用 / false 关闭对应分组（连同其专属 rules /
// rule-providers 一并裁剪，无需改动 Profile.conf）。默认值见下方——
// 大多默认启用，个别按需默认关闭的直接标成 false，本地可随时改回 true。
const ruleOptionsEnable = {
  'Streaming': true,
  'CNTV': true,
  'Apple': true,
  'Google': true,
  'OneDrive': false,
  'Microsoft': false,
  'Telegram': true,
  'AIGC': true,
  'Crypto': true,
  'Finance': true,
  'Mail': true,
  'Speedtest': false,
  'AdGuard': true,
};

function main(config) {
  // 空列表，或全部为 direct/reject 型占位节点（部分订阅模板会注入），都视为无有效节点
  const inputProxies = Array.isArray(config.proxies) ? config.proxies : [];
  const hasRealProxy = inputProxies.some((p) => !['direct', 'reject'].includes(String(p.type || '').toLowerCase()));
  if (!hasRealProxy) {
    throw new Error('未找到任何代理节点，请先绑定含有效节点的订阅（如 https://sub.hotkids.me）再启用本脚本');
  }

  // —— 保留机场私有 DNS / 节点域名 hosts ——
  // 部分机场用私有 DNS 解析节点域名，或把节点域名解析写进订阅的 hosts /
  // proxy-server-nameserver；下方 dns/hosts 会被整块覆盖，先把这些私有条目
  // 采集出来（滤掉常见公共 DNS），覆盖后再合并回去，避免此类机场断连。
  const commonDnsRe = /(223\.5\.5\.5|223\.6\.6\.6|119\.29\.29\.29|1\.12\.12\.12|120\.53\.53\.53|114\.114\.114\.114|180\.76\.76\.76|1\.1\.1\.1|1\.0\.0\.1|8\.8\.8\.8|8\.8\.4\.4|94\.140\.14\.14|94\.140\.15\.15|127\.0\.0\.1|alidns|doh\.pub|dot\.pub|dnspod|dns\.baidu|dns\.google|cloudflare|adguard|system)/i;
  const origDns = config.dns || {};
  const privateProxyNs = (origDns['proxy-server-nameserver'] || []).filter((d) => !commonDnsRe.test(String(d)));
  const privateNsPolicy = {};
  for (const policy of [origDns['proxy-server-nameserver-policy'] || {}, origDns['nameserver-policy'] || {}]) {
    for (const [rule, dns] of Object.entries(policy)) {
      const list = Array.isArray(dns) ? dns : [dns];
      if (list.some((d) => commonDnsRe.test(String(d)))) continue;
      privateNsPolicy[rule] = dns;
    }
  }
  const proxyServerDomains = new Set(inputProxies.map((p) => String(p.server || '').toLowerCase()).filter(Boolean));
  const proxyHosts = {};
  for (const [host, v] of Object.entries(config.hosts || {})) {
    if (proxyServerDomains.has(host.toLowerCase())) proxyHosts[host] = v;
  }

  // ── 通用设置 ──
  // 混合代理端口（HTTP 和 SOCKS5 共用）
  config['mixed-port'] = 7892;
  // 允许局域网设备通过本机代理
  config['allow-lan'] = true;
  // 监听地址，'*' 表示所有网卡
  config['bind-address'] = '*';
  // 代理模式：rule（规则）/ global（全局）/ direct（直连）
  config['mode'] = 'rule';
  // 日志等级：silent / error / warning / info / debug
  config['log-level'] = 'info';
  // 关闭 IPv6：阻断所有 IPv6 连接并屏蔽 AAAA DNS 记录
  config['ipv6'] = false;
  // RESTful API 监听地址（供 Dashboard 及外部控制器使用）
  config['external-controller'] = '127.0.0.1:9090';

  // ── 性能设置 ──
  // 统一延迟：去除 TCP 握手耗时，使延迟测试结果更准确
  config['unified-delay'] = true;
  // TCP 并发：同时向所有解析 IP 发起连接，取最快握手
  config['tcp-concurrent'] = true;
  // 进程匹配模式：always 强制 / strict 自动（默认）/ off 不匹配（适合路由器）
  config['find-process-mode'] = 'strict';
  // GeoData 加载模式：standard 性能优先 / memconservative 低内存（适合路由器/嵌入式）
  config['geodata-loader'] = 'standard';
  // HTTP 请求 UA（显式声明，避免随版本漂移）
  config['global-ua'] = 'clash.meta';
  // TCP Keep-Alive 探测间隔（秒）
  config['keep-alive-interval'] = 30;

  // ── GeoData 设置 ──
  // 自动更新 GeoData 数据库
  config['geo-auto-update'] = true;
  // 更新间隔（小时）
  config['geo-update-interval'] = 24;
  // GeoData 数据库 URL
  config['geox-url'] = { geoip: 'https://fastly.jsdelivr.net/gh/Loyalsoldier/v2ray-rules-dat@release/geoip.dat', geosite: 'https://fastly.jsdelivr.net/gh/Loyalsoldier/v2ray-rules-dat@release/geosite.dat', mmdb: 'https://fastly.jsdelivr.net/gh/Loyalsoldier/geoip@release/Country.mmdb', asn: 'https://fastly.jsdelivr.net/gh/Loyalsoldier/geoip@release/GeoLite2-ASN.mmdb' };

  // ── Hosts ──
  // 静态域名映射，优先级高于 DNS 解析
  config['hosts'] = { localhost: '127.0.0.1' };

  // ── 配置持久化 ──
  // store-selected 记住策略组选择；store-fake-ip 持久化 fake-ip 映射（重启后 IP 不变）
  config['profile'] = { 'store-selected': true, 'store-fake-ip': true };

  // ── NTP 校时 ──
  // 内置 NTP：部分协议（如 VMess）对本机时间偏差敏感，校时失败会导致握手异常；
  // write-to-system=false 不写入系统时间，仅供内核内部使用
  config['ntp'] = { enable: true, 'write-to-system': false, server: 'ntp.aliyun.com', port: 123, interval: 60 };

  // ── 域名嗅探 ──
  // 嗅探结果仅用于规则匹配、不替换目标地址（fake-ip 下 override-destination=false，HTTP 单独覆盖为 true）；
  // force-dns-mapping=true 改善直连 IP 命中；parse-pure-ip=false 避免纯 IP 连接的大量 "may not have any sent data" 警告
  config['sniffer'] = { enable: true, 'override-destination': false, 'force-dns-mapping': true, 'parse-pure-ip': false, sniff: { HTTP: { ports: [80, '8080-8880'], 'override-destination': true }, TLS: { ports: [443, 8443] }, QUIC: { ports: [443, 8443] } }, 'skip-domain': ['+.push.apple.com', 'Mijia Cloud'] };

  // ── DNS ──
  // fake-ip（blacklist）：fake-ip-filter 内域名返回真实 IP，其余走 fake-ip；default-nameserver 仅解析上游域名（纯 IP）；
  // 主 DNS 经 #RULES 走代理拿干净结果，防境外域名泄露给国内 DNS；nameserver-policy 按声明顺序先窄后宽：
  // 内网域名交系统解析器、NTP 用裸 IP UDP（校时不依赖 TLS）、国内域名国内 DoH 就近解析；代理节点/DIRECT 域名同走国内 DoH
  config['dns'] = { enable: true, listen: '0.0.0.0:1053', ipv6: false, 'use-system-hosts': true, 'cache-algorithm': 'arc', 'prefer-h3': false, 'respect-rules': false, 'default-nameserver': ['223.5.5.5', '119.29.29.29'], 'enhanced-mode': 'fake-ip', 'fake-ip-range': '198.18.0.1/16', 'fake-ip-range6': '', 'fake-ip-ttl': 1, 'fake-ip-filter-mode': 'blacklist', 'fake-ip-filter': ['*.lan', '+.lan', '*.local', '*.localdomain', '*.home.arpa', '*.localhost', 'WORKGROUP', 'time.*.com', 'time.*.gov', 'time.*.apple.com', 'ntp.*.com', '+.pool.ntp.org', '*.ntp.org.cn', '+.stun.*', '*.stun.*.*', '*.turn.twilio.com', '*.stun.twilio.com', 'stun.syncthing.net', '*.srv.nintendo.net', 'xbox.*.microsoft.com', 'xbox.*.*.microsoft.com', '*.xboxlive.com', '*.cm.steampowered.com', '*.steamcontent.com', '*.battlenet.com.cn', '*.battlenet.com', '*.blzstatic.cn', '*.battle.net', '*.msftncsi.com', '*.msftconnecttest.com', 'connectivitycheck.gstatic.com', 'connectivitycheck.android.com', 'connectivitycheck.platform.hicloud.com', 'connect.rom.miui.com', 'captive.apple.com', 'network-test.debian.org', 'detectportal.firefox.com', 'lens.l.google.com', '+.push.apple.com', '+.market.xiaomi.com', '*.tailscale.com', '*.zerotier.com', '*.spotify.com', '+.music.126.net', '*.mcdn.bilivideo.cn', 'localhost.*.qq.com'], nameserver: ['https://1.1.1.1/dns-query#RULES'], 'nameserver-policy': { 'geosite:private': ['system'], 'time.*.com,time.*.gov,time.*.apple.com,ntp.*.com,+.pool.ntp.org,*.ntp.org.cn': ['223.5.5.5', '119.29.29.29'], 'geosite:cn': ['https://doh.pub/dns-query', 'https://dns.alidns.com/dns-query'] }, 'proxy-server-nameserver': ['https://doh.pub/dns-query', 'https://dns.alidns.com/dns-query'], 'direct-nameserver': ['https://doh.pub/dns-query', 'https://dns.alidns.com/dns-query'], 'direct-nameserver-follow-policy': false };

  // ── TUN ──
  // 接管系统全量流量；stack mixed（TCP 系统栈 + UDP gvisor，推荐）；dns-hijack 劫持 53 端口防绕过；
  // auto-route/auto-redirect 自动配路由与透明代理（仅 Linux）；strict-route 防 IP 泄漏；
  // EIM NAT 改善游戏/VOIP/WebRTC 打洞；disable-icmp-forwarding 关闭 ICMP 代答，让 ping 反映真实链路
  config['tun'] = { enable: true, stack: 'mixed', 'dns-hijack': ['any:53'], 'auto-route': true, 'auto-detect-interface': true, 'auto-redirect': true, gso: true, 'gso-max-size': 65536, 'strict-route': true, 'endpoint-independent-nat': true, 'disable-icmp-forwarding': true };

  // 合并前面采集的机场私有 DNS / 节点域名 hosts（本仓库条目优先，私有条目垫后）
  if (privateProxyNs.length > 0) {
    config.dns['proxy-server-nameserver'] = [...(config.dns['proxy-server-nameserver'] || []), ...privateProxyNs];
  }
  if (Object.keys(privateNsPolicy).length > 0) {
    config.dns['proxy-server-nameserver-policy'] = privateNsPolicy;
  }
  Object.assign(config.hosts, proxyHosts);

  // ── 节点 ──
  // 节点池筛选正则（对应 Mihomo.yaml 的 &Region / &Filter* 锚点）：
  // null = 不过滤、取全量节点；下方策略组生成后按此表运行时填充候选。
  const poolGroupFilters = {
    'Mail': null,
    'Speedtest': null,
    '🇸🇱 Relay': '(?i)^(?=.*(?:GoMaMi|Neburst|Pro))',
    '🇭🇰 HK Relay': '(?i)^(?=.*\\b(?:HK|HKG)\\d*\\b)(?=.*(?:GoMaMi|Pro))',
    '🇨🇳 TW Relay': '(?i)^(?=.*\\b(?:TW|TWN)\\d*\\b)(?=.*Neburst)',
    '🇯🇵 JP Relay': '(?i)^(?=.*\\b(?:JP|JPN)\\d*\\b)(?=.*Pro)',
    '🇺🇸 US Relay': '(?i)^(?=.*\\b(?:US|USA)\\d*\\b)(?=.*(?:GoMaMi|Pro))',
    'Server': null,
    'Hong Kong': '(?i)^(?=.*\\b(?:HK|HKG)\\d*\\b)(?!.*GoMaMi)(?!.*Pro)',
    'Taiwan': '(?i)^(?=.*\\b(?:TW|TWN)\\d*\\b)(?!.*Neburst)(?!.*Pro)',
    'Singapore': '(?i)^(?=.*\\b(?:SG|SGP)\\d*\\b)(?!.*Neburst)(?!.*Pro)',
    'Japan': '(?i)^(?=.*\\b(?:JP|JPN)\\d*\\b)(?!.*Pro)',
    'America': '(?i)^(?=.*\\b(?:US|USA)\\d*\\b)(?!.*GoMaMi)(?!.*Pro)',
    'England': '(?i)^(?=.*\\b(?:UK|GBR)\\d*\\b)',
    'Germany': '(?i)^(?=.*\\b(?:DE|DEU)\\d*\\b)',
  };

  // ── 策略组 ──
  const proxyGroups = [
    // Proxy
    { name: 'Proxy', type: 'select', proxies: ['Hong Kong', 'Taiwan', 'Singapore', 'Japan', 'America', 'England', 'Germany', 'Server', 'Direct'], icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Liquid%20Glass/Shield.png' },
    // Streaming Global
    { name: 'Streaming', type: 'select', proxies: ['Proxy', 'Hong Kong', 'Taiwan', 'Singapore', 'Japan', 'America', 'England', 'Germany', 'Server'], icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Liquid%20Glass/Video.png' },
    // CNTV APAC
    { name: 'CNTV', type: 'select', proxies: ['Direct', 'Taiwan', 'Hong Kong'], icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Liquid%20Glass/TV.png' },
    // Apple
    // > Apple Services
    { name: 'Apple', type: 'select', proxies: ['Direct', 'Proxy', 'America', 'Japan'], icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Liquid%20Glass/Bitten%20Apple.png' },
    // Google
    { name: 'Google', type: 'select', proxies: ['America', 'Proxy'], icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Liquid%20Glass/Google.png' },
    // Microsoft
    // > OneDrive
    { name: 'OneDrive', type: 'select', proxies: ['Direct', 'Proxy'], icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Liquid%20Glass/OneDrive.png' },
    // > Microsoft Services
    { name: 'Microsoft', type: 'select', proxies: ['Direct', 'Proxy'], icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Liquid%20Glass/Windows.png' },
    // Telegram
    { name: 'Telegram', type: 'select', proxies: ['Proxy', 'Singapore', 'Direct'], icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Liquid%20Glass/Telegram.png' },
    // AIGC
    { name: 'AIGC', type: 'select', proxies: ['America', 'Singapore', 'Proxy'], icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Liquid%20Glass/Bot.png' },
    // Crypto
    { name: 'Crypto', type: 'select', proxies: ['Germany', 'America', 'Proxy', 'Direct'], icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Liquid%20Glass/Bitcoin.png' },
    // Finance
    { name: 'Finance', type: 'select', proxies: ['America', 'Germany', 'Proxy', 'Direct'], icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Liquid%20Glass/Wallet.png' },
    // Mail
    { name: 'Mail', type: 'select', proxies: ['Proxy', 'Direct'], icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Liquid%20Glass/Email.png' },
    // Speedtest
    { name: 'Speedtest', type: 'select', icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Liquid%20Glass/Speed.png' },
    // Adblock
    { name: 'AdGuard', type: 'select', proxies: ['Direct', 'Reject'], icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Liquid%20Glass/AdBlock.png' },
    // DIRECT
    { name: 'Direct', type: 'select', proxies: ['DIRECT'], hidden: true, icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Liquid%20Glass/Direct.png' },
    // REJECT
    { name: 'Reject', type: 'select', proxies: ['REJECT'], hidden: true, icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Liquid%20Glass/Reject.png' },
    { name: '🇸🇱 Relay', type: 'url-test', hidden: true, tolerance: 50, icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Liquid%20Glass/Protect.png' },
    { name: '🇭🇰 HK Relay', type: 'fallback', hidden: true, icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Liquid%20Glass/Protect.png' },
    { name: '🇨🇳 TW Relay', type: 'fallback', hidden: true, icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Liquid%20Glass/Protect.png' },
    { name: '🇯🇵 JP Relay', type: 'fallback', hidden: true, icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Liquid%20Glass/Protect.png' },
    { name: '🇺🇸 US Relay', type: 'fallback', hidden: true, icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Liquid%20Glass/Protect.png' },
    // Nodes
    { name: 'Server', type: 'select', icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Liquid%20Glass/Global.png' },
    // Area
    { name: 'Hong Kong', type: 'fallback', hidden: true, icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Flags/HK.png' },
    { name: 'Taiwan', type: 'fallback', hidden: true, icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Flags/TW.png' },
    { name: 'Singapore', type: 'fallback', hidden: true, icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Flags/SG.png' },
    { name: 'Japan', type: 'fallback', hidden: true, icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Flags/JP.png' },
    { name: 'America', type: 'fallback', hidden: true, icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Flags/US.png' },
    { name: 'England', type: 'fallback', hidden: true, icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Flags/UK.png' },
    { name: 'Germany', type: 'fallback', hidden: true, icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Flags/DE.png' },
  ];

  // 节点池分组（对应 Mihomo.yaml 的 <<: *Region + filter）：按上方 poolGroupFilters
  // 手动过滤 config.proxies 并保持原始顺序，不用 mihomo 的 include-all —— 它对候选
  // 节点做隐式字母序排序（mihomo config/config.go: slices.Sort(AllProxies)），
  // 无条件执行、无开关可关闭，会打乱订阅原始顺序。
  // 已有静态 proxies（如 📧 Mail 原有的 🔰 Proxy/🔘 DIRECT）会保留在前面，
  // 过滤/全量结果追加在后面，而不是整体覆盖。
  const allProxyNames = inputProxies.map((p) => p.name);
  for (const g of proxyGroups) {
    if (!(g.name in poolGroupFilters)) continue;
    const filter = poolGroupFilters[g.name];
    // 过滤正则可能带内联标志（如 (?i)）；JS RegExp 不支持内联标志，
    // 需拆出标志作为第二参数传入（regexp2/ICU 等其他平台原样使用）。
    let re = null;
    if (filter) {
      const fm = filter.match(/^\(\?([a-z]+)\)([\s\S]*)$/);
      re = fm ? new RegExp(fm[2], fm[1]) : new RegExp(filter);
    }
    const matched = re ? allProxyNames.filter((n) => re.test(n)) : allProxyNames;
    const base = Array.isArray(g.proxies) ? g.proxies : [];
    const merged = [...base, ...matched];
    if (merged.length > 0) {
      g.proxies = merged;
    } else {
      g.proxies = ['COMPATIBLE'];
    }
  }

  // ── 规则集 ──
  // 关于 Rule Provider 请查阅：https://wiki.metacubex.one/en/config/rule-providers/
  // 远程规则集公共参数（对应 Mihomo.yaml 的 &Remote 锚点），各条目以 ...spread 复用
  const remoteRuleProvider = { type: 'http', interval: 86400 };
  const ruleProviders = {
    'Bypass': { ...remoteRuleProvider, behavior: 'classical', format: 'yaml', path: './Provider/RuleSet/Bypass.yaml', url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Bypass.yaml' },
    'Reroute': { ...remoteRuleProvider, behavior: 'classical', format: 'yaml', path: './Provider/RuleSet/Reroute.yaml', url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Reroute.yaml' },
    'Private': { ...remoteRuleProvider, behavior: 'domain', format: 'mrs', path: './Provider/RuleSet/Private.mrs', url: 'https://fastly.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@meta/geo/geosite/private.mrs' },
    'HTTPDNS': { ...remoteRuleProvider, behavior: 'classical', format: 'yaml', path: './Provider/RuleSet/HTTPDNS.yaml', url: 'https://fastly.jsdelivr.net/gh/VirgilClyne/GetSomeFries@main/ruleset/HTTPDNS.Block.yaml' },
    'Reject': { ...remoteRuleProvider, behavior: 'domain', format: 'mrs', path: './Provider/RuleSet/Reject.mrs', url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Reject.mrs' },
    'AdBlock': { ...remoteRuleProvider, behavior: 'classical', format: 'yaml', path: './Provider/RuleSet/AdBlock.yaml', url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Block.yaml' },
    'Phishing': { ...remoteRuleProvider, behavior: 'domain', format: 'mrs', path: './Provider/RuleSet/Phishing.mrs', url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Phishing.mrs' },
    'Bogus': { ...remoteRuleProvider, behavior: 'classical', format: 'yaml', path: './Provider/RuleSet/Bogus.yaml', url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Bogus.yaml' },
    'Streaming_TW': { ...remoteRuleProvider, behavior: 'classical', format: 'yaml', path: './Provider/RuleSet/Streaming_TW.yaml', url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Streaming_TW.yaml' },
    'Streaming_JP': { ...remoteRuleProvider, behavior: 'classical', format: 'yaml', path: './Provider/RuleSet/Streaming_JP.yaml', url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Streaming_JP.yaml' },
    'Streaming_US': { ...remoteRuleProvider, behavior: 'classical', format: 'yaml', path: './Provider/RuleSet/Streaming_US.yaml', url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Streaming_US.yaml' },
    'Streaming': { ...remoteRuleProvider, behavior: 'classical', format: 'yaml', path: './Provider/RuleSet/Streaming.yaml', url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Streaming.yaml' },
    'CNTV': { ...remoteRuleProvider, behavior: 'classical', format: 'yaml', path: './Provider/RuleSet/CNTV.yaml', url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/CNTV.yaml' },
    'Google AI Studio': { ...remoteRuleProvider, behavior: 'classical', format: 'yaml', path: './Provider/RuleSet/Google_AI_Studio.yaml', url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Gemini.yaml' },
    'AIGC': { ...remoteRuleProvider, behavior: 'classical', format: 'yaml', path: './Provider/RuleSet/AIGC.yaml', url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/GenAI.yaml' },
    'Apple CN': { ...remoteRuleProvider, behavior: 'classical', format: 'yaml', path: './Provider/RuleSet/Apple_CN.yaml', url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Apple%20CN.yaml' },
    'Apple': { ...remoteRuleProvider, behavior: 'classical', format: 'yaml', path: './Provider/RuleSet/Apple.yaml', url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Apple.yaml' },
    'Google': { ...remoteRuleProvider, behavior: 'classical', format: 'yaml', path: './Provider/RuleSet/Google.yaml', url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Google.yaml' },
    'OneDrive': { ...remoteRuleProvider, behavior: 'classical', format: 'yaml', path: './Provider/RuleSet/OneDrive.yaml', url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/OneDrive.yaml' },
    'Microsoft': { ...remoteRuleProvider, behavior: 'classical', format: 'yaml', path: './Provider/RuleSet/Microsoft.yaml', url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Microsoft.yaml' },
    'Telegram': { ...remoteRuleProvider, behavior: 'classical', format: 'yaml', path: './Provider/RuleSet/Telegram.yaml', url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Telegram.yaml' },
    'Crypto': { ...remoteRuleProvider, behavior: 'classical', format: 'yaml', path: './Provider/RuleSet/Crypto.yaml', url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Crypto.yaml' },
    'Finance': { ...remoteRuleProvider, behavior: 'classical', format: 'yaml', path: './Provider/RuleSet/Finance.yaml', url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Finance.yaml' },
    'Spark': { ...remoteRuleProvider, behavior: 'classical', format: 'yaml', path: './Provider/RuleSet/Spark.yaml', url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Spark.yaml' },
    'Speedtest': { ...remoteRuleProvider, behavior: 'domain', format: 'mrs', path: './Provider/RuleSet/Speedtest.mrs', url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Speedtest.mrs' },
    'Global': { ...remoteRuleProvider, behavior: 'domain', format: 'mrs', path: './Provider/RuleSet/Global.mrs', url: 'https://fastly.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@meta/geo/geosite/geolocation-!cn.mrs' },
    'China': { ...remoteRuleProvider, behavior: 'domain', format: 'mrs', path: './Provider/RuleSet/China.mrs', url: 'https://fastly.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@meta/geo/geosite/cn.mrs' },
    'CNASN': { ...remoteRuleProvider, behavior: 'classical', format: 'yaml', path: './Provider/RuleSet/CNASN.yaml', url: 'https://fastly.jsdelivr.net/gh/VirgilClyne/GetSomeFries@main/ruleset/ASN.China.yaml' },
    'CNCIDR': { ...remoteRuleProvider, behavior: 'ipcidr', format: 'mrs', path: './Provider/RuleSet/CNCIDR.mrs', url: 'https://fastly.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@meta/geo/geoip/cn.mrs' },
    'LAN': { ...remoteRuleProvider, behavior: 'ipcidr', format: 'mrs', path: './Provider/RuleSet/LAN.mrs', url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/lancidr.mrs' },
  };

  // ── 规则 ──
  const rules = [
    // 禁用国外 QUIC（UDP 443），强制回退 TCP；国内放行
    // 对应 Surge 的 PROTOCOL,QUIC 拦截（该规则转 Clash 无直接等价，借 mihomo 逻辑规则补齐）
    'AND,((NETWORK,UDP),(DST-PORT,443),(NOT,((OR,((GEOSITE,cn),(GEOIP,CN)))))),Reject',
    // 标准 SSH 端口
    'AND,((DST-PORT,22),(NETWORK,TCP)),Direct',
    // Unbreak 后续规则修正，修复因规则拦截或分流不当导致的功能异常
    'RULE-SET,Bypass,Direct',
    'RULE-SET,Reroute,Proxy',
    // Private 私有网络
    'RULE-SET,Private,Direct',
    // HTTPDNS 请求/流量阻止
    'RULE-SET,HTTPDNS,AdGuard',
    // Advertising 广告
    'RULE-SET,Reject,AdGuard',
    'RULE-SET,AdBlock,AdGuard',
    // Phishing 钓鱼网站
    'RULE-SET,Phishing,AdGuard',
    // Bogus IP NXDOMAIN 劫持/僵尸网络 C2
    'RULE-SET,Bogus,Reject,no-resolve',
    // Global Area Network
    // > Streaming by Region
    // >> Streaming TW
    'RULE-SET,Streaming_TW,Taiwan',
    // >> Streaming JP
    'RULE-SET,Streaming_JP,Japan',
    // >> Streaming US
    'RULE-SET,Streaming_US,America',
    // > Streaming
    'RULE-SET,Streaming,Streaming',
    // > CNTV（适用于 iQIYI Intl,WeTV,Bilibili 等大陆在港台东南亚提供服务的流媒体服务）
    'RULE-SET,CNTV,CNTV',
    // Global 全球代理规则
    // > AIGC
    'RULE-SET,Google AI Studio,Google',
    'RULE-SET,AIGC,AIGC',
    // > Apple
    // >> Apple Services
    'RULE-SET,Apple CN,Direct',
    'RULE-SET,Apple,Apple',
    // > Google
    'RULE-SET,Google,Google',
    // > Microsoft
    'RULE-SET,OneDrive,OneDrive',
    'RULE-SET,Microsoft,Microsoft',
    // > Telegram
    'RULE-SET,Telegram,Telegram',
    // > Crypto
    'RULE-SET,Crypto,Crypto',
    // > Finance
    'RULE-SET,Finance,Finance',
    // > Mail
    'RULE-SET,Spark,Mail',
    // > Speedtest
    'RULE-SET,Speedtest,Speedtest',
    // Global (DNS Cache Pollution) / (IP Blackhole) / (Region-Restricted Access Denied) / (Network Jitter)
    'RULE-SET,Global,Proxy',
    // China Area Network
    'RULE-SET,China,Direct',
    'RULE-SET,CNASN,Direct,no-resolve',
    'RULE-SET,CNCIDR,Direct,no-resolve',
    // Local Area Network
    'RULE-SET,LAN,Direct,no-resolve',
    // GeoIP
    'GEOSITE,cn,Direct',
    'GEOIP,CN,Direct,no-resolve',
    'GEOSITE,geolocation-!cn,Proxy',
    // Final
    'MATCH,Proxy',
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
