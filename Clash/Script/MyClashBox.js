/**
 * mihomo 覆写脚本（Enhance Script）· HotKids/Rules
 *
 * 用途：在 Clash Verge 等支持「覆写脚本」的 mihomo 客户端里，对任意订阅
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
  Streaming: true,
  CNTV: true,
  Apple: true,
  Google: true,
  OneDrive: false,
  Microsoft: false,
  Telegram: true,
  AIGC: true,
  Crypto: true,
  Finance: true,
  Mail: true,
  AdGuard: true,
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
  config['geox-url'] = { geoip: 'https://fastly.jsdelivr.net/gh/Loyalsoldier/v2ray-rules-dat@release/geoip.dat', geosite: 'https://fastly.jsdelivr.net/gh/Loyalsoldier/v2ray-rules-dat@release/geosite.dat', mmdb: 'https://fastly.jsdelivr.net/gh/Loyalsoldier/geoip@release/Country.mmdb', asn: 'https://fastly.jsdelivr.net/gh/Loyalsoldier/geoip@release/GeoLite2-ASN.mmdb' };
  config['hosts'] = { '*.clash.dev': '127.0.0.1', localhost: '127.0.0.1' };
  config['profile'] = { 'store-selected': true, 'store-fake-ip': true };
  config['ntp'] = { enable: true, 'write-to-system': false, server: 'ntp.aliyun.com', port: 123, interval: 60 };
  config['sniffer'] = { enable: true, 'override-destination': false, 'force-dns-mapping': true, 'parse-pure-ip': false, sniff: { HTTP: { ports: [80, '8080-8880'], 'override-destination': true }, TLS: { ports: [443, 8443] }, QUIC: { ports: [443, 8443] } }, 'skip-domain': ['+.push.apple.com', 'Mijia Cloud'] };
  config['dns'] = { enable: true, listen: '0.0.0.0:1053', ipv6: false, 'use-system-hosts': true, 'cache-algorithm': 'arc', 'prefer-h3': false, 'respect-rules': false, 'default-nameserver': ['223.5.5.5', '119.29.29.29'], 'enhanced-mode': 'fake-ip', 'fake-ip-range': '198.18.0.1/16', 'fake-ip-range6': '', 'fake-ip-ttl': 1, 'fake-ip-filter-mode': 'blacklist', 'fake-ip-filter': ['*.lan', '+.lan', '*.local', '*.localdomain', '*.home.arpa', '*.localhost', 'WORKGROUP', 'time.*.com', 'time.*.gov', 'time.*.apple.com', 'ntp.*.com', '+.pool.ntp.org', '*.ntp.org.cn', '+.stun.*', '*.stun.*.*', '*.turn.twilio.com', '*.stun.twilio.com', 'stun.syncthing.net', '*.srv.nintendo.net', 'xbox.*.microsoft.com', 'xbox.*.*.microsoft.com', '*.xboxlive.com', '*.cm.steampowered.com', '*.steamcontent.com', '*.battlenet.com.cn', '*.battlenet.com', '*.blzstatic.cn', '*.battle.net', '*.msftncsi.com', '*.msftconnecttest.com', 'connectivitycheck.gstatic.com', 'connectivitycheck.android.com', 'connectivitycheck.platform.hicloud.com', 'connect.rom.miui.com', 'captive.apple.com', 'network-test.debian.org', 'detectportal.firefox.com', 'lens.l.google.com', '+.push.apple.com', '+.market.xiaomi.com', '*.tailscale.com', '*.zerotier.com', '*.spotify.com', '+.music.126.net', '*.mcdn.bilivideo.cn', 'localhost.*.qq.com'], nameserver: ['https://8.8.8.8/dns-query#proxy&disable-ipv6=true&ecs=114.114.114.114/24&ecs-override=true'], fallback: ['https://1.1.1.1/dns-query#proxy'], 'fallback-filter': { geoip: true, 'geoip-code': 'CN', ipcidr: ['240.0.0.0/4'] }, 'proxy-server-nameserver': ['https://doh.pub/dns-query'], 'direct-nameserver': ['https://doh.pub/dns-query'], 'direct-nameserver-follow-policy': false };
  config['tun'] = { enable: true, stack: 'mixed', 'dns-hijack': ['any:53'], 'auto-route': true, 'auto-detect-interface': true, 'auto-redirect': true, gso: true, 'gso-max-size': 65536, 'strict-route': true, 'endpoint-independent-nat': true, 'disable-icmp-forwarding': true };
  // 合并前面采集的机场私有 DNS / 节点域名 hosts（本仓库条目优先，私有条目垫后）
  if (privateProxyNs.length > 0) {
    config.dns['proxy-server-nameserver'] = [...(config.dns['proxy-server-nameserver'] || []), ...privateProxyNs];
  }
  if (Object.keys(privateNsPolicy).length > 0) {
    config.dns['proxy-server-nameserver-policy'] = privateNsPolicy;
  }
  Object.assign(config.hosts, proxyHosts);

  const proxyGroups = [
    { name: 'Proxy', type: 'select', icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Liquid%20Glass/Shield.png', proxies: ['Hong Kong', 'Taiwan', 'Singapore', 'Japan', 'America', 'England', 'Germany', 'Server', 'Direct'] },
    { name: 'Streaming', type: 'select', icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Liquid%20Glass/Video.png', proxies: ['Proxy', 'Hong Kong', 'Taiwan', 'Singapore', 'Japan', 'America', 'England', 'Germany', 'Server'] },
    { name: 'CNTV', type: 'select', icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Liquid%20Glass/TV.png', proxies: ['Direct', 'Taiwan', 'Hong Kong'] },
    { name: 'Apple', type: 'select', icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Liquid%20Glass/Bitten%20Apple.png', proxies: ['Direct', 'Proxy', 'America', 'Japan'] },
    { name: 'Google', type: 'select', icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Liquid%20Glass/Google.png', proxies: ['America', 'Proxy'] },
    { name: 'OneDrive', type: 'select', icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Liquid%20Glass/OneDrive.png', proxies: ['Direct', 'Proxy'] },
    { name: 'Microsoft', type: 'select', icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Liquid%20Glass/Windows.png', proxies: ['Direct', 'Proxy'] },
    { name: 'Telegram', type: 'select', icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Liquid%20Glass/Telegram.png', proxies: ['Proxy', 'Singapore', 'Direct'] },
    { name: 'AIGC', type: 'select', icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Liquid%20Glass/Bot.png', proxies: ['America', 'Singapore', 'Proxy'] },
    { name: 'Crypto', type: 'select', icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Liquid%20Glass/Bitcoin.png', proxies: ['Germany', 'America', 'Proxy', 'Direct'] },
    { name: 'Finance', type: 'select', icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Liquid%20Glass/Wallet.png', proxies: ['America', 'Germany', 'Proxy', 'Direct'] },
    { name: 'Mail', type: 'select', icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Liquid%20Glass/Email.png', proxies: ['Proxy', 'Direct'] },
    { name: 'AdGuard', type: 'select', icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Liquid%20Glass/AdBlock.png', proxies: ['Direct', 'Reject'] },
    { name: 'Direct', type: 'select', icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Liquid%20Glass/Direct.png', hidden: true, proxies: ['DIRECT'] },
    { name: 'Reject', type: 'select', icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Liquid%20Glass/Reject.png', hidden: true, proxies: ['REJECT'] },
    { name: '🇸🇱 Relay', type: 'url-test', tolerance: 50, icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Liquid%20Glass/Protect.png', hidden: true },
    { name: '🇭🇰 HK Relay', type: 'fallback', icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Liquid%20Glass/Protect.png', hidden: true },
    { name: '🇨🇳 TW Relay', type: 'fallback', icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Liquid%20Glass/Protect.png', hidden: true },
    { name: '🇯🇵 JP Relay', type: 'fallback', icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Liquid%20Glass/Protect.png', hidden: true },
    { name: '🇺🇸 US Relay', type: 'fallback', icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Liquid%20Glass/Protect.png', hidden: true },
    { name: 'Server', type: 'select', icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Liquid%20Glass/Global.png' },
    { name: 'Hong Kong', type: 'fallback', icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Flags/HK.png', hidden: true },
    { name: 'Taiwan', type: 'fallback', icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Flags/TW.png', hidden: true },
    { name: 'Singapore', type: 'fallback', icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Flags/SG.png', hidden: true },
    { name: 'Japan', type: 'fallback', icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Flags/JP.png', hidden: true },
    { name: 'America', type: 'fallback', icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Flags/US.png', hidden: true },
    { name: 'England', type: 'fallback', icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Flags/UK.png', hidden: true },
    { name: 'Germany', type: 'fallback', icon: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Quantumult/X/Images/Flags/DE.png', hidden: true },
  ];

  // 节点池分组（对应 Mihomo.yaml 的 <<: *Region + filter）：手动按正则过滤
  // config.proxies 并保持原始顺序，不用 mihomo 的 include-all —— 它对候选
  // 节点做隐式字母序排序（mihomo config/config.go: slices.Sort(AllProxies)），
  // 无条件执行、无开关可关闭，会打乱订阅原始顺序。
  // 已有静态 proxies（如 📧 Mail 原有的 🔰 Proxy/🔘 DIRECT）会保留在前面，
  // 过滤/全量结果追加在后面，而不是整体覆盖。
  const allProxyNames = config.proxies.map((p) => p.name);
  const poolGroupFilters = {
    Mail: null,
    '🇸🇱 Relay': '(?i)^(?=.*(?:GoMaMi|Neburst|Pro))',
    '🇭🇰 HK Relay': '(?i)^(?=.*\\b(?:HK|HKG)\\d*\\b)(?=.*(?:GoMaMi|Pro))',
    '🇨🇳 TW Relay': '(?i)^(?=.*\\b(?:TW|TWN)\\d*\\b)(?=.*Neburst)',
    '🇯🇵 JP Relay': '(?i)^(?=.*\\b(?:JP|JPN)\\d*\\b)(?=.*Pro)',
    '🇺🇸 US Relay': '(?i)^(?=.*\\b(?:US|USA)\\d*\\b)(?=.*(?:GoMaMi|Pro))',
    Server: null,
    'Hong Kong': '(?i)^(?=.*\\b(?:HK|HKG)\\d*\\b)(?!.*GoMaMi)(?!.*Pro)',
    Taiwan: '(?i)^(?=.*\\b(?:TW|TWN)\\d*\\b)(?!.*Neburst)(?!.*Pro)',
    Singapore: '(?i)^(?=.*\\b(?:SG|SGP)\\d*\\b)(?!.*Neburst)(?!.*Pro)',
    Japan: '(?i)^(?=.*\\b(?:JP|JPN)\\d*\\b)(?!.*Pro)',
    America: '(?i)^(?=.*\\b(?:US|USA)\\d*\\b)(?!.*GoMaMi)(?!.*Pro)',
    England: '(?i)^(?=.*\\b(?:UK|GBR)\\d*\\b)',
    Germany: '(?i)^(?=.*\\b(?:DE|DEU)\\d*\\b)',
  };
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
    g.proxies = merged.length > 0 ? merged : ['COMPATIBLE'];
  }

  // 远程规则集公共参数（对应 Mihomo.yaml 的 &Remote 锚点），各条目以 ...spread 复用
  const remoteRuleProvider = { type: 'http', interval: 86400 };
  const ruleProviders = {
    Bypass: { ...remoteRuleProvider, behavior: 'classical', path: './Provider/RuleSet/Bypass.yaml', url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Bypass.yaml' },
    Reroute: { ...remoteRuleProvider, behavior: 'classical', path: './Provider/RuleSet/Reroute.yaml', url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Reroute.yaml' },
    Private: { ...remoteRuleProvider, behavior: 'domain', path: './Provider/RuleSet/Private.yaml', url: 'https://fastly.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/private.txt' },
    HTTPDNS: { ...remoteRuleProvider, behavior: 'classical', path: './Provider/RuleSet/HTTPDNS.yaml', url: 'https://fastly.jsdelivr.net/gh/VirgilClyne/GetSomeFries@main/ruleset/HTTPDNS.Block.yaml' },
    Reject: { ...remoteRuleProvider, behavior: 'domain', path: './Provider/RuleSet/Reject.yaml', url: 'https://fastly.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/reject.txt' },
    AdBlock: { ...remoteRuleProvider, behavior: 'classical', path: './Provider/RuleSet/AdBlock.yaml', url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Block.yaml' },
    Streaming_TW: { ...remoteRuleProvider, behavior: 'classical', path: './Provider/RuleSet/Streaming_TW.yaml', url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Streaming_TW.yaml' },
    Streaming_JP: { ...remoteRuleProvider, behavior: 'classical', path: './Provider/RuleSet/Streaming_JP.yaml', url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Streaming_JP.yaml' },
    Streaming_US: { ...remoteRuleProvider, behavior: 'classical', path: './Provider/RuleSet/Streaming_US.yaml', url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Streaming_US.yaml' },
    Streaming: { ...remoteRuleProvider, behavior: 'classical', path: './Provider/RuleSet/Streaming.yaml', url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Streaming.yaml' },
    CNTV: { ...remoteRuleProvider, behavior: 'classical', path: './Provider/RuleSet/CNTV.yaml', url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/CNTV.yaml' },
    'Google AI Studio': { ...remoteRuleProvider, behavior: 'classical', path: './Provider/RuleSet/Google_AI_Studio.yaml', url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Gemini.yaml' },
    AIGC: { ...remoteRuleProvider, behavior: 'classical', path: './Provider/RuleSet/AIGC.yaml', url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/GenAI.yaml' },
    'Apple CN': { ...remoteRuleProvider, behavior: 'classical', path: './Provider/RuleSet/Apple_CN.yaml', url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Apple%20CN.yaml' },
    Apple: { ...remoteRuleProvider, behavior: 'classical', path: './Provider/RuleSet/Apple.yaml', url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Apple.yaml' },
    Google: { ...remoteRuleProvider, behavior: 'classical', path: './Provider/RuleSet/Google.yaml', url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Google.yaml' },
    OneDrive: { ...remoteRuleProvider, behavior: 'classical', path: './Provider/RuleSet/OneDrive.yaml', url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/OneDrive.yaml' },
    Microsoft: { ...remoteRuleProvider, behavior: 'classical', path: './Provider/RuleSet/Microsoft.yaml', url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Microsoft.yaml' },
    Telegram: { ...remoteRuleProvider, behavior: 'classical', path: './Provider/RuleSet/Telegram.yaml', url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Telegram.yaml' },
    Crypto: { ...remoteRuleProvider, behavior: 'classical', path: './Provider/RuleSet/Crypto.yaml', url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Crypto.yaml' },
    Finance: { ...remoteRuleProvider, behavior: 'classical', path: './Provider/RuleSet/Finance.yaml', url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Finance.yaml' },
    Spark: { ...remoteRuleProvider, behavior: 'classical', path: './Provider/RuleSet/Spark.yaml', url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/Spark.yaml' },
    Global: { ...remoteRuleProvider, behavior: 'domain', path: './Provider/RuleSet/Global.yaml', url: 'https://fastly.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/proxy.txt' },
    China: { ...remoteRuleProvider, behavior: 'domain', path: './Provider/RuleSet/China.yaml', url: 'https://fastly.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/direct.txt' },
    CNASN: { ...remoteRuleProvider, behavior: 'classical', path: './Provider/RuleSet/CNASN.yaml', url: 'https://fastly.jsdelivr.net/gh/VirgilClyne/GetSomeFries@main/ruleset/ASN.China.yaml' },
    CNCIDR: { ...remoteRuleProvider, behavior: 'ipcidr', path: './Provider/RuleSet/CNCIDR.yaml', url: 'https://fastly.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/cncidr.txt' },
    LAN: { ...remoteRuleProvider, behavior: 'ipcidr', path: './Provider/RuleSet/LANCIDR.yaml', url: 'https://fastly.jsdelivr.net/gh/HotKids/Rules@master/Clash/RuleSet/lancidr.txt' },
  };

  const rules = [
    'AND,((NETWORK,UDP),(DST-PORT,443),(NOT,((OR,((GEOSITE,cn),(GEOIP,CN)))))),Reject',
    'AND,((DST-PORT,22),(NETWORK,TCP)),Direct',
    'RULE-SET,Bypass,Direct',
    'RULE-SET,Reroute,Proxy',
    'RULE-SET,Private,Direct',
    'RULE-SET,HTTPDNS,AdGuard',
    'RULE-SET,Reject,AdGuard',
    'RULE-SET,AdBlock,AdGuard',
    'RULE-SET,Streaming_TW,Taiwan',
    'RULE-SET,Streaming_JP,Japan',
    'RULE-SET,Streaming_US,America',
    'RULE-SET,Streaming,Streaming',
    'RULE-SET,CNTV,CNTV',
    'RULE-SET,Google AI Studio,Google',
    'RULE-SET,AIGC,AIGC',
    'RULE-SET,Apple CN,Direct',
    'RULE-SET,Apple,Apple',
    'RULE-SET,Google,Google',
    'RULE-SET,OneDrive,OneDrive',
    'RULE-SET,Microsoft,Microsoft',
    'RULE-SET,Telegram,Telegram',
    'RULE-SET,Crypto,Crypto',
    'RULE-SET,Finance,Finance',
    'RULE-SET,Spark,Mail',
    'RULE-SET,Global,Proxy',
    'RULE-SET,China,Direct',
    'RULE-SET,CNASN,Direct',
    'RULE-SET,CNCIDR,Direct',
    'RULE-SET,LAN,Direct',
    'GEOSITE,cn,Direct',
    'GEOIP,CN,Direct,no-resolve',
    'GEOSITE,geolocation-!cn,Proxy',
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
