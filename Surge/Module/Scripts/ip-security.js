/**
 * IP 安全检测；Surge 汇总面板 / Stash 独立卡片或汇总。
 * @version 6.5.0 (2026-11-09)
 * @changelog (latest 3 versions)
 * - 6.5.0 (2026-11-09)
 *   新增简体、繁体和英文显示；自动地区来源随语言选择，保留自定义来源。
 *   统一面板、卡片及通知文案；繁体自动地名在显示层转换，内部状态与缓存保持原格式。
 *   整合 Stash 卡片、通知及日志适配；保留风险回退、未知结果重试和 Surge 本机 GeoIP 兜底。
 * @source https://github.com/HotKids/Rules/blob/master/Surge/Module/Scripts/ip-security.js
 * @reference https://github.com/StashNetworks/misc/tree/main/collapsed-tiles
 *            https://ip-api.com/docs/api:json
 * @author HotKids & ChatGPT & Claude
 *
 * 参数：
 * - lang：zh-Hans（默认）/ zh-Hant / en，控制显示文案及自动地区来源。
 * - local_geoapi：auto（默认）简体/繁体首选百度，英文首选 ip.sb；baidu / bilibili / ipsb 固定首选，失败尝试剩余来源。
 * - remote_geoapi：auto（默认）简体/繁体首选 ipapi-zh，英文首选 ipapi，入口使用相同首选；亦可指定 ipinfo / maxmind / maxmind-zh。
 *   出口依既有顺序回退，MaxMind 无凭据跳过；Stash 不使用 MaxMind，可额外选择 ippure。
 * - risk_api：ipqs / proxycheck / ippure / scamalytics 指定优先源；Surge 自动按上述顺序回退，缺 Key 跳过 IPQS。
 *   Stash 默认 IPPure，失败按 ProxyCheck → Scamalytics 回退，不使用 IPQS。
 * - ipqs_key：IPQualityScore API Key，仅 Surge，可选；maxmind_key：account_id:license_key，仅 Surge，可选。
 * - mask_ip：0 关闭（默认）/ 1 部分打码 / 2 全部隐藏。Stash 固定按参数显示，Surge 保留点击切换。
 * - tw_flag：cn / tw；未传参时 Surge 默认 cn、Stash 默认 tw，配套覆写显式传入 cn；不随显示语言改变。
 * - notify：网络变化通知，默认 true。Stash 卡片固定关闭，仅独立 monitor 定时任务开启。
 * - event_delay：Surge 网络变化后延迟秒数，默认 2；panel_interval：Surge 刷新间隔，默认 600，须与 Panel 保持一致。
 * - proxy：Stash 首页和通知可显式指定 URL 编码的策略；留空按当前分流，collapsed 不覆盖长按节点上下文。
 * - mode：home / collapsed；tile：summary / local / outbound / risk，Stash 选择首页或独立卡片。
 * - task：monitor 独立检查 IP 变化，logs 收集共享日志；log=shared 按任务暂存日志。
 * - stash_api / stash_api_url / stash_api_secret：Stash 本机控制接口，默认关闭，仅首页及通知使用，不接受第三方 API Key。
 *
 * 数据与兼容：
 * - 本地 IP 使用 bilibili DIRECT；Surge 出口使用 Cloudflare trace → ip.sb，Stash 使用 IPPure，缺 IPv4 时回退 ipify。
 * - 本地地区默认百度 → bilibili → ip.sb；出口中文 ip-api → 英文 ip-api → ipinfo → MaxMind，Stash 不含 MaxMind。
 *   auto 仅按语言调整首选；指定来源始终优先。出口运营商优先 ipinfo，地区与运营商每轮查询，不复用历史字段。
 * - Surge 风险及完整类型按出口 IP 缓存 24 小时；未知或错误不缓存，事件未完成时下次重试。
 *   类型使用 IPPure info → card → ProxyCheck；Stash 保留同一 IP 的有效评分与类型字段，失败不延长旧字段时间。
 * - Surge 从近期请求读取策略与入口，/v1/geoip 只补缺失的国家/ASN；Stash 不调用 Surge API。
 * - DNS 使用 edns.ip-api.com。Surge 保留既有地区提示；Stash 只显示解析器地区，不据此判断泄露。
 * - Stash 首页及三张折叠卡片共用回退和配色；iOS 折叠卡片保持单行，打码时隐藏可能含 IP 的 rDNS。
 * - Stash 通知基线独立于节点测试；首次仅记录，只有 IP 变化时发送通知，切换语言不触发通知。
 * - 繁体地名只在 auto 显示阶段转换；自定义来源的地名、策略及运营商原名保持原样。
 * - 风险分值、阈值、请求路线、IPv4/IPv6、缓存键与有效期均不随语言改变。
 */

// ==================== 全局配置 ====================
const isStash = (typeof $environment !== "undefined" &&
  (!!$environment["stash-version"] || !!$environment["stash-build"])) ||
  (typeof $script !== "undefined" && $script.type === "tile");
const stashSystem = typeof $environment !== "undefined" ? String($environment.system || "").trim().toLowerCase() : "";
const isStashiOS = isStash && (stashSystem === "ios" || stashSystem === "ipados");
const hasTimers = typeof setTimeout === "function";
// 图标统一由覆写提供；更新检测结果时保留卡片 Logo。
const stashTiles = {
  summary: { title: "IP 信息卡", color: "#9E9E9E" },
  risk: { title: "IP 纯净度", color: "#88A788" },
  dns: { title: "DNS 解析器", color: "#7357A6" },
  outbound: { title: "出口 IP", marker: "🅟", color: "#1565C0" },
  local: { title: "本地 IP", marker: "Ⓓ", color: "#00796B" }
};
const CONFIG = {
  VERSION: "6.5.0",
  timeout: isStash ? 20000 : 10000, // Surge 看门狗须小于 sgmodule 的 timeout=15；Stash 兼容无 JS 定时器的运行时
  riskCacheTTL: 86400, // 风险评分缓存有效期（秒）：出口 IP 未变化时，此时长内复用缓存，
                       // 避免面板自动刷新（update-interval，默认 600s）反复消耗 IPQS 等按次计费额度
  storeKeys: {
    lastEvent: "lastNetworkInfoEvent",
    lastPolicy: "lastProxyPolicy",
    riskCache: "riskScoreCache",
    ipTypeCache: "ipTypeCache",
    maskToggle: "ipMaskToggle",
    lastRun: "ipLastRunTime"
  },
  urls: {
    localIP: "https://api.bilibili.com/x/web-interface/zone",
    baiduGeo: (ip) => `https://opendata.baidu.com/api.php?query=${ip}&co=&resource_id=6006&oe=utf8`,
    maxmindGeo: (ip) => `https://geolite.info/geoip/v2.1/city/${ip}`,
    // Cloudflare 官方端点使用 IP 字面地址，证书含 IP SAN，免域名解析；仍遵循现有策略，失败回落 ip.sb。
    outboundTrace: "https://1.1.1.1/cdn-cgi/trace",
    outboundTrace6: "https://[2606:4700:4700::1111]/cdn-cgi/trace",
    outboundIP: "https://api-ipv4.ip.sb/geoip",
    outboundIPv6: "https://api-ipv6.ip.sb/geoip",
    stashIPv4: "https://api.ipify.org?format=json",
    stashIPv6: "https://api6.ipify.org?format=json",
    ipType: "https://my.ippure.com/v1/info",
    ipTypeCard: "https://my.ippure.com/v1/card",
    ipSbGeo: (ip) => `https://api.ip.sb/geoip/${ip}`,
    ipInfo: (ip) => `https://ipinfo.io/${ip}/json`,
    ipApi: (ip, lang) => `http://ip-api.com/json/${ip}?lang=${lang}&fields=status,country,countryCode,regionName,city,isp,org`,
    ipqs: (key, ip) => `https://ipqualityscore.com/api/json/ip/${key}/${ip}?strictness=1`,
    proxyCheck: (ip) => `https://proxycheck.io/v2/${ip}?risk=1&vpn=1`,
    scamalytics: (ip) => `https://scamalytics.com/ip/${ip}`,
    dnsLeakEdns: (id) => `http://${id}.edns.ip-api.com/json`
  },
  ipv6Timeout: 3000,
  stashIPv4Timeout: 5000, // IPPure 失败后的 IPv4 备用请求预算，仍受总时限约束
  policyRetryDelay: 500,
  riskLevels: [
    { max: 15, label: "极度纯净", color: "#0D6E3D" },
    { max: 25, label: "纯净",     color: "#2E9F5E" },
    { max: 40, label: "一般",     color: "#8BC34A" },
    { max: 50, label: "微风险",   color: "#FFC107" },
    { max: 70, label: "一般风险", color: "#FF9800" },
    { max: 100, label: "极度风险", color: "#F44336" }
  ]
};

// 每个卡片/通知任务使用独立队列，收集器仅记录已输出 ID，不清空生产者的队列。
class IPLog {
  static PREFIX = "stash_ip_security_log_v1:";
  static SCOPES = ["summary", "outbound", "local", "risk", "notify"];
  static RUN_ID = Date.now().toString(36) + ":" + Math.random().toString(36).slice(2);
  static sequence = 0;

  static native(value) {
    try { console.log(value); } catch {}
  }

  static text(value) {
    if (typeof value === "string") return value;
    if (value instanceof Error) return value.message || String(value);
    try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
  }

  static readQueue(scope) {
    const raw = $persistentStore.read(IPLog.PREFIX + scope);
    if (!raw) return [];
    const entries = JSON.parse(raw);
    if (!Array.isArray(entries)) return [];
    return entries.filter(entry => entry && typeof entry.id === "string"
      && Number.isFinite(entry.time) && Math.abs(entry.time) <= 8640000000000000
      && typeof entry.text === "string").slice(-60);
  }

  static log(...values) {
    let text;
    try { text = values.map(value => IPLog.text(value)).join(" "); }
    catch { text = "[ip-security] 日志内容无法格式化"; }
    if (!isStash || args.log !== "shared" || args.task === "logs") {
      IPLog.native(text);
      return;
    }
    try {
      const scope = args.task === "monitor" ? "notify"
        : IPLog.SCOPES.includes(args.tile) ? args.tile : "summary";
      const time = Date.now();
      const entry = {
        id: `${time}:${IPLog.RUN_ID}:${String(IPLog.sequence++).padStart(6, "0")}`,
        time,
        text: text.slice(0, 2000)
      };
      const entries = IPLog.readQueue(scope);
      entries.push(entry);
      if ($persistentStore.write(JSON.stringify(entries.slice(-60)), IPLog.PREFIX + scope) === false) {
        throw new Error("日志存储写入失败");
      }
    } catch {
      IPLog.native(text);
    }
  }

  static collect() {
    const pending = [];
    const queues = [];
    for (const scope of IPLog.SCOPES) {
      try {
        const entries = IPLog.readQueue(scope);
        const ackKey = IPLog.PREFIX + "ack:" + scope;
        const previous = JSON.parse($persistentStore.read(ackKey) || "[]");
        const seen = new Set(Array.isArray(previous) ? previous : []);
        for (const entry of entries) {
          if (!seen.has(entry.id)) pending.push({ ...entry, scope });
        }
        const ids = entries.map(entry => entry.id);
        if (ids.some(id => !seen.has(id)) || seen.size !== ids.length) queues.push({ ackKey, ids });
      } catch {
        IPLog.native(`[ip-security][${scope}] 无法读取日志队列`);
      }
    }
    pending.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
    for (const entry of pending) {
      IPLog.native(`[${new Date(entry.time).toISOString()}][${entry.scope}] ${entry.text}`);
    }
    for (const queue of queues) {
      try {
        if ($persistentStore.write(JSON.stringify(queue.ids), queue.ackKey) === false) {
          throw new Error("日志确认写入失败");
        }
      } catch {
        IPLog.native("[ip-security] 无法记录日志确认，下次可能重复输出");
      }
    }
  }
}

// ==================== 参数解析 ====================
function parseArguments() {
  let arg = {};
  const decode = value => { try { return decodeURIComponent(value); } catch (_) { return value; } };

  if (typeof $argument !== "undefined") {
    // 不打印 $argument 原文：其中可能含 ipqs_key 等敏感凭据
    const split = isStash ? $argument.indexOf("&stash_options=") : -1;
    const query = split < 0 ? $argument : $argument.slice(0, split);
    arg = Object.fromEntries(query.split("&").map(i => {
      const idx = i.indexOf("=");
      return idx === -1 ? [i.trim(), ""] : [i.slice(0, idx).trim(), decode(i.slice(idx + 1)).trim()];
    }));
    if (split >= 0) {
      try {
        const options = JSON.parse($argument.slice(split + "&stash_options=".length));
        for (const key of ["lang", "risk_api", "local_geoapi", "remote_geoapi", "mask_ip", "tw_flag", "notify",
          "stash_api", "stash_api_url", "stash_api_secret"]) {
          if (["string", "boolean", "number"].includes(typeof options?.[key])) arg[key] = String(options[key]);
        }
      } catch (_) {} // 未支持覆写参数的客户端保留前面的静态默认值。
    }
  }

  const isPanel = typeof $input !== "undefined" && $input.purpose === "panel";
  const isRequest = typeof $request !== "undefined";
  if (!isStash && !isPanel && !isRequest) {
    arg.TYPE = "EVENT";
  }

  function clean(val) {
    if (!val) return "";
    const v = String(val).trim();
    return (v === "" || v.toLowerCase() === "null") ? "" : v;
  }

  if (!isStash) IPLog.log("参数解析: risk_api=" + JSON.stringify(arg.risk_api) + " ipqs_key=" + (arg.ipqs_key ? "已设置" : "未设置"));

  // notify 参数：默认 true，仅当明确设为 "false" 时关闭通知
  const notifyVal = clean(arg.notify).toLowerCase();
  const notify = notifyVal !== "false";
  const mode = clean(arg.mode);
  const riskApi = clean(arg.risk_api).toLowerCase();
  const lang = ["zh-Hans", "zh-Hant", "en"].includes(clean(arg.lang)) ? clean(arg.lang) : "zh-Hans";
  const localGeoPreference = clean(arg.local_geoapi) || "auto";
  const remoteGeoPreference = clean(arg.remote_geoapi) || "auto";

  return {
    lang,
    isEvent: !isStash && arg.TYPE === "EVENT",
    proxy: isStash && mode !== "collapsed" ? clean(arg.proxy) : "",
    mode: mode === "collapsed" ? "collapsed" : "home",
    tile: clean(arg.tile) || "outbound",
    task: clean(arg.task),
    log: clean(arg.log),
    stashAPI: isStash && clean(arg.stash_api) === "true" && mode !== "collapsed",
    stashAPIURL: isStash ? clean(arg.stash_api_url) : "",
    stashAPISecret: isStash ? clean(arg.stash_api_secret) : "",
    ipqsKey: isStash ? "" : clean(arg.ipqs_key),
    riskApi: isStash && riskApi === "ipqs" ? "ippure" : riskApi || (isStash ? "ippure" : ""),
    maxmindKey: isStash ? "" : clean(arg.maxmind_key),
    localGeoAuto: localGeoPreference === "auto",
    remoteGeoAuto: remoteGeoPreference === "auto",
    localGeoApi: localGeoPreference === "auto" ? (lang === "en" ? "ipsb" : "baidu") : localGeoPreference,
    remoteGeoApi: remoteGeoPreference === "auto" ? (lang === "en" ? "ipapi" : "ipapi-zh") : remoteGeoPreference,
    maskIP: arg.mask_ip === "2" ? 2 : (arg.mask_ip === "1" || arg.mask_ip === "true") ? 1 : 0,
    twFlag: clean(arg.tw_flag) || (isStash ? "tw" : "cn"),
    eventDelay: parseFloat(arg.event_delay) || 2,
    notify: notify,
    panelInterval: parseInt(clean(arg.panel_interval), 10) || 600
  };
}

const args = parseArguments();

// 固定文案仅在显示阶段本地化；原始数据、内部枚举和缓存不翻译。
// Traditional geographic display data, derived from opencc-data@1.4.2.
// Open Chinese Convert (OpenCC) Dictionary; original source: https://github.com/BYVoid/OpenCC
// Pinned data: https://github.com/nk2028/opencc-data/tree/4bcdc1064a298884d673dee8bbe91b2508cac6f5/data
// License: Apache-2.0; accompanying license and notice: licenses/OpenCC/LICENSE and NOTICE.
// https://github.com/HotKids/Rules/tree/master/Surge/Module/Scripts/licenses/OpenCC
// Modified: first character candidates only, identity character pairs omitted,
// geographic phrase subset selected, and mappings compressed into code-point strings.
// This is character conversion with selected geographic phrase overrides, not
// the full OpenCC phrase conversion or a localized country/city-name database.
let _ipGeoHantConvert = null;
function toTraditionalGeo(text) {
  if (typeof text !== "string" || !text) return text;
  if (!_ipGeoHantConvert) {
    const source = Array.from("㐷㐹㐽㑇㑈㑔㑩㓆㓥㓰㔉㖊㖞㘎㚯㛀㛟㛠㛣㛤㛿㟆㟜㟥㡎㤘㤽㥪㧏㧐㧑㧟㧰㨫㭎㭏㭣㭤㭴㱩㱮㲿㳔㳕㳠㳡㳢㳽㴋㶉㶶㶽㺍㻅㻏㻘䀥䁖䂵䃅䅉䅟䅪䇲䉤䌶䌷䌸䌹䌺䌻䌼䌽䌾䌿䍀䍁䍠䎬䏝䑽䓓䓕䓖䓨䗖䘛䘞䙊䙌䙓䜣䜤䜥䜧䜩䝙䞌䞍䞎䞐䟢䢀䢁䢂䥺䥽䥾䥿䦀䦁䦂䦃䦅䦆䦶䦷䩄䭪䯃䯄䯅䲝䲞䲟䲠䲡䲢䲣䴓䴔䴕䴖䴗䴘䴙䶮万与丑专业丛东丝丢两严丧个丰临为丽举么义乌乐乔习乡书买乱争于亏云亘亚产亩亲亵亸亿仅仆从仑仓仪们价众优伙会伛伞伟传伡伣伤伥伦伧伪伫体余佣佥侠侣侥侦侧侨侩侪侬侭俣俦俨俩俪俫俭债倾偬偻偾偿傤傥傧储傩儿兑兖党兰关兴兹养兽冁内冈册写军农冯冲决况冻净凄准凉减凑凛几凤凫凭凯凶击凿刍划刘则刚创删别刬刭刹刽刾刿剀剂剐剑剥剧劝办务劢动励劲劳势勋勚匀匦匮区医华协单卖占卢卤卧卫却卺厂厅历厉压厌厍厐厕厘厢厣厦厨厩厮县叁参叆叇双发变叙叠台叶号叹叽吁吃后吓吕吗吨听启吴呐呒呓呕呖呗员呙呛呜咏咙咛咝咤咨咸响哑哒哓哔哕哗哙哜哝哟唇唛唝唠唡唢唤啧啬啭啮啯啰啴啸喷喽喾嗫嗳嘘嘤嘱噜嚣团园囱围囵国图圆圣圹场坏块坚坛坜坝坞坟坠垄垅垆垒垦垩垫垭垯垱垲垴埘埙埚堑堕塆墙壮声壳壶壸处备复够头夸夹夺奁奂奋奖奥妆妇妈妩妪妫姗姹娄娅娆娇娈娱娲娴婳婴婵婶媪媭嫒嫔嫱嬷孙学孪宁宝实宠审宪宫宽宾寝对寻导寿将尔尘尝尧尴尸尽层屃屉届属屡屦屿岁岂岖岗岘岚岛岩岭岳岽岿峃峄峡峣峤峥峦峰崂崃崄崭嵘嵚嵝巅巩巯币帅师帏帐帘帜带帧帮帱帻帼幂干并广庄庆床庐庑库应庙庞废庼廪开异弃弑张弥弪弯弹强归当录彟彦彨彻征径徕忆忏忧忾怀态怂怃怄怅怆怜总怼怿恋恒恳恶恸恹恺恻恼恽悦悫悬悭悮悯惊惧惨惩惫惬惭惮惯愠愤愦愿慑慭懑懒懔戆戋戏戗战戬戯户扑执扩扪扫扬扰抚抛抟抠抡抢护报担拟拢拣拥拦拧拨择挂挚挛挜挝挞挟挠挡挢挣挤挥挦捝捞损捡换捣据掳掴掷掸掺掼揽揾揿搀搁搂搄搅携摄摅摆摇摈摊撄撑撵撷撸撺擜擞攒敌敚敛敩数斋斓斗斩断无旧时旷旸昙昵昼昽显晋晒晓晔晕晖暂暅暧术朴机杀杂权杠条来杨杩杰极构枞枢枣枥枧枨枪枫枭柜柠柽栀栅标栈栉栊栋栌栎栏树栖样栾桠桡桢档桤桥桦桧桨桩桪梦梼梾梿检棁棂椁椝椟椠椢椤椫椭椮楼榄榅榇榈榉榝槚槛槟槠横樯樱橥橱橹橼檩欢欤欧歼殁殇残殒殓殚殡殴毁毂毕毙毡毵毶氇气氢氩氲汇汉汤汹沄沟没沣沤沥沦沧沨沩沪泞泪泶泷泸泺泻泼泽泾洁洒洼浃浅浆浇浈浉浊测浍济浏浐浑浒浓浔浕涂涌涚涛涝涞涟涠涡涢涣涤润涧涨涩淀渊渌渍渎渐渑渔渖渗温游湾湿溁溃溅溆溇滗滚滞滟滠满滢滤滥滦滨滩滪潆潇潋潍潜潴澛澜濑濒灏灭灯灵灶灾灿炀炉炖炜炝点炼炽烁烂烃烛烟烦烧烨烩烫烬热焕焖焘煴熏爱爷牍牦牵牺犊状犷犸犹狈狝狞独狭狮狯狰狱狲猃猎猕猡猪猫猬献獭玑玙玚玛玮环现玱玺珐珑珰珲琎琏琐琼瑶瑷瑸璎瓒瓮瓯电画畅畴疖疗疟疠疡疬疭疮疯疱疴痈痉痒痖痨痪痫痴瘅瘆瘗瘘瘪瘫瘾瘿癞癣癫皂皑皱皲盏盐监盖盗盘眍眦眬睁睐睑瞆瞒瞩矫矶矾矿砀码砖砗砚砜砺砻砾础硁硕硖硗硙硚确硵碍碛碜碱礼祃祎祢祯祷祸禀禄禅离秃秆种秘积称秽秾稆税稣稳穑穞穷窃窍窎窑窜窝窥窦窭竖竞笃笋笔笕笺笼笾筑筚筛筜筝筹筼签筿简箓箦箧箨箩箪箫篑篓篮篯篱簖籁籴类籼粜粝粤粪粮粽糁糇糍紧絷緼縆纟纠纡红纣纤纥约级纨纩纪纫纬纭纮纯纰纱纲纳纴纵纶纷纸纹纺纻纼纽纾线绀绁绂练组绅细织终绉绊绋绌绍绎经绐绑绒结绔绕绖绗绘给绚绛络绝绞统绠绡绢绣绤绥绦继绨绩绪绫绬续绮绯绰绱绲绳维绵绶绷绸绹绺绻综绽绾绿缀缁缂缃缄缅缆缇缈缉缊缋缌缍缎缏缐缑缒缓缔缕编缗缘缙缚缛缜缝缞缟缠缡缢缣缤缥缦缧缨缩缪缫缬缭缮缯缰缱缲缳缴缵罂网罗罚罢罴羁羟羡群翘翙翚耢耧耸耻聂聋职聍联聩聪肃肠肤肮肴肾肿胀胁胆胜胧胨胪胫胶脉脍脏脐脑脓脔脚脱脶脸腊腌腘腭腻腼腽腾膑膻臜舆舣舰舱舻艰艳艺节芈芗芜芦苁苇苈苋苌苍苎苏苧苹范茎茏茑茔茕茧荆荐荙荚荛荜荝荞荟荠荡荣荤荥荦荧荨荩荪荫荬荭荮药莅莱莲莳莴莶获莸莹莺莼萚萝萤营萦萧萨葱蒀蒇蒉蒋蒌蒏蓝蓟蓠蓣蓥蓦蔂蔷蔹蔺蔼蕰蕲蕴薮藓藴蘖虏虑虚虫虬虮虱虽虾虿蚀蚁蚂蚃蚕蚝蚬蛊蛎蛏蛮蛰蛱蛲蛳蛴蜕蜗蜡蝇蝈蝉蝎蝼蝾螀螨蟏衅衔补衬衮袄袅袆袜袭袯装裆裈裢裣裤裥褛褴襕见观觃规觅视觇览觉觊觋觌觍觎觏觐觑觞触觯訚詟誉誊讠计订讣认讥讦讧讨让讪讫讬训议讯记讱讲讳讴讵讶讷许讹论讻讼讽设访诀证诂诃评诅识诇诈诉诊诋诌词诎诏诐译诒诓诔试诖诗诘诙诚诛诜话诞诟诠诡询诣诤该详诧诨诩诪诫诬语诮误诰诱诲诳说诵诶请诸诹诺读诼诽课诿谀谁谂调谄谅谆谇谈谉谊谋谌谍谎谏谐谑谒谓谔谕谖谗谘谙谚谛谜谝谞谟谠谡谢谣谤谥谦谧谨谩谪谫谬谭谮谯谰谱谲谳谴谵谶豮贝贞负贠贡财责贤败账货质贩贪贫贬购贮贯贰贱贲贳贴贵贶贷贸费贺贻贼贽贾贿赀赁赂赃资赅赆赇赈赉赊赋赌赍赎赏赐赑赒赓赔赕赖赗赘赙赚赛赜赝赞赟赠赡赢赣赪赵赶趋趱趸跃跄跖跞践跶跷跸跹跻踌踪踬踯蹑蹒蹰蹿躏躜躯輼车轧轨轩轪轫转轭轮软轰轱轲轳轴轵轶轷轸轹轺轻轼载轾轿辀辁辂较辄辅辆辇辈辉辊辋辌辍辎辏辐辑辒输辔辕辖辗辘辙辚辞辟辩辫边辽达迁过迈运还这进远违连迟迩迳迹适选逊递逦逻遗遥邓邝邬邮邹邺邻郁郏郐郑郓郦郧郸酂酝酦酱酽酾酿醖采释里鉴銮錾钅钆钇针钉钊钋钌钍钎钏钐钑钒钓钔钕钖钗钘钙钚钛钜钝钞钟钠钡钢钣钤钥钦钧钨钩钪钫钬钭钮钯钰钱钲钳钴钵钶钷钸钹钺钻钼钽钾钿铀铁铂铃铄铅铆铇铈铉铊铋铌铍铎铏铐铑铒铓铔铕铖铗铘铙铚铛铜铝铞铟铠铡铢铣铤铥铦铧铨铩铪铫铬铭铮铯铰铱铲铳铴铵银铷铸铹铺铻铼铽链铿销锁锂锃锄锅锆锇锈锉锊锋锌锍锎锏锐锑锒锓锔锕锖锗锘错锚锛锜锝锞锟锠锡锢锣锤锥锦锧锨锩锪锫锬锭键锯锰锱锲锳锴锵锶锷锸锹锺锻锼锽锾锿镀镁镂镃镄镅镆镇镈镉镊镋镌镍镎镏镐镑镒镓镔镕镖镗镘镙镚镛镜镝镞镟镠镡镢镣镤镥镦镧镨镩镪镫镬镭镮镯镰镱镲镳镴镵镶长门闩闪闫闬闭问闯闰闱闲闳间闵闶闷闸闹闺闻闼闽闾闿阀阁阂阃阄阅阆阇阈阉阊阋阌阍阎阏阐阑阒阓阔阕阖阗阘阙阚阛队阳阴阵阶际陆陇陈陉陕陦陧陨险随隐隶隽难雇雏雠雳雾霁霉霡霭靓靔静靥鞑鞒鞯鞲韦韧韨韩韪韫韬韵页顶顷顸项顺须顼顽顾顿颀颁颂颃预颅领颇颈颉颊颋颌颍颎颏颐频颒颓颔颕颖颗题颙颚颛颜额颞颟颠颡颢颣颤颥颦颧风飏飐飑飒飓飔飕飖飗飘飙飚飞飨餍饣饤饥饦饧饨饩饪饫饬饭饮饯饰饱饲饳饴饵饶饷饸饹饺饻饼饽饾饿馀馁馂馃馄馅馆馇馈馉馊馋馌馍馎馏馐馑馒馓馔馕马驭驮驯驰驱驲驳驴驵驶驷驸驹驺驻驼驽驾驿骀骁骂骃骄骅骆骇骈骉骊骋验骍骎骏骐骑骒骓骔骕骖骗骘骙骚骛骜骝骞骟骠骡骢骣骤骥骦骧髅髋髌鬓鬶魇魉鱼鱽鱾鱿鲀鲁鲂鲃鲄鲅鲆鲇鲈鲉鲊鲋鲌鲍鲎鲏鲐鲑鲒鲓鲔鲕鲖鲗鲘鲙鲚鲛鲜鲝鲞鲟鲠鲡鲢鲣鲤鲥鲦鲧鲨鲩鲪鲫鲬鲭鲮鲯鲰鲱鲲鲳鲴鲵鲶鲷鲸鲹鲺鲻鲼鲽鲾鲿鳀鳁鳂鳃鳄鳅鳆鳇鳈鳉鳊鳋鳌鳍鳎鳏鳐鳑鳒鳓鳔鳕鳖鳗鳘鳙鳚鳛鳜鳝鳞鳟鳠鳡鳢鳣鳤鸟鸠鸡鸢鸣鸤鸥鸦鸧鸨鸩鸪鸫鸬鸭鸮鸯鸰鸱鸲鸳鸴鸵鸶鸷鸸鸹鸺鸻鸼鸽鸾鸿鹀鹁鹂鹃鹄鹅鹆鹇鹈鹉鹊鹋鹌鹍鹎鹏鹐鹑鹒鹓鹔鹕鹖鹗鹘鹙鹚鹛鹜鹝鹞鹟鹠鹡鹢鹣鹤鹥鹦鹧鹨鹩鹪鹫鹬鹭鹮鹯鹰鹱鹲鹳鹴鹾麦麸麹麺麽黄黉黡黩黪黾鼋鼌鼍鼹齐齑齿龀龁龂龃龄龅龆龇龈龉龊龋龌龙龚龛龟鿎鿏鿒鿔𠀾𠆲𠆿𠇹𠉂𠉗𠋆𠚳𠛅𠛆𠛾𠡠𠮶𠯟𠯠𠰱𠰷𠱞𠲥𠴛𠴢𠵸𠵾𡋀𡋗𡋤𡍣𡒄𡝠𡞋𡞱𡠟𡥧𡭜𡭬𡳃𡳒𡶴𡸃𡺃𡺄𢋈𢗓𢘙𢘝𢘞𢙏𢙐𢙑𢙒𢙓𢛯𢠁𢢐𢧐𢫊𢫞𢫬𢬍𢬦𢭏𢽾𣃁𣆐𣈣𣍨𣍯𣍰𣎑𣏢𣐕𣐤𣑶𣒌𣓿𣔌𣗊𣗋𣗙𣘐𣘓𣘴𣘷𣚚𣞎𣨼𣭤𣯣𣱝𣲗𣲘𣳆𣶩𣶫𣶭𣷷𣸣𣺼𣺽𣽷𤆡𤆢𤇃𤇄𤇭𤇹𤈶𤈷𤊀𤊰𤋏𤎺𤎻𤙯𤝢𤞃𤞤𤠋𤦀𤩽𤳄𤶊𤶧𤻊𤽯𤾀𤿲𥁢𥅘𥅴𥅿𥆧𥇢𥎝𥐟𥐯𥐰𥐻𥞦𥧂𥩟𥩺𥫣𥬀𥬞𥬠𥭉𥮋𥮜𥮾𥱔𥹥𥺅𥺇𦈈𦈉𦈋𦈌𦈎𦈏𦈐𦈑𦈒𦈓𦈔𦈕𦈖𦈗𦈘𦈙𦈚𦈛𦈜𦈝𦈞𦈟𦈠𦈡𦍠𦛨𦝼𦟗𦨩𦰏𦰴𦶟𦶻𦻕𧉐𧉞𧌥𧏖𧏗𧑏𧒭𧜭𧝝𧝧𧮪𧳕𧹑𧹒𧹓𧹔𧹕𧹖𧹗𧿈𨀁𨀱𨁴𨂺𨄄𨅛𨅫𨅬𨉗𨐅𨐆𨐇𨐈𨐉𨐊𨑹𨟳𨠨𨡙𨡺𨤰𨰾𨰿𨱀𨱁𨱂𨱃𨱄𨱅𨱆𨱇𨱈𨱉𨱊𨱋𨱌𨱍𨱎𨱏𨱐𨱑𨱒𨱓𨱔𨱕𨱖𨷿𨸀𨸁𨸂𨸃𨸄𨸅𨸆𨸇𨸉𨸊𨸋𨸌𨸎𨸘𨸟𩏼𩏽𩏾𩏿𩐀𩓋𩖕𩖖𩖗𩙥𩙦𩙧𩙨𩙩𩙪𩙫𩙬𩙭𩙮𩙯𩙰𩟿𩠀𩠁𩠂𩠃𩠅𩠆𩠇𩠈𩠉𩠊𩠋𩠌𩠎𩠏𩠠𩡖𩧦𩧨𩧩𩧪𩧫𩧬𩧭𩧮𩧯𩧰𩧱𩧲𩧳𩧴𩧵𩧶𩧸𩧺𩧻𩧼𩧿𩨀𩨁𩨂𩨃𩨄𩨅𩨆𩨇𩨈𩨉𩨊𩨋𩨌𩨍𩨎𩨏𩨐𩩈𩬣𩬤𩭹𩯒𩰰𩲒𩴌𩽹𩽺𩽻𩽼𩽽𩽾𩽿𩾁𩾂𩾃𩾄𩾅𩾆𩾇𩾈𩾊𩾋𩾌𩾎𪉂𪉃𪉄𪉅𪉆𪉈𪉉𪉊𪉋𪉌𪉍𪉎𪉏𪉐𪉑𪉒𪉔𪉕𪎈𪎉𪎊𪎋𪎌𪑅𪔭𪚏𪚐𪜎𪞝𪟎𪟝𪠀𪠟𪠡𪠳𪠵𪠸𪠺𪠽𪡀𪡃𪡋𪡏𪡛𪡞𪡺𪢌𪢐𪢒𪢕𪢖𪢠𪢮𪢸𪣆𪣒𪣻𪤄𪤚𪥠𪥫𪥰𪥿𪧀𪧘𪨊𪨗𪨧𪨩𪨶𪨷𪨹𪩇𪩎𪩘𪩛𪩷𪩸𪪏𪪑𪪞𪪴𪪼𪫌𪫡𪫷𪫺𪬚𪬯𪭝𪭢𪭧𪭯𪭵𪭾𪮃𪮋𪮖𪮳𪮶𪯋𪰶𪱥𪱷𪲎𪲔𪲛𪲮𪳍𪳗𪴙𪵑𪵣𪵱𪶄𪶒𪶮𪷍𪷽𪸕𪸩𪹀𪹠𪹳𪹹𪺣𪺪𪺭𪺷𪺸𪺻𪺽𪻐𪻨𪻲𪻺𪼋𪼴𪽈𪽝𪽪𪽭𪽮𪽴𪽷𪾔𪾢𪾣𪾦𪾸𪿊𪿞𪿫𪿵𫀌𫀓𫀨𫀬𫀮𫁂𫁟𫁡𫁱𫁲𫁳𫁷𫁺𫂃𫂆𫂈𫂖𫂿𫃗𫄙𫄚𫄛𫄜𫄝𫄞𫄟𫄠𫄡𫄢𫄣𫄤𫄥𫄦𫄧𫄨𫄩𫄪𫄫𫄬𫄭𫄮𫄯𫄰𫄱𫄲𫄳𫄴𫄵𫄶𫄷𫄸𫄹𫅅𫅗𫅥𫅭𫅼𫆏𫆝𫆫𫇘𫇛𫇪𫇭𫇴𫇽𫈉𫈎𫈟𫈵𫉁𫉄𫊪𫊮𫊸𫊹𫊻𫋇𫋌𫋲𫋷𫋹𫋻𫌀𫌇𫌋𫌨𫌪𫌫𫌬𫌭𫌯𫍐𫍙𫍚𫍛𫍜𫍝𫍞𫍟𫍠𫍡𫍢𫍣𫍤𫍥𫍦𫍧𫍨𫍩𫍪𫍫𫍬𫍭𫍮𫍯𫍰𫍱𫍲𫍳𫍴𫍵𫍶𫍷𫍸𫍹𫍺𫍻𫍼𫍽𫍾𫍿𫎆𫎌𫎦𫎧𫎨𫎩𫎪𫎫𫎬𫎭𫎱𫎳𫎸𫎺𫏃𫏆𫏋𫏌𫏐𫏑𫏕𫏞𫏨𫐄𫐅𫐆𫐇𫐈𫐉𫐊𫐋𫐌𫐍𫐎𫐏𫐐𫐑𫐒𫐓𫐔𫐕𫐖𫐗𫐘𫐙𫐷𫑘𫑡𫑷𫓥𫓦𫓧𫓨𫓩𫓪𫓫𫓬𫓭𫓮𫓯𫓰𫓱𫓲𫓳𫓴𫓵𫓶𫓷𫓸𫓹𫓺𫓻𫓼𫓽𫓾𫓿𫔀𫔁𫔂𫔃𫔄𫔅𫔆𫔇𫔈𫔉𫔊𫔋𫔌𫔍𫔎𫔏𫔐𫔑𫔒𫔓𫔔𫔕𫔖𫔭𫔮𫔯𫔰𫔲𫔴𫔵𫔶𫔽𫕚𫕥𫕨𫖃𫖅𫖇𫖑𫖒𫖓𫖔𫖕𫖖𫖪𫖫𫖬𫖭𫖮𫖯𫖰𫖱𫖲𫖳𫖴𫖵𫖶𫖷𫖸𫖹𫖺𫗇𫗈𫗉𫗊𫗋𫗚𫗞𫗟𫗠𫗡𫗢𫗣𫗤𫗥𫗦𫗧𫗨𫗩𫗪𫗫𫗬𫗭𫗮𫗯𫗰𫗱𫗳𫗴𫗵𫘛𫘜𫘝𫘞𫘟𫘠𫘡𫘣𫘤𫘥𫘦𫘧𫘨𫘩𫘪𫘫𫘬𫘭𫘮𫘯𫘰𫘱𫘽𫙂𫚈𫚉𫚊𫚋𫚌𫚍𫚎𫚏𫚐𫚑𫚒𫚓𫚔𫚕𫚖𫚗𫚘𫚙𫚚𫚛𫚜𫚝𫚞𫚟𫚠𫚡𫚢𫚣𫚤𫚥𫚦𫚧𫚨𫚩𫚪𫚫𫚬𫚭𫛚𫛛𫛜𫛝𫛞𫛟𫛠𫛡𫛢𫛣𫛤𫛥𫛦𫛧𫛨𫛩𫛪𫛫𫛬𫛭𫛮𫛯𫛰𫛱𫛲𫛳𫛴𫛵𫛶𫛷𫛸𫛹𫛺𫛻𫛼𫛽𫛾𫜀𫜁𫜂𫜃𫜄𫜅𫜊𫜑𫜒𫜓𫜔𫜕𫜙𫜟𫜨𫜩𫜪𫜫𫜬𫜭𫜮𫜯𫜰𫜲𫜳𫝈𫝋𫝦𫝧𫝨𫝩𫝪𫝫𫝬𫝭𫝮𫝵𫞅𫞗𫞚𫞛𫞝𫞠𫞡𫞢𫞣𫞥𫞦𫞧𫞨𫞩𫞷𫟃𫟄𫟅𫟆𫟇𫟑𫟕𫟞𫟟𫟠𫟡𫟢𫟤𫟥𫟦𫟫𫟬𫟲𫟳𫟴𫟵𫟶𫟷𫟸𫟹𫟺𫟻𫟼𫟽𫟾𫟿𫠀𫠁𫠂𫠅𫠆𫠇𫠈𫠊𫠋𫠌𫠏𫠐𫠑𫠒𫠖𫠜𫢸𫧃𫧮𫫇𫬐𫭟𫭢𫭼𫮃𫰛𫵷𫶇𫷷𫸩𬀩𬀪𬂩𬃊𬇕𬇙𬇹𬉼𬊈𬊤𬍛𬍡𬍤𬒈𬒗𬕂𬘓𬘘𬘡𬘩𬘫𬘬𬘭𬘯𬙂𬙊𬙋𬜬𬜯𬞟𬟁𬟽𬣙𬣞𬣡𬣳𬤇𬤊𬤝𬨂𬨎𬩽𬪩𬬩𬬭𬬮𬬱𬬸𬬹𬬻𬬿𬭁𬭊𬭎𬭚𬭛𬭤𬭩𬭬𬭭𬭯𬭳𬭶𬭸𬭼𬮱𬮿𬯀𬯎𬱖𬱟𬳵𬳶𬳽𬳿𬴂𬴃𬴊𬶋𬶍𬶏𬶐𬶟𬶠𬶨𬶭𬶮𬷕𬸘𬸚𬸣𬸦𬸪𬸯𬹼𬺈𬺓𰬸𰰨𰶎𰻝𰾄𰾭𱊜");
    const target = Array.from("傌㑶偑㑳倲㑯儸𠗣劏劃劚噚喎㘚㜄媰𡞵𡢃㜏孋𡠹㠏𡾱嵾幓㥮懤慺掆㩳撝擓擽㩜棡椲𣙎樢樫殰殨瀇濧灡澾濄𣾷瀰潚鸂燶煱獱璯𤫩𤪺䁻瞜碽磾稏穇𥢢筴籔䊷紬縳絅䋙䋚綐綵䋻䋹繿繸䍦䎱膞𦪙薵薳藭罃螮𧝞𧜗𧜵䙡襬訢鿁𧩙䜀讌貙𧵳䝼𧶧賰躎𨊰𨊸𨋢釾鏺䥱𨯅𨦫𨧜䥇鐯鐥钁䦛䦟靦𩞯𩣑騧䯀䱽𩶘鮣鰆鰌鰧䱷鳾鵁鴷鶄鶪鷉鸊龑萬與醜專業叢東絲丟兩嚴喪個豐臨爲麗舉麼義烏樂喬習鄉書買亂爭於虧雲亙亞產畝親褻嚲億僅僕從侖倉儀們價衆優夥會傴傘偉傳俥俔傷倀倫傖僞佇體餘傭僉俠侶僥偵側僑儈儕儂儘俁儔儼倆儷倈儉債傾傯僂僨償儎儻儐儲儺兒兌兗黨蘭關興茲養獸囅內岡冊寫軍農馮衝決況凍淨悽準涼減湊凜幾鳳鳧憑凱兇擊鑿芻劃劉則剛創刪別剗剄剎劊㓨劌剴劑剮劍剝劇勸辦務勱動勵勁勞勢勳勩勻匭匱區醫華協單賣佔盧滷臥衛卻巹廠廳歷厲壓厭厙龎廁釐廂厴廈廚廄廝縣叄參靉靆雙發變敘疊臺葉號嘆嘰籲喫後嚇呂嗎噸聽啓吳吶嘸囈嘔嚦唄員咼嗆嗚詠嚨嚀噝吒諮鹹響啞噠嘵嗶噦譁噲嚌噥喲脣嘜嗊嘮啢嗩喚嘖嗇囀齧嘓囉嘽嘯噴嘍嚳囁噯噓嚶囑嚕囂團園囪圍圇國圖圓聖壙場壞塊堅壇壢壩塢墳墜壟壠壚壘墾堊墊埡墶壋塏堖塒壎堝塹墮壪牆壯聲殼壺壼處備復夠頭誇夾奪奩奐奮獎奧妝婦媽嫵嫗嬀姍奼婁婭嬈嬌孌娛媧嫺嫿嬰嬋嬸媼嬃嬡嬪嬙嬤孫學孿寧寶實寵審憲宮寬賓寢對尋導壽將爾塵嘗堯尷屍盡層屓屜屆屬屢屨嶼歲豈嶇崗峴嵐島巖嶺嶽崬巋嶨嶧峽嶢嶠崢巒峯嶗崍嶮嶄嶸嶔嶁巔鞏巰幣帥師幃帳簾幟帶幀幫幬幘幗冪幹並廣莊慶牀廬廡庫應廟龐廢廎廩開異棄弒張彌弳彎彈強歸當錄彠彥彲徹徵徑徠憶懺憂愾懷態慫憮慪悵愴憐總懟懌戀恆懇惡慟懨愷惻惱惲悅愨懸慳悞憫驚懼慘懲憊愜慚憚慣慍憤憒願懾憖懣懶懍戇戔戲戧戰戩戱戶撲執擴捫掃揚擾撫拋摶摳掄搶護報擔擬攏揀擁攔擰撥擇掛摯攣掗撾撻挾撓擋撟掙擠揮撏挩撈損撿換搗據擄摑擲撣摻摜攬搵撳攙擱摟揯攪攜攝攄擺搖擯攤攖撐攆擷擼攛㩵擻攢敵敓斂斆數齋斕鬥斬斷無舊時曠暘曇暱晝曨顯晉曬曉曄暈暉暫𣈶曖術樸機殺雜權槓條來楊榪傑極構樅樞棗櫪梘棖槍楓梟櫃檸檉梔柵標棧櫛櫳棟櫨櫟欄樹棲樣欒椏橈楨檔榿橋樺檜槳樁樳夢檮棶槤檢梲欞槨槼櫝槧槶欏樿橢槮樓欖榲櫬櫚櫸樧檟檻檳櫧橫檣櫻櫫櫥櫓櫞檁歡歟歐殲歿殤殘殞殮殫殯毆毀轂畢斃氈毿𣯶氌氣氫氬氳匯漢湯洶澐溝沒灃漚瀝淪滄渢潙滬濘淚澩瀧瀘濼瀉潑澤涇潔灑窪浹淺漿澆湞溮濁測澮濟瀏滻渾滸濃潯濜塗湧涗濤澇淶漣潿渦溳渙滌潤澗漲澀澱淵淥漬瀆漸澠漁瀋滲溫遊灣溼濚潰濺漵漊潷滾滯灩灄滿瀅濾濫灤濱灘澦瀠瀟瀲濰潛瀦瀂瀾瀨瀕灝滅燈靈竈災燦煬爐燉煒熗點煉熾爍爛烴燭煙煩燒燁燴燙燼熱煥燜燾熅燻愛爺牘犛牽犧犢狀獷獁猶狽獮獰獨狹獅獪猙獄猻獫獵獼玀豬貓蝟獻獺璣璵瑒瑪瑋環現瑲璽琺瓏璫琿璡璉瑣瓊瑤璦璸瓔瓚甕甌電畫暢疇癤療瘧癘瘍癧瘲瘡瘋皰痾癰痙癢瘂癆瘓癇癡癉瘮瘞瘻癟癱癮癭癩癬癲皁皚皺皸盞鹽監蓋盜盤瞘眥矓睜睞瞼瞶瞞矚矯磯礬礦碭碼磚硨硯碸礪礱礫礎硜碩硤磽磑礄確磠礙磧磣鹼禮禡禕禰禎禱禍稟祿禪離禿稈種祕積稱穢穠穭稅穌穩穡穭窮竊竅窵窯竄窩窺竇窶豎競篤筍筆筧箋籠籩築篳篩簹箏籌篔籤篠簡籙簀篋籜籮簞簫簣簍籃籛籬籪籟糴類秈糶糲粵糞糧糉糝餱餈緊縶縕緪糹糾紆紅紂纖紇約級紈纊紀紉緯紜紘純紕紗綱納紝縱綸紛紙紋紡紵紖紐紓線紺紲紱練組紳細織終縐絆紼絀紹繹經紿綁絨結絝繞絰絎繪給絢絳絡絕絞統綆綃絹繡綌綏絛繼綈績緒綾緓續綺緋綽鞝緄繩維綿綬繃綢綯綹綣綜綻綰綠綴緇緙緗緘緬纜緹緲緝縕繢緦綞緞緶線緱縋緩締縷編緡緣縉縛縟縝縫縗縞纏縭縊縑繽縹縵縲纓縮繆繅纈繚繕繒繮繾繰繯繳纘罌網羅罰罷羆羈羥羨羣翹翽翬耮耬聳恥聶聾職聹聯聵聰肅腸膚骯餚腎腫脹脅膽勝朧腖臚脛膠脈膾髒臍腦膿臠腳脫腡臉臘醃膕齶膩靦膃騰臏羶臢輿艤艦艙艫艱豔藝節羋薌蕪蘆蓯葦藶莧萇蒼苧蘇薴蘋範莖蘢蔦塋煢繭荊薦薘莢蕘蓽萴蕎薈薺蕩榮葷滎犖熒蕁藎蓀蔭蕒葒葤藥蒞萊蓮蒔萵薟獲蕕瑩鶯蓴蘀蘿螢營縈蕭薩蔥蒕蕆蕢蔣蔞醟藍薊蘺蕷鎣驀虆薔蘞藺藹薀蘄蘊藪蘚蘊櫱虜慮虛蟲虯蟣蝨雖蝦蠆蝕蟻螞蠁蠶蠔蜆蠱蠣蟶蠻蟄蛺蟯螄蠐蛻蝸蠟蠅蟈蟬蠍螻蠑螿蟎蠨釁銜補襯袞襖嫋褘襪襲襏裝襠褌褳襝褲襉褸襤襴見觀覎規覓視覘覽覺覬覡覿覥覦覯覲覷觴觸觶誾讋譽謄訁計訂訃認譏訐訌討讓訕訖託訓議訊記訒講諱謳詎訝訥許訛論訩訟諷設訪訣證詁訶評詛識詗詐訴診詆謅詞詘詔詖譯詒誆誄試詿詩詰詼誠誅詵話誕詬詮詭詢詣諍該詳詫諢詡譸誡誣語誚誤誥誘誨誑說誦誒請諸諏諾讀諑誹課諉諛誰諗調諂諒諄誶談讅誼謀諶諜謊諫諧謔謁謂諤諭諼讒諮諳諺諦謎諞諝謨讜謖謝謠謗諡謙謐謹謾謫譾謬譚譖譙讕譜譎讞譴譫讖豶貝貞負貟貢財責賢敗賬貨質販貪貧貶購貯貫貳賤賁貰貼貴貺貸貿費賀貽賊贄賈賄貲賃賂贓資賅贐賕賑賚賒賦賭齎贖賞賜贔賙賡賠賧賴賵贅賻賺賽賾贗贊贇贈贍贏贛赬趙趕趨趲躉躍蹌蹠躒踐躂蹺蹕躚躋躊蹤躓躑躡蹣躕躥躪躦軀轀車軋軌軒軑軔轉軛輪軟轟軲軻轤軸軹軼軤軫轢軺輕軾載輊轎輈輇輅較輒輔輛輦輩輝輥輞輬輟輜輳輻輯轀輸轡轅轄輾轆轍轔辭闢辯辮邊遼達遷過邁運還這進遠違連遲邇逕跡適選遜遞邐邏遺遙鄧鄺鄔郵鄒鄴鄰鬱郟鄶鄭鄆酈鄖鄲酇醞醱醬釅釃釀醞採釋裏鑑鑾鏨釒釓釔針釘釗釙釕釷釺釧釤鈒釩釣鍆釹鍚釵鈃鈣鈈鈦鉅鈍鈔鍾鈉鋇鋼鈑鈐鑰欽鈞鎢鉤鈧鈁鈥鈄鈕鈀鈺錢鉦鉗鈷鉢鈳鉕鈽鈸鉞鑽鉬鉭鉀鈿鈾鐵鉑鈴鑠鉛鉚鉋鈰鉉鉈鉍鈮鈹鐸鉶銬銠鉺鋩錏銪鋮鋏鋣鐃銍鐺銅鋁銱銦鎧鍘銖銑鋌銩銛鏵銓鎩鉿銚鉻銘錚銫鉸銥鏟銃鐋銨銀銣鑄鐒鋪鋙錸鋱鏈鏗銷鎖鋰鋥鋤鍋鋯鋨鏽銼鋝鋒鋅鋶鐦鐧銳銻鋃鋟鋦錒錆鍺鍩錯錨錛錡鍀錁錕錩錫錮鑼錘錐錦鑕鍁錈鍃錇錟錠鍵鋸錳錙鍥鍈鍇鏘鍶鍔鍤鍬鍾鍛鎪鍠鍰鎄鍍鎂鏤鎡鐨鎇鏌鎮鎛鎘鑷钂鐫鎳鎿鎦鎬鎊鎰鎵鑌鎔鏢鏜鏝鏍鏰鏞鏡鏑鏃鏇鏐鐔钁鐐鏷鑥鐓鑭鐠鑹鏹鐙鑊鐳鐶鐲鐮鐿鑔鑣鑞鑱鑲長門閂閃閆閈閉問闖閏闈閒閎間閔閌悶閘鬧閨聞闥閩閭闓閥閣閡閫鬮閱閬闍閾閹閶鬩閿閽閻閼闡闌闃闠闊闋闔闐闒闕闞闤隊陽陰陣階際陸隴陳陘陝隯隉隕險隨隱隸雋難僱雛讎靂霧霽黴霢靄靚靝靜靨韃鞽韉韝韋韌韍韓韙韞韜韻頁頂頃頇項順須頊頑顧頓頎頒頌頏預顱領頗頸頡頰頲頜潁熲頦頤頻頮頹頷頴穎顆題顒顎顓顏額顳顢顛顙顥纇顫顬顰顴風颺颭颮颯颶颸颼颻飀飄飆飈飛饗饜飠飣飢飥餳飩餼飪飫飭飯飲餞飾飽飼飿飴餌饒餉餄餎餃餏餅餑餖餓餘餒餕餜餛餡館餷饋餶餿饞饁饃餺餾饈饉饅饊饌饢馬馭馱馴馳驅馹駁驢駔駛駟駙駒騶駐駝駑駕驛駘驍罵駰驕驊駱駭駢驫驪騁驗騂駸駿騏騎騍騅騌驌驂騙騭騤騷騖驁騮騫騸驃騾驄驏驟驥驦驤髏髖髕鬢鬹魘魎魚魛魢魷魨魯魴䰾魺鮁鮃鮎鱸鮋鮓鮒鮊鮑鱟鮍鮐鮭鮚鮳鮪鮞鮦鰂鮜鱠鱭鮫鮮鮺鯗鱘鯁鱺鰱鰹鯉鰣鰷鯀鯊鯇鮶鯽鯒鯖鯪鯕鯫鯡鯤鯧鯝鯢鯰鯛鯨鰺鯴鯔鱝鰈鰏鱨鯷鰮鰃鰓鱷鰍鰒鰉鰁鱂鯿鰠鰲鰭鰨鰥鰩鰟鰜鰳鰾鱈鱉鰻鰵鱅䲁鰼鱖鱔鱗鱒鱯鱤鱧鱣䲘鳥鳩雞鳶鳴鳲鷗鴉鶬鴇鴆鴣鶇鸕鴨鴞鴦鴒鴟鴝鴛鷽鴕鷥鷙鴯鴰鵂鴴鵃鴿鸞鴻鵐鵓鸝鵑鵠鵝鵒鷳鵜鵡鵲鶓鵪鵾鵯鵬鵮鶉鶊鵷鷫鶘鶡鶚鶻鶖鷀鶥鶩鷊鷂鶲鶹鶺鷁鶼鶴鷖鸚鷓鷚鷯鷦鷲鷸鷺䴉鸇鷹鸌鸏鸛鸘鹺麥麩麴麪麼黃黌黶黷黲黽黿鼂鼉鼴齊齏齒齔齕齗齟齡齙齠齜齦齬齪齲齷龍龔龕龜䃮䥑鿓鎶𠁞儣𠌥俓㒓𠏢儭𠠎剾𠞆𪟖勑嗰哯噅㘉嚧囃𡅏𡃕𡄔𡄣㗲𡓾𡑭壗𡔖壈㜷㜗㜢孎孻𡮉𡮣𡳳𦘧嵼𡽗嶈嶘㢝㦛𢤱𢣚𢣭愻憹𢠼憢懀㦎懎𤢻戰𢷮𢶫摋擫𢹿擣斅斸曥𣋋𦢈腪脥臗槫桱欍𣠲楇橯樤樠欓㰙㯤𣞻檭𣝕欘𣠩殢𣯴𣯩氭湋潕㵗澅𣿉𪷓𤅶濆灙𤁣瀃熓㷍爄熌爖熚熉㷿𤒎𤓩熡𤓎𤑳𤛮𤢟獩玁㺏瓕瓛𤳸癐𤸫㿗㿧皟麬䀉𥌃䀹𥊝瞤䁪䂎礒𥖅𥕥碙𥞵𥨐竚𥪂籅䉙籋篘𥵊𥸠䉲篸𥵃𥼽䊭𥽖𥿊緷綇綀繟緍縺緸𦂅䋿縎緰䌈𦃄䌋䌰縬繓䌖繏䌟䌝䌥繻䍽朥膢𦣎𦪽蓧䕳爇𦾟蘟𧕟䗿𧎈蠙蠀蠾𧔥䙱襰𧟀詀𧳟䞈買𧶔賬䝻賟贃𨇁躘𨄣𨅍𨈊𨈌䠱𨇞躝軉軗𨊻𨏠輄𨎮𨏥䢨𨣞𨣧𨢿𨣈𨤻鎷釳𨥛鈠鈋鈲鈯鉁龯銶鋉鍄𨧱錂鏆鎯鍮鎝𨫒鐄鏉鐎鐏𨮂䥩䦳𨳕𨳑閍閐䦘𨴗𨵩𨵸𨶀𨶏𨶲𨶮𨷲𨽏䧢䪏𩏪𩎢䪘䪗顂𩓣顃䫴颰𩗀䬞𩘹𩘀颷颾𩘺𩘝䬘䬝𩙈𩚛𩚥𩚵𩛆𩛩𩟐𩜦䭀䭃𩜇𩜵𩝔餸𩞄𩞦𩠴𩡣𩡺駎𩤊䮾駚𩢡䭿𩢾驋䮝𩥉駧𩢸駩𩢴𩣏𩣫駶𩣵𩣺䮠騔䮞驄騝騪𩤸𩤙䮫騟𩤲騚𩥄𩥑𩥇龭䮳𩧆䯤𩭙𩰀鬖𩯳𩰹𩳤𩴵魥𩵩𩵹鯶𩶱鮟𩶰鯄䲖鮸𩷰𩸃𩸦鯱䱙䱬䱰鱇𩽇䲰鳼𩿪𪀦鴲鴜𪁈鷨𪀾𪁖鵚𪂆𪃏𪃍鷔𪄕𪄆𪇳䴬麲麨䴴麳䵳𪔵𪘀𪘯𠿕凙㔋勣𧷎㓄𠬙唓㖮嚛𠽃噹嘺嘪噞嗹㗿嘳𡃄㘓𡃤𡂡嚽𡅯囒圞墲埬堚塿𡓁壣𧹈孇嬣嬻孾寠㞞屩崙𡸗輋巗𡹬㟺巊巘𡿖幝幩廬㢗廧𢍰彃徿𢤩㦞憸𢣐𢤿𢯷摐擟𢶒掚撊㨻㩋撧𢺳攋㪎曊膹梖櫅欐檵櫠欇𣜬欑毊霼濿溡𤄷𣽏㵾灒熂煇𤑹𤓌爥𤒻𤘀𤜆犞獊𤠮㺜猌瑽瓄瑻璝㻶𤬅畼𤳷痮𤷃㿖𤺔瘱盨睍眝矑矉𥏝𥖲礮𥗇𥜰𥜐䅐䅳𥢷䆉竱鴗𥶽䉑𥯤䉶𥴼簢簂䉬𥴨𥻦𩏷糺䊺紟䋃𥾯䋔絁絙絧絥繷繨纚𦀖綖絺䋦𦅇綟緤緮䋼𦃩縍繬縸縰繂𦅈繈繶纁纗䍤羵𦒀䎙𦔖聻𦟼𦡝𦧺艣𦱌蔿蒭蕽蕳葝蔯蕝薆藷䗅蠦蟜𧒯蟳蟂蟘䙔襗襓襘襀襵𧞫覼覛𧡴𧢄覹䚩𧭹訑訞訜詓諫𧦝𧦧䛄詑譊詷譑誂譨誺誫諣誋䛳誷𧩕誳諴諰諯謏諥謱謸𧩼謉謆謯𧫝譆𧬤譞𧭈譾豵貗贚䝭𧸘賝䞋贉贑䞓䟐䟆𧽯䟃䠆蹳蹻𨂐蹔𨇽𨆪𨇰𨇤軏軕轣軜軷軨軬𨎌軿𨌈輢輖輗輨輷輮𨍰轊轇轐轗轠遱鄟鄳醶釟釨鈇鈛鏦鈆𨥟鉔鉠𨪕銈銊鐈銁𨰋鉾鋠鋗𫒡錽錤鐪錜𨨛錝錥𨨢鍊鐼鍉𨰲鍒鎍䥯鎞鎙𨰃鏥䥗鏾鐇鐍𨬖𨭸𨭖𨮳𨯟鑴𨰥𨲳開閒閗閞𨴹閵䦯闑𨼳𩀨霣𩅙靧䪊鞾𩎖韠𩏂韛韝𩏠𩑔䪴䪾𩒎顗頫䫂䫀䫟頵𩔳𩓥顅𩔑願顣䫶䫻𩗓𩗴䬓飋𩟗飦䬧餦𩚩飵飶𩛌餫餔餗𩛡饠餧餬餪餵餭餱䭔䭑𩝽饘饟馯馼駃駞駊駤駫駻騃騉騊騄騠騜騵騴騱騻䮰驓驙驨鬠𩯁鱮魟鰑鱄魦魵𩶁䱁䱀鮅鮄鮤鮰鰤鮆鮯𩻮鯆鮿鮵䲅𩸄鯬𩸡䱧鯞鰋鯾鰦鰕鰫鰽𩻗𩻬鱊鱢𩼶鱲鳽鳷鴀鴅鴃鸗𩿤鴔鸋鴥鴐鵊鴮𪀖鵧鴳鴽鶰䳜鵟䳤鶭䳢鵫鵰鵩鷤鶌鶒鶦鶗𪃧䳧𪃒䳫鷅𪆷鷐鷩𪅂鷣鷷䴋𪉸麷䴱𪌭䴽𪍠䵴𪓰䶕齧齩𫜦齰齭齴𪙏齾龓䶲㑮𠐊㛝㜐媈嬦𡟫婡嬇孆孄嶹𦠅潣澬㶆灍爧爃𤛱㹽珼璾𤩂璼璊𥢶絍綋綡緟𦆲䖅䕤訨詊譂誴䜖䡐䡩䡵𨞺𨟊釚釲鈖鈗銏鉝鉽鉷䤤銂鐽𨧰𨩰鎈䥄鑉閝韚頍𩖰䫾䮄騼𩦠𩵦魽䱸鱆𩿅齯僤𣍐𪋿噁㘔塸埨𡑍墠娙㠣嵽廞彄暐晛梜櫍澫浿漍熰燖燀瓅璗璕礐𥗽篢紃紞絪綎綄綪綝綧縯纆纕蔄䓣蘋虉蝀訏詝諓詪諲諟譓軝輶鄩醲釴錀鋹釿鉥鉮鑪鉊鉧𨧀鋐錞𨨏鍭鎓鏏鏚䥕𨭎𨭆鏻鐩闉隑隮隤頔頠駓駉駪駼騑騞驎鮈鮀鮠鮡鯻鰊鱀鰶鱚鵏鶠鸑鶱鷟鷭鷿齘齮齼繐菕譅𰻞鋂鑀𪈼");
    const characters = new Map(source.map((key, index) => [key, target[index]]));
    const phrases = {"斗六":"斗六","斗六市":"斗六市","斗南":"斗南","斗南镇":"斗南鎮","后里":"后里","台州":"台州","台州市":"台州市","台州地区":"台州地區","台山":"台山","台山市":"台山市","仙台":"仙台","台北":"臺北","台北市":"臺北市","台中":"臺中","台中市":"臺中市","台湾":"臺灣","台湾省":"臺灣省","台东":"臺東","台东县":"臺東縣","台东市":"臺東市","台南":"臺南","台南市":"臺南市","台西":"臺西","云林":"雲林","云林县":"雲林縣","苗栗":"苗栗","钓鱼台":"釣魚臺","新德里":"新德里","德里":"德里","里约热内卢":"里約熱內盧","里约":"里約","里斯本":"里斯本","马德里":"馬德里","布里斯班":"布里斯班","布里奇顿":"布里奇頓","卡尔加里":"卡爾加里","里贾纳":"里賈納","里昂":"里昂","佛罗里达":"佛羅里達","佛罗里达州":"佛羅里達州","萨里":"薩里","萨里郡":"薩里郡","阿里山":"阿里山","阿里地区":"阿里地區","首尔":"首爾","胡志明市":"胡志明市","曼谷":"曼谷","蒙特利尔":"蒙特利爾","巴厘岛":"巴厘島","乌干达":"烏干達","于都":"于都","于都县":"于都縣","于田":"于田","于田县":"于田縣","于洪区":"于洪區","沈阳":"瀋陽","沈阳市":"瀋陽市","沈北新区":"瀋北新區","沈河":"瀋河","沈河区":"瀋河區","沈丘县":"沈丘縣","谷关":"谷關","硅谷":"硅谷"};
    const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const words = Object.keys(phrases).sort((a, b) => b.length - a.length).map(escape);
    const pattern = new RegExp(words.join("|") + "|[\\s\\S]", "gu");
    _ipGeoHantConvert = value => value.replace(pattern, token =>
      Object.prototype.hasOwnProperty.call(phrases, token) ? phrases[token] : characters.get(token) || token);
  }
  return _ipGeoHantConvert(text);
}

const IP_DISPLAY_TEXT = {
  "IP 信息卡": ["IP 資訊卡", "IP information"],
  "IP 纯净度": ["IP 純淨度", "IP reputation"],
  "DNS 解析器": ["DNS 解析器", "DNS resolver"],
  "出口 IP": ["出口 IP", "Outbound IP"],
  "出口 IP⁴": ["出口 IP⁴", "Outbound IPv4"],
  "出口 IP⁶": ["出口 IP⁶", "Outbound IPv6"],
  "本地 IP": ["本機 IP", "Local IP"],
  "入口 IP": ["入口 IP", "Entry IP"],
  "IP 风控值": ["IP 風險值", "IP risk score"],
  "IP 类型": ["IP 類型", "IP type"],
  "风控": ["風險", "Risk"],
  "类型": ["類型", "Type"],
  "地区": ["地區", "Location"],
  "运营商": ["網路業者", "ISP"],
  "DNS 检测": ["DNS 檢測", "DNS check"],
  "DNS 地区": ["DNS 地區", "DNS location"],
  "流量统计": ["流量統計", "Traffic"],
  "指定策略": ["指定策略", "Selected policy"],
  "代理策略": ["代理策略", "Proxy policy"],
  "代理链": ["代理鏈", "Proxy chain"],
  "代理服务器 IP": ["代理伺服器 IP", "Proxy server IP"],
  "本机累计流量": ["本機累計流量", "Local traffic total"],
  "规则预测（{host}）": ["規則預測（{host}）", "Rule prediction ({host})"],
  "🔄 网络已切换": ["🔄 網路已切換", "🔄 Network changed"],
  "检测失败": ["檢測失敗", "Check failed"],
  "检测超时": ["檢測逾時", "Check timed out"],
  "API 请求超时": ["API 請求逾時", "API request timed out"],
  "IP 获取失败": ["IP 取得失敗", "IP lookup failed"],
  "无法获取本地或出口 IPv4": ["無法取得本機或出口 IPv4", "Unable to obtain local or outbound IPv4"],
  "检测异常": ["檢測異常", "Check error"],
  "未知卡片类型": ["未知卡片類型", "Unknown tile type"],
  "风险评分检测失败": ["風險評分檢測失敗", "Risk score lookup failed"],
  "无法获取直连公网 IP": ["無法取得直連公網 IP", "Unable to obtain the direct public IP"],
  "地区查询失败": ["地區查詢失敗", "Location lookup failed"],
  "运营商未知": ["網路業者未知", "Unknown ISP"],
  "DNS 解析器检测失败": ["DNS 解析器檢測失敗", "DNS resolver lookup failed"],
  "无法获取出口 IPv4": ["無法取得出口 IPv4", "Unable to obtain outbound IPv4"],
  "查询失败": ["查詢失敗", "Lookup failed"],
  "暂无有效评分": ["暫無有效評分", "No valid score"],
  "类型未知": ["類型未知", "Unknown type"],
  "来源未知": ["來源未知", "Unknown origin"],
  "未知": ["未知", "Unknown"],
  "未知（检测失败）": ["未知（檢測失敗）", "Unknown (check failed)"],
  "无泄露": ["無洩漏", "No leak"],
  "⚠️ 泄露!": ["⚠️ 洩漏!", "⚠️ Leak detected!"],
  "⚠️ DNS 泄露!": ["⚠️ DNS 洩漏!", "⚠️ DNS leak detected!"],
  "[IP 已隐藏]": ["[IP 已隱藏]", "[IP hidden]"],
  "[已隐藏]": ["[已隱藏]", "[hidden]"],
  "（ASN 组织）": ["（ASN 組織）", " (ASN organization)"],
  "极度纯净": ["極度純淨", "Very clean"],
  "纯净": ["純淨", "Clean"],
  "一般": ["一般", "Average"],
  "微风险": ["輕微風險", "Low risk"],
  "一般风险": ["一般風險", "Moderate risk"],
  "极度风险": ["極度風險", "Extreme risk"],
  "住宅 IP": ["住宅 IP", "Residential IP"],
  "机房 IP": ["機房 IP", "Datacenter IP"],
  "原生 IP": ["原生 IP", "Native IP"],
  "广播 IP": ["廣播 IP", "Broadcast IP"],
  "住宅": ["住宅", "Residential"],
  "机房": ["機房", "Datacenter"],
  "原生": ["原生", "Native"],
  "广播": ["廣播", "Broadcast"]
};

function t(key, values = {}, language = args.lang) {
  key = String(key ?? "");
  const translations = Object.prototype.hasOwnProperty.call(IP_DISPLAY_TEXT, key) ? IP_DISPLAY_TEXT[key] : null;
  const text = translations && language === "zh-Hant" ? translations[0]
    : translations && language === "en" ? translations[1] : key;
  return text.replace(/\{([a-z]+)\}/gi, (token, name) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : token);
}

function displayLabel(key, values) {
  return t(key, values) + (args.lang === "en" ? ": " : "：");
}

// Apply only to the canonical type enum returned by getIPType/getStashRiskResult.
function renderIPType(value) {
  return String(value || "").split(/( · | \| )/).map(part => t(part)).join("");
}

function renderASNOrganization(info, fallback = "Unknown") {
  const value = info?.org || fallback;
  const suffix = "（ASN 组织）";
  return info?.org_source === "surge-asn" && value.endsWith(suffix)
    ? value.slice(0, -suffix.length) + t(suffix) : value;
}

function field(key, value, values) {
  return displayLabel(key, values) + value;
}

function displayGeoText(value, scope = "remote") {
  if (!value || args.lang !== "zh-Hant") return value;
  const automatic = scope === "dns" || (scope === "local" ? args.localGeoAuto : args.remoteGeoAuto);
  return automatic ? toTraditionalGeo(String(value)) : value;
}

function displayGeo(countryCode, scope, ...parts) {
  return formatGeo(countryCode, ...parts.map(value => displayGeoText(value, scope)));
}

function displayStashGeo(countryCode, scope, location) {
  return [flag(countryCode), displayGeoText(location, scope)].filter(Boolean).join(" ");
}

function displayDNSGeo(value) {
  if (!value) return value;
  const parts = String(value).split(" - ");
  parts[0] = displayGeoText(parts[0], "dns");
  return parts.join(" - ");
}


if (!(isStash && args.task === "logs")) IPLog.log("触发类型: " + (args.isEvent ? "EVENT" : "MANUAL") + ", risk_api: " + (args.riskApi || "fallback") + ", 本地: " + args.localGeoApi + ", 通知: " + args.notify);

// ==================== 全局状态控制 ====================
let finished = false;
let watchdog = null;
const requestDeadline = Date.now() + CONFIG.timeout - 250;

function done(o) {
  if (finished) return;
  finished = true;
  if (watchdog !== null && typeof clearTimeout === "function") clearTimeout(watchdog);
  if (isStash && (args.task === "monitor" || args.task === "logs")) {
    $done({});
  } else if (isStash) {
    $done({
      title: o.title || t(stashTiles[args.tile]?.title || "IP Security"),
      content: o.content || t("检测失败"),
      backgroundColor: o.backgroundColor || o["icon-color"] || "#9E9E9E",
      url: o.url || "https://ippure.com"
    });
  } else {
    $done(o);
  }
}

if (hasTimers && !(isStash && args.task === "logs")) {
  watchdog = setTimeout(() => {
    done({ title: t("检测超时"), content: t("API 请求超时"), icon: "leaf", "icon-color": "#9E9E9E" });
  }, CONFIG.timeout);
}

// ==================== HTTP 工具 ====================
function logHTTPFailure(url, status, error) {
  // 只记录站点和错误类别；完整 URL 可能含 IP 或 API Key。
  const host = url === CONFIG.urls.ipType ? "my.ippure.com/v1/info" :
    url === CONFIG.urls.ipTypeCard ? "my.ippure.com/v1/card" :
    String(url).match(/^https?:\/\/([^/?#]+)/)?.[1] || "API";
  const detail = String(error || "");
  const reason = error ? (/script wait deadline/i.test(detail) ? "脚本等待期限已到" :
    /timeout|timed out/i.test(detail) ? "请求超时" :
    /dns|resolve|lookup/i.test(detail) ? "DNS 解析失败" :
    /invalid JSON/i.test(detail) ? "JSON 响应无效" :
    /tls|ssl|certificate/i.test(detail) ? "TLS 连接失败" : "网络请求失败") :
    (status ? "HTTP " + status : "无有效响应");
  IPLog.log("[IP HTTP] " + host + "：" + reason);
}

function httpRaw(url, policy, headers, deadline = requestDeadline) {
  const remaining = Math.min(deadline, requestDeadline) - Date.now();
  if (finished || remaining < 100) return Promise.resolve(null);
  return new Promise(resolve => {
    let req = { url };
    const nativeIPPure = isStash && url === CONFIG.urls.ipType;
    let settled = false, timer = null;
    const complete = (error, response, data) => {
      if (settled) return;
      settled = true;
      if (timer !== null && typeof clearTimeout === "function") clearTimeout(timer);
      const status = Number(response?.status || response?.statusCode);
      if (error || !(status >= 200 && status < 300)) logHTTPFailure(url, status, error);
      resolve(!error && status >= 200 && status < 300 ? (data || null) : null);
    };
    if (headers) req.headers = { ...headers };
    if (isStash) {
      // IPPure 与官方脚本一样使用原生 HTTP 默认值；其他请求的 timeout 单位为秒。
      if (!nativeIPPure) req.timeout = Math.min(5, remaining / 1000);
      const selected = policy || args.proxy;
      if (selected) req.headers = { ...req.headers, "X-Stash-Selected-Proxy": encodeURIComponent(selected) };
      // 不用新增的 5 秒脚本截止截断 IPPure；保留总期限，避免原生请求不回调时挂起。
      if (hasTimers) timer = setTimeout(() => complete("script wait deadline", null, null),
        nativeIPPure ? remaining : Math.min(5000, remaining));
      if (nativeIPPure && !req.headers) req = url;
    } else {
      if (policy) req.policy = policy;
      // 分级地理查询需在单次请求超时后继续回退；总期限仍由看门狗控制。
      if (deadline !== requestDeadline) {
        req.timeout = remaining / 1000;
        if (hasTimers) timer = setTimeout(() => complete("script wait deadline", null, null), remaining);
      }
    }
    try {
      $httpClient.get(req, complete);
    } catch (error) { complete(error, null, null); }
  });
}

async function httpJSON(url, policy, headers, deadline) {
  const raw = await httpRaw(url, policy, headers, deadline);
  try { return raw ? JSON.parse(raw) : null; }
  catch (_) { logHTTPFailure(url, 0, "invalid JSON"); return null; }
}

function wait(ms) {
  return hasTimers ? new Promise(r => setTimeout(r, ms)) : Promise.resolve();
}

function surgeAPI(method, path) {
  if (isStash || typeof $httpAPI !== "function") return Promise.resolve(null);
  return new Promise(r => {
    $httpAPI(method, path, null, res => r(res));
  });
}

// 本机控制 API 仅供首页/通知显式启用；折叠节点测试不会访问它。
function stashControlAPI(path, deadline) {
  if (!args.stashAPI || !args.stashAPISecret || /[\r\n]/.test(args.stashAPISecret)) return Promise.resolve(null);
  const base = args.stashAPIURL.match(/^(https?):\/\/(127\.0\.0\.1|localhost|\[::1\])(?::(\d{1,5}))?\/?$/i);
  if (!base || (base[3] && (+base[3] < 1 || +base[3] > 65535))) {
    IPLog.log("[Stash API] 地址须为本机回环地址");
    return Promise.resolve(null);
  }
  const remaining = Math.min(deadline, requestDeadline) - Date.now();
  if (finished || remaining < 100) return Promise.resolve(null);
  return new Promise(resolve => {
    let settled = false, timer = null;
    const complete = (error, response, body) => {
      if (settled) return;
      settled = true;
      if (timer !== null && typeof clearTimeout === "function") clearTimeout(timer);
      let data = null;
      if (!error && Number(response?.status || response?.statusCode) === 200) {
        try { data = JSON.parse(body); } catch (_) {}
      }
      if (!data && !finished) IPLog.log("[Stash API] " + path.split("?")[0].split("/").slice(0, 2).join("/") + " 不可用，保留常规检测结果");
      resolve(data);
    };
    if (hasTimers) timer = setTimeout(() => complete("timeout"), remaining);
    try {
      $httpClient.get({ url: args.stashAPIURL.replace(/\/$/, "") + path,
        headers: { Authorization: "Bearer " + args.stashAPISecret, "X-Stash-Selected-Proxy": "DIRECT" },
        timeout: remaining / 1000, "auto-cookie": false, "auto-redirect": false
      }, complete);
    } catch (_) { complete("request failed"); }
  });
}

async function getStashControlContext() {
  if (!args.stashAPI || !args.stashAPISecret) return null;
  const exit = await fetchOutbound4();
  if (finished) return null;
  const host = exit?.probeHost;
  const deadline = Date.now() + 1500;
  const [connections, route] = await Promise.all([
    stashControlAPI("/connections", deadline),
    host && !args.proxy ? stashControlAPI("/rules/match?target=" + encodeURIComponent(host) + "&port=443&network=tcp&resolve=true", deadline) : null
  ]);
  if (finished) return null;
  // /rules/match 是当前规则的预测结果，不是其他服务的线路，也不等同于已建立连接。
  const policy = typeof route?.outbound === "string" && route.outbound.trim() &&
    !/^unknown$/i.test(route.outbound.trim()) ? route.outbound.trim() : "";
  const chain = Array.isArray(route?.chain) && route.chain.every(item => typeof item === "string") ? route.chain : [];
  const totals = connections && [connections.uploadTotal, connections.downloadTotal];
  const traffic = totals?.every(value => Number.isFinite(value) && value >= 0)
    ? { upload: totals[0], download: totals[1] } : null;
  let entranceIP = "";
  if (policy && !/^(?:DIRECT|REJECT(?:-DROP)?)$/i.test(policy)) {
    const info = await stashControlAPI("/proxies/" + encodeURIComponent(policy) + "/info", deadline);
    // 只接受接口明确提供的服务器 IP；域名、出口 IP 和连接 destinationIP 均不代用。
    entranceIP = stashCacheIP(info?.serverIP || info?.server);
  }
  if (!policy && !traffic) return null;
  return { host, policy, chain, entranceIP, traffic };
}

// 单次运行内去重：Stash 出口、评分和类型与官方卡片一样取自同一份 IPPure 数据。
// 不跨刷新缓存此响应，避免节点切换后沿用另一个出口。
let _ippureInfoP = null, _ippureCardP = null, _ippureCardFailed = false;
// 仅用于诊断输出；遵循 IP 打码参数，并隐藏响应中的凭据或跳转参数。
function ippureLogText(value) {
  const text = typeof value === "string" ? value : value?.byteLength !== undefined ? "[二进制正文]" : JSON.stringify(value);
  return (text || "").slice(0, 2400)
    .replace(/("[^"\r\n]*(?:token|secret|password|key|cookie|authorization)[^"\r\n]*"\s*:\s*")[^"]*/gi, "$1[已隐藏]")
    .replace(/([?&][^=\s"'<>]+=)[^&\s"'<>]*/g, "$1[已隐藏]")
    .replace(/(?:\d{1,3}\.){3}\d{1,3}|(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}/gi,
      value => stashCacheIP(value) ? maskIP(value, args.maskIP) : value)
    .replace(/[\r\n\t]+/g, " ").slice(0, 600);
}
function getIPPureInfo() {
  return _ippureInfoP || (_ippureInfoP = httpJSON(CONFIG.urls.ipType).then(info => {
    const ip = stashCacheIP(info?.ip);
    if (!isStash) IPLog.log("IPPure /v1/info 返回地址: " + (ip ? maskIP(ip, args.maskIP) : "未返回有效 IP") +
      "; 地址族=" + (ip ? (ip.includes(":") ? "IPv6" : "IPv4") : "无法确认"));
    IPLog.log(info ? "IPPure /v1/info 分类字段: " + JSON.stringify({
      isResidential: info.isResidential, isBroadcast: info.isBroadcast
    }).slice(0, 200) : "IPPure /v1/info 未取得有效 JSON 响应");
    if (!isStash && info && info.isResidential === undefined) IPLog.log("IPPure /v1/info 响应摘要: " + ippureLogText(info));
    return info;
  }));
}
function getIPPureCard() {
  if (isStash) return _ippureCardP || (_ippureCardP = httpRaw(CONFIG.urls.ipTypeCard));
  // Surge card 直接读取原生回调正文；HTTP 错误仍保留正文，失败标记用于阻止缓存。
  return _ippureCardP || (_ippureCardP = new Promise(resolve => {
    try {
      $httpClient.get({ url: CONFIG.urls.ipTypeCard }, (error, response, data) => {
        const status = Number(response?.status || response?.statusCode);
        const contentType = Object.entries(response?.headers || {}).find(([name]) => name.toLowerCase() === "content-type")?.[1] || "未提供";
        IPLog.log("IPPure /v1/card 响应: HTTP=" + (status || 0) + "; Content-Type=" + contentType +
          "; 正文类型=" + Object.prototype.toString.call(data) + "; 长度=" + (data?.length || data?.byteLength || 0));
        IPLog.log("IPPure /v1/card 正文摘要: " + ippureLogText(data));
        _ippureCardFailed = !!error || !(status >= 200 && status < 300);
        if (_ippureCardFailed) logHTTPFailure(CONFIG.urls.ipTypeCard, status, error);
        resolve(data || null);
      });
    } catch (error) {
      _ippureCardFailed = true;
      logHTTPFailure(CONFIG.urls.ipTypeCard, 0, error);
      resolve(null);
    }
  }));
}
// 同轮摘要的出口与风险回退共用一次 IPv4 探测，不跨运行保存。
let _stashOutbound4P = null;

// ProxyCheck 请求去重：风险评分和 IP 类型回退共享同一个请求
let _proxyCheckP = null;
function getProxyCheck(ip) { return _proxyCheckP || (_proxyCheckP = httpJSON(CONFIG.urls.proxyCheck(ip))); }

// ==================== 数据处理工具 ====================
function flag(cc) {
  if (!cc || cc.length !== 2) return "";
  cc = cc.toUpperCase();
  if (cc === "TW" && args.twFlag !== "tw") cc = "CN";
  const b = 0x1f1e6;
  return String.fromCodePoint(b + cc.charCodeAt(0) - 65, b + cc.charCodeAt(1) - 65);
}

function riskText(score) {
  if (score === null || score === undefined || !Number.isFinite(Number(score))) {
    return { label: "检测失败", color: "#9E9E9E" };
  }
  const level = CONFIG.riskLevels.find(l => score <= l.max) || CONFIG.riskLevels.at(-1);
  return { label: level.label, color: level.color };
}

function formatRisk(info) {
  if (info.score === null || info.score === undefined) return t("未知（检测失败）");
  return info.score + "% " + t(riskText(info.score).label) + " (" + info.source + ")";
}

function maskIP(ip, mode) {
  if (!ip || !mode) return ip;
  if (mode === 2) return t("[IP 已隐藏]");
  if (ip.includes(":")) {
    if (ip.includes("::")) {
      // :: 压缩记法（如 2001:db8::1）：真实分段数不固定，无法按未压缩地址逐段打码，
      // 仅显示首尾各一段，中间（含被压缩的隐藏段）统一用 ** 代替
      const [left = "", right = ""] = ip.split("::");
      const leftGroups = left ? left.split(":") : [];
      const rightGroups = right ? right.split(":") : [];
      const first = leftGroups[0] || rightGroups[0];
      const last = rightGroups.at(-1) || leftGroups.at(-1);
      if (!first || !last) return ip;
      return first === last ? "::" + first : first + "::**:" + last;
    }
    const parts = ip.split(":");
    if (parts.length <= 2) return ip;
    return parts[0] + ":" + parts.slice(1, -1).map(() => "**").join(":") + ":" + parts.at(-1);
  }
  const parts = ip.split(".");
  if (parts.length !== 4) return ip;
  return parts[0] + ".***.***." + parts[3];
}

function formatGeo(countryCode, ...parts) {
  const unique = parts.filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
  return flag(countryCode) + " " + unique.join(", ");
}

function normalizeIpSb(data) {
  if (!data || !data.country_code) return null;
  return {
    country_code: data.country_code,
    country_name: data.country,
    city: data.city,
    region: data.region,
    org: data.organization
  };
}

function normalizeIpInfo(data) {
  if (!data || !data.country) return null;
  return {
    country_code: data.country,
    country_name: data.country,
    city: data.city,
    region: data.region,
    org: data.org ? data.org.replace(/^AS\d+\s*/, "") : ""
  };
}

/**
 * 将 ip-api.com 返回字段归一化为内部格式
 * ip-api.com: { status:"success", country, countryCode, regionName, city, isp, org }
 */
function normalizeIpApi(data) {
  if (!data || data.status !== "success") return null;
  return {
    country_code: data.countryCode,
    country_name: data.country,
    city: data.city,
    region: data.regionName,
    org: data.isp || data.org || ""
  };
}

/**
 * 将百度 opendata 返回归一化为内部格式
 * opendata 6006: { status:"0", data:[{ location:"广东省深圳市 移动" }] }
 * location 首段为地理（整体放 country_name 供中文显示），其余为运营商；
 * country_code 无法提供，由调用方回填（本地默认 CN）
 */
function normalizeOpendata(data) {
  const loc = data?.data?.[0]?.location;
  if (!loc) return null;
  const parts = String(loc).trim().split(/\s+/);
  return {
    country_code: null,
    country_name: parts[0] || "",
    city: "",
    region: "",
    org: parts.slice(1).join(" ")
  };
}

// Basic Auth 用 base64（Surge JSC 无内建 btoa，凭据为 ASCII）
function b64(s) {
  if (typeof btoa !== "undefined") return btoa(s);
  const c = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < s.length; i += 3) {
    const c1 = s.charCodeAt(i), c2 = s.charCodeAt(i + 1), c3 = s.charCodeAt(i + 2);
    out += c[c1 >> 2] + c[((c1 & 3) << 4) | (isNaN(c2) ? 0 : c2 >> 4)]
      + (isNaN(c2) ? "=" : c[((c2 & 15) << 2) | (isNaN(c3) ? 0 : c3 >> 6)])
      + (isNaN(c3) ? "=" : c[c3 & 63]);
  }
  return out;
}

/**
 * 将 MaxMind GeoLite2 city 返回归一化为内部格式
 * geolite.info/geoip/v2.1/city: { country:{iso_code,names}, city:{names}, subdivisions:[{names}] }
 * zhFirst=true 时中文名优先、缺失回落英文（maxmind-zh），否则英文（maxmind）
 */
function normalizeMaxmind(data, zhFirst) {
  if (!data || !data.country?.iso_code) return null;
  const pick = n => (zhFirst ? (n?.["zh-CN"] || n?.en) : n?.en) || "";
  return {
    country_code: data.country.iso_code,
    country_name: pick(data.country.names),
    city: pick(data.city?.names),
    region: pick(data.subdivisions?.[0]?.names),
    org: ""
  };
}

function normalizeBilibili(data) {
  const d = data?.data;
  if (!d || !d.country) return null;
  let isp = d.isp || "";
  if (/^(移动|联通|电信|广电)$/.test(isp)) isp = "中国" + isp;
  return {
    country_code: null,
    country_name: d.country,
    city: d.city || "",
    region: d.province,
    org: isp
  };
}

// 仅限本轮、同一明确 IP；失败不保留，Stash 不访问 Surge API。
const surgeGeoLookups = new Map();
function validGeoText(value) {
  return typeof value === "string" && value.trim() &&
    !/^(?:unknown|undefined|null|n\/a|error|timeout|未知|错误|查询失败|检测失败|请求失败|运营商未知)$/i.test(value.trim());
}

function getSurgeLocalGeo(ip) {
  const address = stashCacheIP(ip);
  const remaining = Math.min(500, requestDeadline - Date.now());
  if (isStash || typeof $httpAPI !== "function" || !hasTimers || finished || !address || remaining < 100) {
    return Promise.resolve(null);
  }
  if (surgeGeoLookups.has(address)) return surgeGeoLookups.get(address);
  const lookup = new Promise(resolve => {
    let settled = false, timer = null;
    const complete = response => {
      if (settled) return;
      settled = true;
      if (timer !== null && typeof clearTimeout === "function") clearTimeout(timer);
      let data = response;
      if (typeof data === "string") {
        try { data = JSON.parse(data); } catch (_) { data = null; }
      }
      if (finished || !data || data.error || stashCacheIP(data.address) !== address) return resolve(null);
      const country = typeof data.country === "string" ? data.country.trim().toUpperCase() : "";
      const asn = Number.isInteger(data.asn) && data.asn > 0 && data.asn <= 4294967295 ? data.asn : null;
      const organization = validGeoText(data.organization) ? data.organization.trim() : "";
      const result = {
        country_code: /^[A-Z]{2}$/.test(country) && !["XX", "ZZ"].includes(country) ? country : "",
        asn, asn_organization: organization
      };
      resolve(result.country_code || result.asn || result.asn_organization ? result : null);
    };
    timer = setTimeout(() => complete(null), remaining);
    try { $httpAPI("GET", "/v1/geoip?ip=" + encodeURIComponent(address), null, complete); }
    catch (_) { complete(null); }
  }).then(result => {
    if (!result) surgeGeoLookups.delete(address);
    return result;
  });
  surgeGeoLookups.set(address, lookup);
  return lookup;
}

async function withSurgeGeoFallback(ip, info) {
  const country = typeof info?.country_code === "string" ? info.country_code.trim().toUpperCase() : "";
  const hasCountry = /^[A-Z]{2}$/.test(country) && !["XX", "ZZ"].includes(country);
  const hasOrg = validGeoText(info?.org);
  if (isStash || (hasCountry && hasOrg)) return info;
  const local = await getSurgeLocalGeo(ip);
  if (!local) return info;
  if ((hasCountry || !local.country_code) && (hasOrg || (!local.asn_organization && !local.asn))) return info;
  const result = { ...(info || {}) };
  if (!hasCountry && local.country_code) {
    result.country_code = local.country_code;
    if (!validGeoText(result.country_name)) result.country_name = local.country_code;
  }
  if (!hasOrg && (local.asn_organization || local.asn)) {
    // ASN 组织不等同于具体 ISP，保留来源标记并在现有运营商行内明确说明。
    result.org = (local.asn_organization || "AS" + local.asn) + "（ASN 组织）";
    result.org_source = "surge-asn";
  }
  if (local.asn) result.asn = local.asn;
  if (local.asn_organization) result.asn_organization = local.asn_organization;
  IPLog.log("本机 GeoIP：补充既有来源缺失的国家/ASN 信息");
  return result;
}

async function getLocalGeo(local) {
  const ip = local?.data?.addr;
  if (!ip) return { info: null, source: "" };
  const defaults = ["baidu", "bilibili", "ipsb"];
  const preferred = defaults.includes(args.localGeoApi) ? args.localGeoApi : "baidu";
  const order = [preferred, ...defaults.filter(source => source !== preferred)];
  const policy = isStash ? "DIRECT" : undefined;
  // ip.sb 同时补充国家代码；bilibili 复用本轮获取本地 IP 的响应。
  const sbPromise = httpJSON(CONFIG.urls.ipSbGeo(ip), policy, null, Date.now() + 5000);
  let info = null, source = "";
  for (source of order) {
    IPLog.log("本地地区：尝试 " + source);
    info = source === "baidu" ? normalizeOpendata(await httpJSON(CONFIG.urls.baiduGeo(ip), policy, null, Date.now() + 2000))
      : source === "bilibili" ? normalizeBilibili(local) : normalizeIpSb(await sbPromise);
    if (info && [info.country_code, info.country_name, info.region, info.city].some(value => typeof value === "string" && value.trim())) break;
    info = null;
    IPLog.log("本地地区：" + source + " 无有效地区，继续回退");
  }
  const sb = normalizeIpSb(await sbPromise);
  if (info && source !== "ipsb") {
    if (/^(移动|联通|电信|广电)$/.test(info.org)) info.org = "中国" + info.org;
    info.country_code = sb?.country_code || (source === "bilibili" && info.country_name !== "中国" ? "" : "CN");
  }
  if (info) IPLog.log("本地地区：采用 " + source);
  const remoteInfo = info;
  info = await withSurgeGeoFallback(ip, info);
  if (!remoteInfo && info) source = "surge";
  return { info, source };
}

async function getOutboundGeo(ip, probeInfo, pureInfo) {
  const defaults = isStash ? ["ipapi-zh", "ipapi", "ipinfo"] : ["ipapi-zh", "ipapi", "ipinfo", "maxmind"];
  const allowed = [...defaults, ...(isStash ? ["ippure"] : ["maxmind-zh"])];
  const preferred = allowed.includes(args.remoteGeoApi) ? args.remoteGeoApi : "ipapi-zh";
  // MaxMind 中英文使用同一个接口，指定中文时替换默认英文级，不重复查询。
  const order = [preferred, ...defaults.filter(source => source !== preferred &&
    !(source === "maxmind" && preferred === "maxmind-zh"))];
  // ipinfo 还用于运营商/rDNS，预先发起并在地区回退时复用，不改变地区选用顺序。
  const orgPromise = httpJSON(CONFIG.urls.ipInfo(ip), undefined, null, Date.now() + 5000);
  let info = null;
  for (const source of order) {
    if (source.startsWith("maxmind") && !args.maxmindKey) {
      IPLog.log("出口地区：跳过 " + source + "（未填写 maxmind_key）");
      continue;
    }
    IPLog.log("出口地区：尝试 " + source);
    if (source === "ippure") info = pureInfo;
    else if (source === "ipinfo") info = normalizeIpInfo(await orgPromise);
    else if (source.startsWith("maxmind")) info = normalizeMaxmind(await httpJSON(
      CONFIG.urls.maxmindGeo(ip), undefined, { Authorization: "Basic " + b64(args.maxmindKey) }, Date.now() + 2000), source === "maxmind-zh");
    else info = normalizeIpApi(await httpJSON(CONFIG.urls.ipApi(ip, source === "ipapi-zh" ? "zh-CN" : "en"),
      undefined, null, Date.now() + 2000));
    if (info && [info.country_code, info.country_name, info.region, info.city].some(value => typeof value === "string" && value.trim())) {
      IPLog.log("出口地区：采用 " + source);
      break;
    }
    info = null;
    IPLog.log("出口地区：" + source + " 无有效地区，继续回退");
  }
  if (!info && probeInfo) {
    info = probeInfo;
    IPLog.log("出口地区：回退来源均无有效结果，保留本轮出口探测地区");
  }
  const org = await orgPromise, orgInfo = normalizeIpInfo(org);
  if (info && orgInfo?.org) info.org = orgInfo.org;
  info = await withSurgeGeoFallback(ip, info);
  return { info, reverseDNS: typeof org?.hostname === "string" ? org.hostname.trim() : "" };
}

function parseScamalyticsScore(html) {
  const m = html?.match(/Fraud Score[^0-9]*([0-9]{1,3})/i);
  return m ? Number(m[1]) : null;
}

// ==================== 代理策略与入口 IP 获取 ====================
/**
 * 从 Surge 最近请求中同时获取代理策略和入口 IP
 * 入口 IP 通过 remoteAddress 的 (Proxy) 后缀识别
 */
async function getPolicyAndEntrance() {
  if (isStash) return { policy: args.proxy || (args.mode === "collapsed" ? "当前检测出口" : "按规则分流"), entranceIP: null };
  const pattern = /(api(-ipv4)?\.ip\.sb|ipinfo\.io|ip-api\.com|\b1\.1\.1\.1\b|2606:4700|opendata\.baidu\.com|geolite\.info)/i;

  async function findInRecent(limit) {
    const res = await surgeAPI("GET", "/v1/requests/recent");
    return (res?.requests || []).slice(0, limit).find(i => pattern.test(i.URL));
  }

  let hit = await findInRecent(50);
  if (!hit) {
    IPLog.log("未找到策略记录，等待后重试 (1/2)");
    await wait(CONFIG.policyRetryDelay);
    hit = await findInRecent(50);
  }
  if (!hit) {
    IPLog.log("未找到策略记录，等待后重试 (2/2)");
    await wait(CONFIG.policyRetryDelay * 2);
    hit = await findInRecent(100);
  }

  const validPolicy = name => typeof name === "string" && name.trim() !== "" && !/^unknown$/i.test(name.trim());
  const policy = hit?.policyName;
  // 命中请求但缺少策略名时也回退；失败结果不能覆盖上次有效策略。
  if (!validPolicy(policy)) {
    const storedPolicy = $persistentStore.read(CONFIG.storeKeys.lastPolicy);
    const lastPolicy = validPolicy(storedPolicy) ? storedPolicy : null;
    IPLog.log(lastPolicy ? "使用上次保存的策略: " + lastPolicy : "无法找到任何策略信息");
    return { policy: lastPolicy || "Unknown", entranceIP: null };
  }

  $persistentStore.write(policy, CONFIG.storeKeys.lastPolicy);
  IPLog.log("找到代理策略: " + policy);

  let entranceIP = null;
  if (/\(Proxy\)/.test(hit.remoteAddress)) {
    entranceIP = hit.remoteAddress.replace(/\s*\(Proxy\)\s*/, "").replace(/:\d+$/, "");
    IPLog.log("找到入口 IP: " + entranceIP);
  }

  return { policy, entranceIP };
}

// ==================== 风险评分获取 ====================
// 优先尝试指定源，失败后继续其余源；Stash 默认 IPPure，指定其他源时复用此流程。
// Surge 不填或其他值 → IPQS → ProxyCheck → IPPure → Scamalytics；Stash 不使用 IPQS。
// Surge 缓存策略：出口 IP、risk_api、是否带 Key 均未变化，且缓存未超过 riskCacheTTL
// （默认 24 小时）且评分有效时直接复用；未知、错误或过期缓存重新查询
async function getRiskScore(ip) {
  const api = args.riskApi;
  const hasKey = !!args.ipqsKey;

  const cached = !isStash && $persistentStore.read(CONFIG.storeKeys.riskCache);
  if (cached) {
    try {
      const c = JSON.parse(cached);
      const age = Math.floor(Date.now() / 1000) - (c.ts || 0);
      if (c.ip === ip && (c.api || "") === api && !!c.hasKey === hasKey &&
          Number.isFinite(c.ts) && age >= 0 && age < CONFIG.riskCacheTTL &&
          typeof c.score === "number" && Number.isFinite(c.score) && c.score >= 0 && c.score <= 100 &&
          ["IPQS", "ProxyCheck", "IPPure", "Scamalytics"].includes(c.source)) {
        IPLog.log("风险评分命中缓存: " + c.score + "% (" + c.source + ")，已缓存 " + age + "s");
        return { score: c.score, source: c.source };
      }
    } catch (e) {}
  }

  function saveAndReturn(score, source) {
    if (!(typeof score === "number" || typeof score === "string" && score.trim())) return null;
    score = Number(score);
    if (!Number.isFinite(score) || score < 0 || score > 100) return null;
    IPLog.log("风险评分：采用 " + source);
    if (isStash || source === "IPPure" && _ippureCardFailed) return { score, source };
    $persistentStore.write(JSON.stringify({ ip, score, source, api, hasKey, ts: Math.floor(Date.now() / 1000) }), CONFIG.storeKeys.riskCache);
    IPLog.log("风险评分已缓存: " + score + "% (" + source + ")");
    return { score, source };
  }

  async function tryIPQS() {
    if (!args.ipqsKey) return null;
    const data = await httpJSON(CONFIG.urls.ipqs(args.ipqsKey, ip));
    if (data?.success && data?.fraud_score !== undefined) return saveAndReturn(data.fraud_score, "IPQS");
    IPLog.log("IPQS 失败: " + (data ? "success=" + data.success + " message=" + (data.message || "") : "请求失败"));
    return null;
  }

  async function tryProxyCheck() {
    const data = await getProxyCheck(ip);
    if (data?.[ip]?.risk !== undefined) return saveAndReturn(data[ip].risk, "ProxyCheck");
    IPLog.log("ProxyCheck 失败: " + (data ? JSON.stringify(data).slice(0, 100) : "请求失败"));
    return null;
  }

  async function tryIPPure() {
    const info = await getIPPureInfo();
    // IPPure 查询访问者自身；不能把另一路出口的评分套到指定 IP 上。
    if (isStash && stashCacheIP(info?.ip) !== ip) return null;
    if (info?.fraudScore !== undefined) return saveAndReturn(info.fraudScore, "IPPure");
    if (isStash) return null; // card HTML 没有可核验的目标 IP。
    IPLog.log("IPPure /v1/info 无 fraudScore，回落到 /v1/card");
    const html = await getIPPureCard();
    if (html) {
      const m = html.match(/(\d+)\s*%\s*(极度纯净|纯净|一般|微风险|一般风险|极度风险)/);
      if (m) return saveAndReturn(Number(m[1]), "IPPure");
    }
    IPLog.log("IPPure 风险评分获取失败");
    return null;
  }

  async function tryScamalytics() {
    const html = await httpRaw(CONFIG.urls.scamalytics(ip));
    const score = parseScamalyticsScore(html);
    if (score !== null) return saveAndReturn(score, "Scamalytics");
    IPLog.log("Scamalytics 失败: " + (html ? "解析失败" : "请求失败"));
    return null;
  }

  const tryMap = { ipqs: tryIPQS, proxycheck: tryProxyCheck, ippure: tryIPPure, scamalytics: tryScamalytics };
  if (api && !tryMap[api]) IPLog.log("未知 risk_api: " + api + "，按默认顺序回退");

  const defaults = isStash ? ["proxycheck", "ippure", "scamalytics"] : ["ipqs", "proxycheck", "ippure", "scamalytics"];
  const order = defaults.includes(api) ? [api, ...defaults.filter(key => key !== api)] : defaults;
  for (const key of order) {
    if (key === "ipqs" && !args.ipqsKey) {
      IPLog.log("风险评分：跳过 ipqs（未填写 ipqs_key）");
      continue;
    }
    IPLog.log("风险评分：尝试 " + key);
    const r = await tryMap[key]();
    if (r) return r;
  }

  // 所有数据源均失败：仅为本次展示返回未知状态，不写入缓存，
  // 避免一次性的临时故障被 24h TTL 放大成长期错误风控值
  IPLog.log("风险评分：所有数据源均失败，显示未知（不缓存）");
  return { score: null, source: "Unavailable" };
}

// ==================== Surge IP 类型检测：info → card → ProxyCheck ====================
// 类型与来源均已确认时，按出口 IP 最多缓存 24 小时；不完整结果仅供本次展示，
// 下次重新查询，也不复用旧版写入的“未知”缓存。
async function getIPType(ip) {
  const complete = (ipType, ipSrc) => ["住宅 IP", "机房 IP"].includes(ipType) &&
    ["广播 IP", "原生 IP"].includes(ipSrc);
  const cached = $persistentStore.read(CONFIG.storeKeys.ipTypeCache);
  if (cached) {
    try {
      const c = JSON.parse(cached);
      const age = Math.floor(Date.now() / 1000) - (c.ts || 0);
      if (c.ip === ip && Number.isFinite(c.ts) && age >= 0 && age < CONFIG.riskCacheTTL &&
          complete(c.ipType, c.ipSrc)) {
        IPLog.log("IP 类型命中缓存: " + c.ipType + " | " + c.ipSrc + "，已缓存 " + age + "s");
        IPLog.log("IPPure 地址族: 本次命中类型缓存，未请求接口；缓存未保存原响应 IP，无法确认");
        return { ipType: c.ipType, ipSrc: c.ipSrc };
      }
    } catch (e) {}
  }

  function saveAndReturn(ipType, ipSrc) {
    if (complete(ipType, ipSrc) && !_ippureCardFailed) {
      $persistentStore.write(JSON.stringify({ ip, ipType, ipSrc, ts: Math.floor(Date.now() / 1000) }), CONFIG.storeKeys.ipTypeCache);
    } else {
      IPLog.log("IP 类型、来源或请求未确认，仅展示本次结果（不缓存）");
    }
    return { ipType, ipSrc };
  }

  const info = await getIPPureInfo();
  const infoIP = stashCacheIP(info?.ip);
  IPLog.log("IPPure IP 对照: info=" + (infoIP ? maskIP(infoIP, args.maskIP) : "未取得 IP") +
    "; 面板出口IPv4=" + maskIP(ip, args.maskIP) + "; " + (infoIP ? (infoIP === ip ? "一致" : "不一致") : "无法确认"));
  if (info && info.isResidential !== undefined) {
    IPLog.log("IPPure /v1/info 返回 IP 类型数据");
    return saveAndReturn(
      info.isResidential ? "住宅 IP" : "机房 IP",
      info.isBroadcast ? "广播 IP" : "原生 IP"
    );
  }
  IPLog.log("IPPure /v1/info 未返回 IP 类型，回落到 /v1/card");

  const html = await getIPPureCard();
  const cardIPs = typeof html === "string" ? [...new Set((html.match(/(?:\d{1,3}\.){3}\d{1,3}|(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}/gi) || [])
    .map(value => stashCacheIP(value)).filter(Boolean))].slice(0, 4) : [];
  IPLog.log("IPPure /v1/card 正文 IP 候选: " + (cardIPs.length ? cardIPs.map(value =>
    maskIP(value, args.maskIP) + " (" + (value.includes(":") ? "IPv6" : "IPv4") + ")").join(", ") : "未取得，无法确认地址族") +
    "; 面板出口IPv4=" + maskIP(ip, args.maskIP));
  if (html) {
    const ipType = /住宅|[Rr]esidential/.test(html) ? "住宅 IP" : "机房 IP";
    const ipSrc = /广播|[Bb]roadcast|[Aa]nnounced/.test(html) ? "广播 IP" : "原生 IP";
    IPLog.log("IPPure /v1/card 抓取结果: " + ipType + " | " + ipSrc);
    return saveAndReturn(ipType, ipSrc);
  }

  // IPPure 全部失败后读取 ProxyCheck type；本轮已有请求则复用，否则发起一次。
  const pc = await getProxyCheck(ip);
  const pcType = pc?.[ip]?.type;
  if (pcType) {
    const ipType = /residential|wireless|mobile/i.test(pcType) ? "住宅 IP" : "机房 IP";
    IPLog.log("ProxyCheck type 回退: " + pcType + " → " + ipType);
    return saveAndReturn(ipType, "未知");
  }

  IPLog.log("IPPure/ProxyCheck 所有接口均失败");
  return { ipType: "未知", ipSrc: "未知" };
}

// ==================== DNS 泄露检测 ====================
async function checkDNSLeak(policy, deadline) {
  const c = "abcdefghijklmnopqrstuvwxyz0123456789";
  function randStr(len) { let s = ""; for (let i = 0; i < len; i++) s += c[Math.floor(Math.random() * c.length)]; return s; }

  // edns.ip-api.com：随机子域触发 DNS 查询，服务端返回解析器 IP 和地理信息
  const ednsData = await httpJSON(CONFIG.urls.dnsLeakEdns(randStr(32)), policy, null, deadline);
  if (!ednsData?.dns) {
    IPLog.log("DNS 泄露检测失败");
    return { leaked: null, resolvers: null };
  }
  const ip = ednsData.dns.ip || "";
  const geo = ednsData.dns.geo || "";
  const isChina = /China|中国/i.test(geo);
  const name = (geo.includes(" - ") ? geo.split(" - ").pop().trim() : (geo || ip)).replace(/\s*communications\s+corporation/gi, "");
  const resolvers = ip ? [{ ip, name, geo, isChina }] : [];
  // 既有启发式：解析器位于中国即作提示；未比较本地 ISP，不能证明有/无 DNS 泄露。
  const leaked = isChina;
  IPLog.log("DNS 解析器: " + (resolvers.length ? resolvers[0].name + (isChina ? " [CN]" : "") : "无"));
  return { leaked, resolvers: resolvers.length > 0 ? resolvers : null };
}

// ==================== 流量统计 ====================
function formatBytes(bytes) {
  if (!bytes || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0) + " " + units[i];
}

function formatDuration(seconds) {
  if (!seconds || seconds < 0) return "0s";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return h + "h " + m + "m";
  if (m > 0) return m + "m " + s + "s";
  return s + "s";
}

async function getTrafficStats() {
  if (isStash) return null;
  const data = await surgeAPI("GET", "/v1/traffic");
  if (!data) {
    IPLog.log("流量统计获取失败");
    return null;
  }
  IPLog.log("流量统计原始数据: " + JSON.stringify(data).slice(0, 300));

  // Surge 返回 interface 为嵌套字典 { en0: {...}, pdp_ip0: {...}, lo0: {...} }
  let network = null;
  if (data.interface && typeof data.interface === "object") {
    const keys = Object.keys(data.interface).filter(k => k !== "lo0");
    if (keys.length > 0) {
      network = data.interface[keys[0]];
      IPLog.log("使用网卡: " + keys[0]);
    }
  }
  if (!network) network = data.connector || data;
  const upload = network.out ?? 0;
  const download = network.in ?? 0;
  const rawStart = data.startTime;
  const startMs = rawStart
    ? (typeof rawStart === "number" && rawStart < 1e12 ? rawStart * 1000 : new Date(rawStart).getTime())
    : null;
  const duration = startMs ? Math.floor((Date.now() - startMs) / 1000) : null;

  return { upload, download, duration };
}

// ==================== IP 获取 ====================
// Cloudflare cdn-cgi/trace 纯文本响应（ip=x.x.x.x\nloc=US\n…）→ 对象
function parseTrace(text) {
  if (!text || typeof text !== "string" || !text.includes("ip=")) return null;
  const o = {};
  text.trim().split("\n").forEach(l => {
    const i = l.indexOf("=");
    if (i > 0) o[l.slice(0, i)] = l.slice(i + 1);
  });
  return o.ip ? o : null;
}

// 官方 IPPure Tile 使用的地理字段；只用于同一次响应确认的出口。
function normalizeStashIPPure(data) {
  const text = value => typeof value === "string" ? value.trim() : "";
  const code = text(data.countryCode).toUpperCase();
  return {
    country_code: /^[A-Z]{2}$/.test(code) ? code : "",
    country_name: text(data.country), city: text(data.city), region: text(data.region),
    org: text(data.asOrganization)
  };
}

// 按 Stash 官方 IPPure 卡片：请求经当前检测节点，IP、评分和类型来自它的响应。
// 缺少相应地址族时才用 ipify 补充 IP，不用另一站点的地址否定 IPPure 评分。
async function probeStashOutbound4() {
  const info = await getIPPureInfo();
  if (finished) return null;
  const ip = stashCacheIP(info?.ip);
  if (ip && !ip.includes(":")) return { ip, probeHost: CONFIG.urls.ipType.match(/^https?:\/\/([^/]+)/)[1] };
  if (requestDeadline - Date.now() < 100) return null;
  const deadline = Math.min(requestDeadline, Date.now() + CONFIG.stashIPv4Timeout);
  IPLog.log("IPPure 未提供有效 IPv4，使用 ipify 备用探测");
  const backup = await httpJSON(CONFIG.urls.stashIPv4, null, null, deadline);
  if (finished) return null;
  const backupIP = stashCacheIP(backup?.ip);
  return backupIP && !backupIP.includes(":") ? { ip: backupIP, probeHost: "api.ipify.org" } : null;
}

async function probeStashOutbound6() {
  const info = await getIPPureInfo();
  if (finished) return null;
  const pureIP = stashCacheIP(info?.ip);
  if (pureIP.includes(":")) return pureIP;
  const deadline = Date.now() + CONFIG.ipv6Timeout;
  const data = await httpJSON(CONFIG.urls.stashIPv6, null, null, deadline);
  if (finished) return null;
  const ip = stashCacheIP(data?.ip);
  if (ip.includes(":")) return ip;
  IPLog.log("IPv6 未探测到有效地址，仅展示 IPv4");
  return null;
}

// Surge 保持原有 Cloudflare trace → ip.sb。
async function fetchOutbound4() {
  if (isStash) {
    return _stashOutbound4P || (_stashOutbound4P = probeStashOutbound4());
  }
  const t = parseTrace(await httpRaw(CONFIG.urls.outboundTrace));
  if (t) return { ip: t.ip, raw: { country_code: t.loc, country: t.loc } };
  IPLog.log("CF trace(v4) 失败，回落 ip.sb");
  const sb = await httpJSON(CONFIG.urls.outboundIP);
  return sb?.ip ? { ip: sb.ip, raw: sb } : null;
}

async function fetchOutbound6() {
  if (isStash) {
    return probeStashOutbound6();
  }
  const deadline = Date.now() + CONFIG.ipv6Timeout;
  const t = parseTrace(await httpRaw(CONFIG.urls.outboundTrace6, null, null, deadline));
  if (t) return t.ip;
  IPLog.log("CF trace(v6) 失败，回落 ip.sb");
  const sb = await httpJSON(CONFIG.urls.outboundIPv6, null, null, deadline);
  return sb?.ip || null;
}

async function fetchIPs() {
  const [local, exit, exit6ip] = await Promise.all([
    httpJSON(CONFIG.urls.localIP, "DIRECT"),
    fetchOutbound4(),
    !isStash && hasTimers ? Promise.race([
      fetchOutbound6(),
      wait(CONFIG.ipv6Timeout).then(() => null)
    ]) : fetchOutbound6()
  ]);

  const hasIPv6 = exit6ip && exit6ip.includes(":");

  return {
    localIP: local?.data?.addr || null,
    outIP: exit?.ip || null,
    outIPv6: hasIPv6 ? exit6ip : null,
    localRaw: local,
    outRaw: exit?.raw || null
  };
}

// ==================== 网络变化检测 ====================
function checkIPChange(localIP, outIP, outIPv6) {
  if (!args.isEvent) return true;

  const lastEvent = $persistentStore.read(CONFIG.storeKeys.lastEvent);
  let lastData = {};
  if (lastEvent) {
    try { lastData = JSON.parse(lastEvent); } catch (e) {}
  }

  if (lastData.complete === true && localIP === lastData.localIP && outIP === lastData.outIP && outIPv6 === lastData.outIPv6) {
    IPLog.log("网络信息未变化，跳过");
    return false;
  }

  IPLog.log("网络信息已变化或上次检测未完成，重新检测");
  return true;
}

// Stash 通知专用上下文：不读取/写入节点测试卡片的记录。
// 各 IP 字段独立建立基线；失败字段沿用旧值，不妨碍其他有效变化。
async function runStashMonitor() {
  if (!args.notify || (typeof $script !== "undefined" && $script.type === "tile")) return done({});
  const current = await fetchIPs();
  if (finished) return;
  const key = "stash.ip-security.monitor.v2:" + encodeURIComponent(args.proxy || "routing");
  let previous = {};
  try { previous = JSON.parse($persistentStore.read(key) || "{}"); } catch (_) {}
  if (!previous || typeof previous !== "object" || Array.isArray(previous)) previous = {};
  const next = { ...previous };
  let changed = false;
  for (const field of ["outIP", "localIP", "outIPv6"]) {
    const value = current[field];
    if (!value) continue;
    if (previous[field] && previous[field] !== value) {
      changed = true;
    }
    next[field] = value;
  }
  if (changed) {
    if (typeof $notification === "undefined" || typeof $notification.post !== "function") {
      IPLog.log("当前客户端未提供通知接口；保留基线供下次重试");
      return done({});
    }
    // 仅变化后补查详情，沿用本轮 IP/IPPure 响应，不再探测一遍出口。
    const results = await Promise.allSettled([
      getStashLocalResult(current.localRaw),
      current.outIP ? getStashOutboundResult(false, { ip: current.outIP, raw: current.outRaw }) : null,
      current.outIP ? getStashRiskResult() : null,
      getStashControlContext()
    ]);
    if (finished) return;
    const [local, outbound, risk, control] = results.map(result => result.status === "fulfilled" ? result.value : null);
    const sameRisk = risk?.ip === current.outIP ? risk : null;
    const m = ip => ip ? maskIP(ip, args.maskIP) : t("查询失败");
    const detail = (info, scope) => (info?.location ? displayGeo(info.countryCode, scope, info.location) : t("地区查询失败")) +
      " · " + (info?.organization === "运营商未知" ? t("运营商未知") : info?.organization || t("运营商未知"));
    const title = t("🔄 网络已切换") + (args.proxy ? " | " + args.proxy : "");
    const subtitle = "Ⓓ " + m(current.localIP) + " 🅟 " + m(current.outIP);
    const lines = ["🅟 " + field("风控", sameRisk?.valid ? formatRisk(sameRisk) : t("未知（检测失败）")) +
      " | " + field("类型", renderIPType(sameRisk?.typeText || "类型未知 · 来源未知")),
      "🅟 " + m(current.outIP) + " " + detail(outbound, "remote")];
    if (current.outIPv6) lines.push("🅟 " + field("IPv6", m(current.outIPv6)));
    if (control?.entranceIP) lines.push("Ⓔ " + m(control.entranceIP));
    lines.push("Ⓓ " + m(current.localIP) + " " + detail(local, "local"));
    if (control?.policy) lines.push(field("规则预测（{host}）", stashCacheIP(control.policy) ? m(control.policy) : control.policy, { host: control.host }));
    try { $notification.post(title, subtitle, lines.join("\n")); }
    catch (_) { IPLog.log("通知发送失败；保留基线供下次重试"); return done({}); }
  }
  if (Object.keys(next).length) {
    try { $persistentStore.write(JSON.stringify(next), key); }
    catch (_) { IPLog.log("通知记录保存失败"); }
  }
  done({});
}

// IP 校验供出口确认及风险字段缓存共用；地区与运营商不使用历史字段缓存。
function stashCacheIP(value) {
  if (typeof value !== "string") return "";
  const ip = value.trim().toLowerCase();
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
    return ip.split(".").every(n => Number(n) <= 255) ? ip : "";
  }
  // IPv6 缓存键保留地址写法；不同等价写法最多造成未命中，不会串用地址。
  if (!/^[0-9a-f:]+$/.test(ip) || ip.includes(":::") ||
    (ip.startsWith(":") && !ip.startsWith("::")) ||
    (ip.endsWith(":") && !ip.endsWith("::"))) return "";
  const halves = ip.split("::"), groups = ip.split(":").filter(Boolean);
  if (halves.length > 2 || !groups.every(n => /^[0-9a-f]{1,4}$/.test(n))) return "";
  return halves.length === 2 ? (groups.length < 8 ? ip : "") :
    (groups.length === 8 && !ip.startsWith(":") && !ip.endsWith(":") ? ip : "");
}

function stashFields(values, ts = Date.now()) {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value, ts }]));
}

function stashLastGood(kind, ip, fresh) {
  const key = "stash.ip-security.last-good.v1", ttl = 86400000, now = Date.now();
  const address = stashCacheIP(ip), id = kind + ":" + address;
  const valid = (name, value) => name === "score" ?
    typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 :
    ["isResidential", "isBroadcast"].includes(name) ? typeof value === "boolean" :
    name === "countryCode" ? typeof value === "string" && /^[A-Z]{2}$/.test(value) :
    typeof value === "string" && !!value.trim();
  const usable = (name, field) => field && Number.isFinite(field.ts) &&
    now - field.ts >= 0 && now - field.ts < ttl && valid(name, field.value);
  let entries = {};
  try {
    const stored = JSON.parse($persistentStore.read(key) || "{}");
    if (stored && typeof stored === "object" && !Array.isArray(stored)) entries = stored;
  } catch (_) {}
  const previous = address ? entries[id]?.fields || {} : {};
  const fields = {}, data = {};
  let cached = false;
  for (const name of Object.keys(fresh)) {
    let field = fresh[name];
    if (!usable(name, field)) {
      if (usable(name, previous[name])) { field = previous[name]; cached = true; }
      else field = undefined;
    }
    if (usable(name, field)) { fields[name] = field; data[name] = field.value; }
  }
  if (address && Object.keys(fields).length) {
    // 沿用每个字段原始时间；失败刷新不延长旧数据寿命，也不覆盖其他 IP。
    const ts = Math.max(...Object.values(fields).map(field => field.ts));
    const retained = Object.entries(entries).filter(([entry, value]) => entry !== id &&
      Number.isFinite(value?.ts) && now - value.ts >= 0 && now - value.ts < ttl);
    retained.push([id, { ts, fields }]);
    retained.sort((a, b) => a[1].ts - b[1].ts);
    try { $persistentStore.write(JSON.stringify(Object.fromEntries(retained.slice(-32))), key); }
    catch (_) { IPLog.log("上次成功结果保存失败，继续显示本次结果"); }
  }
  if (cached) IPLog.log("[IP 缓存] " + kind + "：复用同一 IP 的上次成功字段");
  return { data };
}

// ==================== 面板内容构建 ====================
function geoLabel(info) {
  // ip-api.com(zh): country_name="香港"(非 ASCII) → 显示中文国名
  // ip-api.com(en): country_name="Hong Kong" / ipinfo.io: country_name="HK" → 显示 country_code
  return (info?.country_name && /[^\x00-\x7F]/.test(info.country_name)) ? info.country_name : info?.country_code;
}

function buildOutboundSection(outIP, outIPv6, outInfo, maskMode, reverseDNS) {
  const lines = [];
  const m = ip => maskIP(ip, maskMode);
  if (outIPv6) {
    lines.push(field("出口 IP⁴", m(outIP)), field("出口 IP⁶", m(outIPv6)));
  } else {
    lines.push(field("出口 IP", m(outIP)));
  }
  lines.push(field("地区", displayGeo(outInfo?.country_code, "remote", outInfo?.city, outInfo?.region, geoLabel(outInfo))));
  lines.push(field("运营商", renderASNOrganization(outInfo)));
  if (reverseDNS) lines.push(field("rDNS", reverseDNS));
  return lines;
}

function buildPanelContent({ localZh, maskMode, riskInfo, ipType, ipSrc, localIP, localInfo, entranceIP, entranceInfo, outIP, outIPv6, outInfo, dnsLeak, reverseDNS, traffic }) {
  const m = ip => maskIP(ip, maskMode);
  const lines = [field("IP 风控值", formatRisk(riskInfo))];
  if (dnsLeak) {
    if (dnsLeak.leaked === null) {
      lines.push(field("DNS 检测", t("检测失败")));
    } else if (dnsLeak.resolvers) {
      const names = [...new Set(dnsLeak.resolvers.map(r => r.name).filter(Boolean))];
      if (dnsLeak.leaked) {
        const leakedNames = [...new Set(dnsLeak.resolvers.filter(r => r.isChina).map(r => r.name))];
        lines.push(field("DNS 检测", t("⚠️ 泄露!") + " " + leakedNames.join(", ")));
      } else {
        lines.push(field("DNS 检测", t("无泄露") + " (" + names.join(" / ") + ")"));
      }
    } else {
      lines.push(field("DNS 检测", t("无泄露")));
    }
  }
  lines.push(
    "", field("IP 类型", renderIPType(ipType) + " | " + renderIPType(ipSrc)), "",
    field("本地 IP", m(localIP)),
    field("地区", displayGeo(localInfo?.country_code, "local", localInfo?.city, localInfo?.region,
      localZh ? localInfo?.country_name : localInfo?.country_code)),
    field("运营商", renderASNOrganization(localInfo))
  );
  if (entranceInfo) {
    lines.push("", field("入口 IP", m(entranceIP)),
      field("地区", displayGeo(entranceInfo?.country_code, "remote", entranceInfo?.city, entranceInfo?.region, geoLabel(entranceInfo))),
      field("运营商", renderASNOrganization(entranceInfo)));
  }
  lines.push("", ...buildOutboundSection(outIP, outIPv6, outInfo, maskMode, reverseDNS));
  if (traffic) {
    lines.push("", field("流量统计", "↑ " + formatBytes(traffic.upload) + "  ↓ " + formatBytes(traffic.download)
      + (traffic.duration ? " | ⏱ " + formatDuration(traffic.duration) : "")));
  }
  return lines.join("\n");
}

// ==================== 通知内容构建 ====================
function sendNetworkChangeNotification({ localZh, policy, localIP, outIP, entranceIP, localInfo, entranceInfo, outInfo, riskInfo, ipType, ipSrc, maskMode, dnsLeak }) {
  if (!args.notify) {
    IPLog.log("通知已禁用 (notify=false)，跳过推送");
    return;
  }
  const m = ip => maskIP(ip, maskMode);
  const policyLabel = typeof policy === "string" ? policy.trim() : "";
  const title = t("🔄 网络已切换") + (policyLabel && !/^unknown$/i.test(policyLabel) ? " | " + policyLabel : "");
  const subtitle = "Ⓓ " + m(localIP) + " 🅟 " + m(outIP);
  const bodyLines = [
    "🅟 " + field("风控", formatRisk(riskInfo)) + " | " + field("类型", renderIPType(ipType) + " · " + renderIPType(ipSrc)),
    "🅟 " + m(outIP) + " " + displayGeo(outInfo?.country_code, "remote", outInfo?.city, geoLabel(outInfo)) + " · " + renderASNOrganization(outInfo)
  ];
  if (entranceInfo) {
    bodyLines.push("Ⓔ " + m(entranceIP) + " " + displayGeo(entranceInfo?.country_code, "remote", entranceInfo?.city, geoLabel(entranceInfo)) + " · " + renderASNOrganization(entranceInfo));
  }
  bodyLines.push("Ⓓ " + m(localIP) + " " + displayGeo(localInfo?.country_code, "local", localInfo?.city,
    localZh ? localInfo?.country_name : localInfo?.country_code) + " · " + renderASNOrganization(localInfo));
  if (dnsLeak && dnsLeak.leaked && dnsLeak.resolvers) {
    const leakedNames = [...new Set(dnsLeak.resolvers.filter(r => r.isChina).map(r => r.name))];
    bodyLines.push(t("⚠️ DNS 泄露!") + " " + leakedNames.join(", "));
  }
  $notification.post(title, subtitle, bodyLines.join("\n"));
  IPLog.log("=== 已发送通知 ===");
}

// ==================== Stash 独立卡片 ====================
// 按选定数据源获取元数据，不调用 Surge API；无 JS 定时器时使用客户端请求超时。
// 默认风险和类型取自同一次 IPPure 响应；其他风险源查询同一 IP，不用另一站点的出口代替。
// 折叠卡片保留简短地区/运营商摘要，风险等级与颜色共用 Surge 的配置。
// Android 用标题第二行显示 IP；iOS 标题也只有一行，改用标记与 IP 同行。
function compactStashLocation(location, local = false) {
  const value = String(location || "").trim();
  const compact = local ? value.replace(/^中国/, "").replace(/^.*?(?:省|自治区)/, "")
    .replace(/(?:特别行政区|市).*$/, "") : value.replace(/市$/, "");
  return compact || value;
}

function compactStashOrg(organization) {
  const value = String(organization === "运营商未知" ? t("运营商未知") : organization || t("运营商未知")).replace(/^AS\d+\s+/, "")
    .replace(/\s+(?:(?:Co\.?[,]?\s*)?Ltd\.?|Limited|Inc\.?|LLC|Corporation)\.?$/i, "").trim();
  if (isStashiOS && args.lang !== "en") {
    // iOS 正文只有一行，常见中国运营商用短名称，包含香港等地区的同品牌出口。
    const carriers = [
      [/中国移动|\bChina\s*Mobile\b/i, "中国移动"],
      [/中国联通|\bChina\s*Unicom\b/i, "中国联通"],
      [/中国电信|\bChina\s*Telecom\b/i, "中国电信"],
      [/中国广电|\bChina\s*(?:Broadnet|Broadcasting(?:\s*Network)?)\b/i, "中国广电"]
    ];
    for (const [pattern, label] of carriers) if (pattern.test(value)) return label;
  }
  return value;
}

function compactStashIPContent({ shortLocation, organization, countryCode }, fallbackCountryCode, scope = "remote") {
  const code = countryCode || fallbackCountryCode;
  const location = code === "CN" ? String(shortLocation || "").replace(/[省市]$/, "") : shortLocation;
  let org = compactStashOrg(organization);
  // 先沿原规则缩短，再在显示层繁化，避免行政后缀转换影响裁剪。
  if (code === "CN" && Array.from(location || "").length > 2) org = org.replace(/^中国/, "");
  const shownLocation = location ? displayGeoText(location, scope) : t("地区查询失败");
  return [[flag(code), shownLocation].filter(Boolean).join(" "), org].join(" · ");
}

async function getStashRiskResult() {
  // IPPure 成功时沿用原生结果；首选评分不可用才按同一实测 IP 查询剩余来源。
  const info = await getIPPureInfo();
  let pureIP = stashCacheIP(info?.ip);
  const freshScore = typeof info?.fraudScore === "number" ? info.fraudScore :
    (typeof info?.fraudScore === "string" && info.fraudScore.trim() ? Number(info.fraudScore) : NaN);
  let { data } = stashLastGood("risk", pureIP, stashFields({
    score: freshScore, isResidential: info?.isResidential, isBroadcast: info?.isBroadcast
  }));
  const usePure = args.riskApi === "ippure" && Number.isFinite(data.score) && data.score >= 0 && data.score <= 100;
  if (usePure) IPLog.log("风险评分：采用 IPPure");
  let selected = null;
  if (!usePure) {
    if (!pureIP) {
      pureIP = (await fetchOutbound4())?.ip || "";
      data = {}; // 无有效 IP 的 IPPure 字段不能套到备用探测地址上。
    }
    if (pureIP) selected = await getRiskScore(pureIP);
  }
  const score = usePure ? data.score : selected?.score;
  const source = usePure ? "IPPure" : selected?.source || "Unavailable";
  const valid = Number.isFinite(score) && score >= 0 && score <= 100;
  if (!info && !valid) return null;
  const ipType = typeof data.isResidential === "boolean" ? (data.isResidential ? "住宅 IP" : "机房 IP") : "类型未知";
  const ipSrc = typeof data.isBroadcast === "boolean" ? (data.isBroadcast ? "广播 IP" : "原生 IP") : "来源未知";
  const { label: level, color } = riskText(valid ? score : null);
  const detail = valid ? formatRisk({ score, source }) : "暂无有效评分";
  const typeText = [ipType.replace(/ IP$/, ""), ipSrc.replace(/ IP$/, "")].join(" · ");
  return { ip: pureIP, score, source, valid, level, color, riskText: detail, typeText };
}

async function getStashLocalResult(local) {
  if (local === undefined) local = await httpJSON(CONFIG.urls.localIP, "DIRECT");
  const ip = local?.data?.addr;
  if (!ip) return null;
  const { info } = await getLocalGeo(local);
  return {
    ip, countryCode: info?.country_code,
    location: info && [...new Set([info.country_name, info.region, info.city].filter(Boolean))].join(" "),
    shortLocation: info && compactStashLocation(info.city || info.region || info.country_name, true),
    organization: info?.org
  };
}

async function getStashOutboundResult(includeIPv6, detectedExit) {
  // 折叠卡片不探测 IPv6；地区与运营商的数据源优先级和首页、通知一致。
  const ipv6 = includeIPv6 ? fetchOutbound6() : Promise.resolve(null);
  const pure = getIPPureInfo();
  const exit = detectedExit || await fetchOutbound4();
  const outIP = exit?.ip, outRaw = exit?.raw;
  if (!outIP) return null;
  const pureInfo = await pure;
  const sameIPPure = stashCacheIP(pureInfo?.ip) === outIP ? normalizeStashIPPure(pureInfo) : null;
  const probeInfo = sameIPPure?.country_code ? sameIPPure : normalizeIpSb(outRaw);
  const [geography, outIPv6] = await Promise.all([getOutboundGeo(outIP, probeInfo, sameIPPure), ipv6]);
  const { info, reverseDNS } = geography;
  return {
    ip: outIP, ipv6: outIPv6, raw: outRaw, countryCode: info?.country_code,
    location: info && [...new Set([info.city, info.region, geoLabel(info) || info.country_name].filter(Boolean))].join(", "),
    shortLocation: info && compactStashLocation(["HK", "MO", "SG"].includes(info.country_code) ?
      geoLabel(info) : info.city || info.region || geoLabel(info) || info.country_name),
    organization: info?.org || "运营商未知",
    reverseDNS
  };
}

// 首页聚合卡片：各项并行检测，某一项失败不抹掉其他成功结果。
// 地区和运营商与折叠卡片使用相同回退顺序；风险阈值及配色保持一致。
async function runStashSummary() {
  const results = await Promise.allSettled([
    getStashRiskResult(), getStashLocalResult(), getStashOutboundResult(true),
    checkDNSLeak(args.proxy || undefined, Date.now() + 1500), getStashControlContext()
  ]);
  const [risk, local, outbound, dns, control] = results.map(result => result.status === "fulfilled" ? result.value : null);
  const m = ip => maskIP(ip, args.maskIP);
  const region = (info, scope) => info?.location ? displayStashGeo(info.countryCode, scope, info.location) : t("查询失败");
  const org = info => info?.organization === "运营商未知" ? t("运营商未知") : info?.organization || "Unknown";
  const lines = [
    field("IP 风控值", risk?.valid ? formatRisk(risk) : t("暂无有效评分")),
    field("IP 类型", renderIPType(risk?.typeText || "类型未知 · 来源未知")), "",
    field("本地 IP", local?.ip ? m(local.ip) : t("查询失败")),
    field("地区", region(local, "local")), field("运营商", org(local)), ""
  ];
  if (outbound?.ipv6) {
    lines.push(field("出口 IP⁴", m(outbound.ip)), field("出口 IP⁶", m(outbound.ipv6)));
  } else {
    lines.push(field("出口 IP", outbound?.ip ? m(outbound.ip) : t("查询失败")));
  }
  lines.push(field("地区", region(outbound, "remote")), field("运营商", org(outbound)));
  if (outbound?.reverseDNS) lines.push(field("rDNS", args.maskIP ? t("[已隐藏]") : outbound.reverseDNS));
  const resolver = dns?.resolvers?.[0];
  lines.push("", field("DNS 解析器", resolver ? m(resolver.ip) : t("查询失败")));
  if (resolver?.geo) lines.push(field("DNS 地区", displayDNSGeo(resolver.geo)));
  // 地区不能证明是否泄露；proxy 只代表调用者显式指定的策略，不推断实际节点。
  if (args.proxy) lines.push(field("指定策略", args.proxy));
  if (control?.policy) {
    lines.push("", field("规则预测（{host}）", stashCacheIP(control.policy) ? m(control.policy) : control.policy, { host: control.host }));
    if (control.chain.length) lines.push(field("代理链", control.chain.map(name => stashCacheIP(name) ? m(name) : name).join(" → ")));
    if (control.entranceIP) lines.push(field("代理服务器 IP", m(control.entranceIP)));
  }
  if (control?.traffic) lines.push(field("本机累计流量", "↑ " + formatBytes(control.traffic.upload) + "  ↓ " + formatBytes(control.traffic.download)));
  return done({
    title: t("IP 信息卡"), content: lines.join("\n"),
    backgroundColor: risk?.color || "#9E9E9E", url: "https://ippure.com"
  });
}

async function runStashTile() {
  if (args.tile === "summary") return runStashSummary();
  const tile = stashTiles[args.tile];
  if (!tile) return done({ content: t("未知卡片类型") });
  const fail = message => done({
    title: args.mode === "collapsed" && isStashiOS && tile.marker ? tile.marker : t(tile.title),
    content: t(message), backgroundColor: "#9E9E9E"
  });
  const render = (lines, color = tile.color, compact = null, url) => done({
    content: lines.filter(Boolean).join("\n"), backgroundColor: color, url,
    ...(args.mode === "collapsed" && compact ? compact : {})
  });
  const m = ip => maskIP(ip, args.maskIP);
  const heading = detail => [isStashiOS ? tile.marker : t(tile.title), detail].filter(Boolean)
    .join(isStashiOS ? " " : "\n");
  if (args.tile === "risk") {
    const result = await getStashRiskResult();
    if (!result) return fail("风险评分检测失败");
    const { color, riskText, typeText, valid, score, level } = result;
    const detail = valid ? riskText : t("暂无有效评分");
    const shownType = renderIPType(typeText);
    const percentText = valid ? score + "% " + t(level) : detail;
    return render([shownType, detail], color, {
      // iOS 标题只放百分比；Android 保留标题第二行，正文均放类型。
      title: heading(percentText), content: shownType
    }, args.maskIP === 0 && result.ip ? "https://ippure.com/?ip=" + encodeURIComponent(result.ip) : undefined);
  }
  if (args.tile === "local") {
    const result = await getStashLocalResult();
    if (!result) return fail("无法获取直连公网 IP");
    const { ip, countryCode, location, organization } = result;
    return render([
      m(ip), location ? displayStashGeo(countryCode, "local", location) : t("地区查询失败"),
      organization || t("运营商未知")
    ], location ? tile.color : "#9E9E9E", {
      title: heading(m(ip)), content: location ? compactStashIPContent(result, undefined, "local") : t("地区查询失败")
    }, args.maskIP === 0 ? "https://ippure.com/?ip=" + encodeURIComponent(ip) : undefined);
  }
  if (args.tile === "dns") {
    const detected = await checkDNSLeak(args.proxy || undefined);
    const resolver = detected.resolvers?.[0];
    if (!resolver) return fail("DNS 解析器检测失败");
    const info = normalizeIpApi(await httpJSON(CONFIG.urls.ipApi(resolver.ip, args.lang === "en" ? "en" : "zh-CN")));
    return render([
      m(resolver.ip), info ? displayGeo(info.country_code, "dns", info.city, info.region, geoLabel(info)) : displayDNSGeo(resolver.geo),
      info?.org || (!resolver.geo ? resolver.name : "")
    ]);
  }
  const result = await getStashOutboundResult(args.mode === "home");
  if (!result) return fail("无法获取出口 IPv4");
  const { ip: outIP, ipv6: outIPv6, raw: outRaw, location, countryCode, organization } = result;
  const lines = [m(outIP), outIPv6 ? field("IPv6", m(outIPv6)) : "",
    location ? displayStashGeo(countryCode, "remote", location) : t("地区查询失败"),
    organization === "运营商未知" ? t("运营商未知") : organization];
  if (args.mode === "home" && result.reverseDNS) lines.push(field("rDNS", args.maskIP ? t("[已隐藏]") : result.reverseDNS));
  if (args.mode === "home" && args.proxy) lines.push(field("指定策略", args.proxy));
  return render(lines, location ? tile.color : "#9E9E9E", {
    title: heading(m(outIP)), content: compactStashIPContent(result, outRaw?.country_code)
  });
}

// ==================== 主执行函数 ====================
(async () => {
  try {
    if (isStash && args.task === "logs") {
      IPLog.collect();
      return done({});
    }
    IPLog.log("=== IP 安全检测开始 (v" + CONFIG.VERSION + " / " + (isStash ? "Stash / " + (args.task || args.tile) + " / " + args.mode : "Surge") + ") ===");
    if (isStash) IPLog.log("请求线路：本地 DIRECT；出口 " + (args.proxy ? "使用参数指定的策略" : "遵循当前分流（长按测试时使用所选节点）"));
    if (isStash) return args.task === "monitor" ? await runStashMonitor() : await runStashTile();

    // 1. EVENT 触发时延迟等待网络稳定
    if (args.isEvent && args.eventDelay > 0) {
      IPLog.log("等待网络稳定 " + args.eventDelay + " 秒");
      await wait(args.eventDelay * 1000);
    }

    // 2. 获取本地/出口 IP
    const { localIP, outIP, outIPv6, localRaw, outRaw } = await fetchIPs();

    if (!localIP || !outIP) {
      IPLog.log("IP 获取失败");
      return done({ title: t("IP 获取失败"), content: t("无法获取本地或出口 IPv4"), icon: "leaf", "icon-color": "#9E9E9E" });
    }
    IPLog.log("本地 IP: " + localIP + ", 出口 IP: " + outIP);
    IPLog.log("出口探针地址族: IPv4=" + maskIP(outIP, args.maskIP) + "; IPv6=" +
      (outIPv6 ? maskIP(outIPv6, args.maskIP) : "未探测到"));

    // 3. EVENT 模式下检查 IP 是否变化
    if (!checkIPChange(localIP, outIP, outIPv6)) {
      return done({});
    }

    // 4. 先并行获取风险评分、IP 类型、地理信息和流量，再查询策略与入口 IP。
    // 入口维持指定数据源查询；出口使用独立四级回退。remote_geoapi=ipinfo → ipinfo.io, ipapi/ipapi-zh → ip-api.com(en/zh, http 明文),
    // maxmind/maxmind-zh → GeoLite2(en/zh, 需 key)
    let remoteGeoApi = args.remoteGeoApi;
    if (!["ipinfo", "ipapi", "ipapi-zh", "maxmind", "maxmind-zh"].includes(remoteGeoApi)) {
      IPLog.log("未知 remote_geoapi: " + remoteGeoApi + "，使用 ipapi-zh");
      remoteGeoApi = "ipapi-zh";
    }
    const useIpApi = remoteGeoApi.startsWith("ipapi");
    let useMaxmind = remoteGeoApi.startsWith("maxmind");
    const maxmindZh = remoteGeoApi === "maxmind-zh";
    if (useMaxmind && !args.maxmindKey) {
      IPLog.log("remote_geoapi=maxmind 需要 maxmind_key（account_id:license_key），回落 ipinfo");
      useMaxmind = false;
    }
    const ipApiLang = remoteGeoApi === "ipapi-zh" ? "zh-CN" : "en";
    // 非 ipinfo 数据源时补查 ipinfo：优先取运营商与 hostname，失败仍保留可用的地理源字段。
    const needExtraOrg = useIpApi || useMaxmind;
    const geoHeaders = useMaxmind ? { "Authorization": "Basic " + b64(args.maxmindKey) } : undefined;
    function geoUrl(ip) {
      if (useMaxmind) return CONFIG.urls.maxmindGeo(ip);
      return useIpApi ? CONFIG.urls.ipApi(ip, ipApiLang) : CONFIG.urls.ipInfo(ip);
    }
    function normalizeGeo(data) {
      if (useMaxmind) return normalizeMaxmind(data, maxmindZh);
      return useIpApi ? normalizeIpApi(data) : normalizeIpInfo(data);
    }

    // 先并行发起 geo/risk/流量 API 请求，确保 ip.sb/ipinfo/ip-api 请求完成后再查策略
    // DNS 泄露检测需要走代理策略，必须在取得 policy 后执行
    const [riskInfo, ipTypeResult, localGeo, outGeo, trafficResult] = await Promise.all([
      getRiskScore(outIP),
      getIPType(outIP),
      getLocalGeo(localRaw),
      getOutboundGeo(outIP, normalizeIpSb(outRaw)),
      getTrafficStats()
    ]);
    const localInfo = localGeo.info, localZh = localGeo.source !== "ipsb";
    const outInfo = outGeo.info, reverseDNS = outGeo.reverseDNS;
    if (reverseDNS) IPLog.log("反向 DNS: " + reverseDNS);

    // 请求完成后查询 recent，提高捕获概率；记录仍可能缺失，内部会重试并降级。
    const { policy, entranceIP } = await getPolicyAndEntrance();

    // 当前仅在识别到代理策略时探测 DNS 解析器，并将请求指定到该策略。
    const isDirect = !policy || policy === "DIRECT" || policy === "Unknown";
    let dnsLeakResult = null;
    if (!isDirect) {
      dnsLeakResult = await checkDNSLeak(policy);
    } else {
      IPLog.log("当前为直连，跳过 DNS 泄露检测");
    }

    // 入口 IP 地理信息：与出口不同时才查询
    let entranceInfo = null;
    if (entranceIP && entranceIP !== outIP) {
      IPLog.log("入口 IP: " + entranceIP + " 与出口 IP 不同，查询入口地理信息");
      const entrQueries = [httpJSON(geoUrl(entranceIP), null, geoHeaders)];
      if (needExtraOrg) entrQueries.push(httpJSON(CONFIG.urls.ipInfo(entranceIP)));
      const [entrGeoRaw, entrOrgRaw] = await Promise.all(entrQueries);
      entranceInfo = normalizeGeo(entrGeoRaw);
      if (needExtraOrg && entranceInfo && entrOrgRaw) {
        const orgData = normalizeIpInfo(entrOrgRaw);
        if (orgData?.org) entranceInfo.org = orgData.org;
      }
      entranceInfo = await withSurgeGeoFallback(entranceIP, entranceInfo);
    }

    const riskResult = riskText(riskInfo.score);
    const { ipType, ipSrc } = ipTypeResult;

    // 5. IP 打码：mask_ip=2 锁定全隐藏；0/1 手动点击切换
    const maskStored = parseInt($persistentStore.read(CONFIG.storeKeys.maskToggle), 10);
    let maskMode = args.maskIP === 2 ? 2 : (Number.isInteger(maskStored) ? maskStored : args.maskIP);
    if (args.maskIP !== 2 && !args.isEvent) {
      const now = Math.floor(Date.now() / 1000);
      const lastRun = parseInt($persistentStore.read(CONFIG.storeKeys.lastRun), 10) || 0;
      $persistentStore.write(String(now), CONFIG.storeKeys.lastRun);
      const elapsed = now - lastRun;
      const interval = args.panelInterval; // 需与 [Panel] update-interval 一致，经 panel_interval 参数传入（默认 600）
      const tolerance = 15;
      const remainder = elapsed % interval;
      const isAutoRefresh = lastRun > 0 && elapsed > tolerance
        && (remainder <= tolerance || remainder >= interval - tolerance);
      if (lastRun > 0 && !isAutoRefresh) {
        maskMode = maskMode === 1 ? 0 : 1;
        $persistentStore.write(String(maskMode), CONFIG.storeKeys.maskToggle);
      }
    }
    const context = { localZh, maskMode, policy, riskInfo, ipType, ipSrc, localIP, localInfo, entranceIP, entranceInfo, outIP, outIPv6, outInfo, dnsLeak: dnsLeakResult, reverseDNS, traffic: trafficResult };

    if (finished) return;
    if (args.isEvent) {
      sendNetworkChangeNotification(context);
      // 类型 / 来源或评分未知时不能记为已完成，否则相同 IP 的下次事件无法重试。
      if (!_ippureCardFailed && typeof riskInfo.score === "number" && Number.isFinite(riskInfo.score) && riskInfo.score >= 0 && riskInfo.score <= 100 &&
          ["住宅 IP", "机房 IP"].includes(ipType) && ["广播 IP", "原生 IP"].includes(ipSrc)) {
        $persistentStore.write(JSON.stringify({ localIP, outIP, outIPv6, complete: true }), CONFIG.storeKeys.lastEvent);
      } else {
        IPLog.log("风险评分、类型或来源未确认，不保存事件完成记录，下次事件重新检测");
      }
      done({});
    } else {
      IPLog.log("=== 面板显示 ===");
      done({
        title: field("代理策略", policy),
        content: buildPanelContent(context),
        icon: "leaf.fill",
        "icon-color": riskResult.color
      });
    }
  } catch (e) {
    IPLog.log("未捕获异常: " + (e.message || e));
    done({ title: t("检测异常"), content: e.message || String(e), icon: "leaf", "icon-color": "#9E9E9E" });
  }
})();
