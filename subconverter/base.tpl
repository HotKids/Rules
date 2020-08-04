{% if request.target == "clash" or request.target == "clashr" %}

port: {{ default(global.clash.http_port, "7890") }}
socks-port: {{ default(global.clash.socks_port, "7891") }}
allow-lan: {{ default(global.clash.allow_lan, "true") }}
mode: Rule
log-level: {{ default(global.clash.log_level, "info") }}
external-controller: :9090
{% if default(request.clash.dns, "") == "1" %}
dns:
  enable: true # set true to enable dns (default is false)
  ipv6: false # default is false
  listen: 0.0.0.0:53
  # default-nameserver: # resolve dns nameserver host, should fill pure IP
  #   - 119.29.29.29
  #   - 119.28.28.28
  enhanced-mode: fake-ip # or redir-host
  # fake-ip-range: 198.18.0.1/16 # if you don't know what it is, don't change it
  fake-ip-filter: # fake ip white domain list
    - '*.lan'
    - localhost.ptlogin2.qq.com
  nameserver:
    - 'https://doh.rixcloud.dev/dns-query'
    - 'https://47.108.56.233/dns-query'
    - 'https://118.31.13.131/dns-query'
    - 'https://120.25.25.166/dns-query'
    - 'https://139.224.112.177/dns-query'
    - 'https://59.110.53.209/dns-query'
  # fallback: # concurrent request with nameserver, fallback used when GEOIP country isn't CN
    # - tcp://1.1.1.1
  fallback-filter:
    geoip: true # default
    ipcidr: # ips in these subnets will be considered polluted
      - 240.0.0.0/4
{% endif %}
{% if local.clash.new_field_name == "true" %}
proxies: ~
proxy-groups: ~
rules: ~
{% else %}
Proxy: ~
Proxy Group: ~
Rule: ~
{% endif %}

{% endif %}
{% if request.target == "surge" %}

[General]
[General]
// General
http-listen = 0.0.0.0:7890
socks5-listen = 0.0.0.0:7891
http-api = examplekey@0.0.0.0:6166
external-controller-access = HotKids@0.0.0.0:6170
allow-wifi-access = true

internet-test-url = http://www.aliyun.com
proxy-test-url = http://cp.cloudflare.com/generate_204

test-timeout = 3
ipv6 = false
show-error-page-for-reject = true

// DNS
// doh-format=json
// dns-server = https://neatdns.ustclug.org/resolve
dns-server = 119.29.29.29, 119.28.28.28, 223.5.5.5, 223.6.6.6, 180.76.76.76, 1.2.4.8
doh-server = https://47.108.56.233/dns-query, https://118.31.13.131/dns-query, https://120.25.25.166/dns-query, https://139.224.112.177/dns-query, https://59.110.53.209/dns-query, https://doh.rixcloud.dev/dns-query

// Advanced
loglevel = notify
skip-proxy = 192.168.0.0/16, 193.168.0.0/24, 10.0.0.0/8, 172.16.0.0/12, 100.64.0.0/10, 17.0.0.0/8, 127.0.0.1, localhost, *.local
exclude-simple-hostnames = true
use-default-policy-if-wifi-not-primary = false

// Others
enhanced-mode-by-rule = false
always-real-ip = *.srv.nintendo.net, *.stun.playstation.net, xbox.*.microsoft.com, *.xboxlive.com

[Replica]
hide-apple-request = true
hide-crashlytics-request = true
hide-udp = false
keyword-filter-type = false

[Host]
neatdns.ustclug.org = server:202.141.178.13
*.1688.com = server:223.5.5.5
*.taobao.com = server:223.5.5.5
*.tmall.com = server:223.5.5.5
*.alipay.com = server:223.5.5.5
*.alicdn.com = server:223.5.5.5
*.aliyun.com = server:223.5.5.5
*.fliggy.com = server:223.5.5.5
*.jd.com = server:119.29.29.29
*.qq.com = server:119.29.29.29
*.tencent.com = server:119.29.29.29
*.weixin.com = server:119.29.29.29
*buyimg.com = server:119.29.29.29
*gtimg.* = server:119.29.29.29
*.bilibili.com = server:119.29.29.29
hdslb.com = server:119.29.29.29
# CUSTOM HOST

[Header Rewrite]
# 百度贴吧重定向
 ^https?+:\/\/(?:c\.)?+tieba\.baidu\.com\/(?>f|p) header-replace User-Agent "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.4 Safari/605.1.15"
^https?+:\/\/jump2\.bdimg\.com\/(?>f|p) header-replace User-Agent "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.4 Safari/605.1.15"
# 百度知道重定向
 ^https?+:\/\/zhidao\.baidu\.com header-replace User-Agent "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.4 Safari/605.1.15"
# 知乎网页重定向
 ^https?+:\/\/www\.zhihu\.com\/question header-replace User-Agent "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.4 Safari/605.1.15"
# CUSTOM HEADER

[URL Rewrite]
# Redirect Google Search Service
^(http|https):\/\/(www.)?(g|google)\.cn https://www.google.com 302

# Redirect HTTP to HTTPS
^(http|https):\/\/(www.)?taobao\.com\/ https://taobao.com/ 302
^(http|https):\/\/(www.)?jd\.com\/ https://www.jd.com/ 302
^(http|https):\/\/(www.)?mi\.com\/ https://www.mi.com/ 302
^(http|https):\/\/you\.163\.com\/ https://you.163.com/ 302
^(http|https):\/\/(www.)?suning\.com\/ https://suning.com/ 302
^(http|https):\/\/(www.)?yhd\.com\/ https://yhd.com/ 302

# Redirect False to True
# > IGN China to IGN Global
^(http|https):\/\/(www.)?ign\.xn--fiqs8s\/ http://cn.ign.com/ccpref/us 302
# > Fake Website Made By C&J Marketing
^(http|https):\/\/(www.)?abbyychina\.com\/ https://www.abbyy.cn/ 302
^(http|https):\/\/(www.)?bartender\.cc\/ https://www.macbartender.com/ 302
^(http|https):\/\/(www.)?(betterzipcn|betterzip)\.(com|net)\/ https://macitbetter.com/ 302
^(http|https):\/\/(www.)?beyondcompare\.cc\/ https://www.scootersoftware.com/ 302
^(http|https):\/\/(www.)?bingdianhuanyuan\.cn\/ https://www.faronics.com/zh-hans/products/deep-freeze 302
^(http|https):\/\/(www.)?chemdraw\.com\.cn\/ https://www.perkinelmer.com.cn/ 302
^(http|https):\/\/(www.)?codesoftchina\.com\/ https://www.teklynx.com/ 302
^(http|https):\/\/(www.)?coreldrawchina\.com\/ https://www.coreldraw.com/cn/ 302
^(http|https):\/\/(www.)?crossoverchina\.com\/ https://www.codeweavers.com/ 302
^(http|https):\/\/(www.)?dongmansoft\.com\/ https://www.udongman.cn/ 302
^(http|https):\/\/(www.)?earmasterchina\.cn\/ https://www.earmaster.com/ 302
^(http|https):\/\/(www.)?easyrecoverychina\.com\/ https://www.ontrack.com/ 302
^(http|https):\/\/(www.)?ediuschina\.com\/ https://www.grassvalley.com/ 302
^(http|https):\/\/(www.)?flstudiochina\.com\/ https://www.image-line.com/ 302
^(http|https):\/\/(www.)?formysql\.com\/ https://www.navicat.com.cn/ 302
^(http|https):\/\/(www.)?guitarpro\.cc\/ https://www.guitar-pro.com/ 302
^(http|https):\/\/(www.)?huishenghuiying\.com\.cn\/ https://www.coreldraw.com/cn/ 302
^(http|https):\/\/hypersnap\.mairuan\.com\/ https://www.hyperionics.com/ 302
^(http|https):\/\/(www.)?iconworkshop\.cn\/ https://www.axialis.com/ 302
^(http|https):\/\/(www.)?imindmap\.cc\/ https://www.ayoa.com/previously-imindmap/ 302
^(http|https):\/\/(www.)?jihehuaban\.com\.cn\/ https://www.chartwellyorke.com/sketchpad/x24795.html 302
^(http|https):\/\/hypersnap\.mairuan\.com\/ https://www.keyshot.com/ 302
^(http|https):\/\/(www.)?kingdeecn\.cn\/ http://www.kingdee.com/ 302
^(http|https):\/\/(www.)?logoshejishi\.com https://www.sothink.com/product/logo-design-software/ 302
^(http|https):\/\/logoshejishi\.mairuan\.com\/ https://www.sothink.com/product/logo-design-software/ 302
^(http|https):\/\/(www.)?luping\.net\.cn\/ https://www.techsmith.com/ 302
^(http|https):\/\/(www.)?mathtype\.cn\/ https://www.dessci.com/ 302
^(http|https):\/\/(www.)?mindmanager\.(cc|cn)\/ https://www.mindjet.com/cn/ 302
^(http|https):\/\/(www.)?mindmapper\.cc\/ https://www.mindmapper.com/ 302
^(http|https):\/\/(www.)?(mycleanmymac|xitongqingli)\.com\/ https://macpaw.com/ 302
^(http|https):\/\/(www.)?nicelabel\.cc\/ https://www.nicelabel.com/zh/ 302
^(http|https):\/\/(www.)?ntfsformac\.cc\/ https://www.tuxera.com/products/tuxera-ntfs-for-mac-cn/ 302
^(http|https):\/\/(www.)?ntfsformac\.cn\/ https://china.paragon-software.com/home-mac/ntfs-for-mac/ 302
^(http|https):\/\/(www.)?overturechina\.com\/ https://sonicscores.com/ 302
^(http|https):\/\/(www.)?passwordrecovery\.cn\/ https://cn.elcomsoft.com/aopr.html 302
^(http|https):\/\/(www.)?pdfexpert\.cc\/ https://pdfexpert.com/zh 302
^(http|https):\/\/(www.)?photozoomchina\.com\/ https://www.benvista.com/ 302
^(http|https):\/\/(www.)?shankejingling\.com\/ https://www.sothink.com/product/flashdecompiler/ 302
^(http|https):\/\/cn\.ultraiso\.net\/ https://cn.ezbsystems.com/ultraiso/ 302
^(http|https):\/\/(www.)?vegaschina\.cn\/ https://www.vegascreativesoftware.com/ 302
^(http|https):\/\/(www.)?xshellcn\.com\/ https://www.netsarang.com/zh/xshell/ 302
^(http|https):\/\/(www.)?yuanchengxiezuo\.com\/ https://www.teamviewer.com/ 302
^(http|https):\/\/(www.)?zbrushcn.com/ https://pixologic.com/ 302

# TikTok (By wzw1997007) - *.tiktokv.com, *.byteoversea.com, *.musical.ly, *.snssdk.com
# (?<=_region=)CN(?=&) JP 307
# (?<=&app_version=)16..(?=.?.?&) 1 307
# (?<=\?version_code=)16..(?=.?.?&) 1 307

#Resso (By JO2EY) - api.resso.app
# (?<=(carrier|account|sys|sim)_region=)cn in 307

# AbeamTV - api.abema.io
^(http|https):\/\/api\.abema\.io\/v1\/ip\/check - reject

[Script]

{% endif %}
{% if request.target == "loon" %}

[General]
skip-proxy = 192.168.0.0/16,10.0.0.0/8,172.16.0.0/12,localhost,*.local,e.crashlynatics.com
bypass-tun = 10.0.0.0/8,100.64.0.0/10,127.0.0.0/8,169.254.0.0/16,172.16.0.0/12,192.0.0.0/24,192.0.2.0/24,192.88.99.0/24,192.168.0.0/16,198.18.0.0/15,198.51.100.0/24,203.0.113.0/24,224.0.0.0/4,255.255.255.255/32
dns-server = system,119.29.29.29,223.5.5.5
allow-udp-proxy = false
host = 127.0.0.1

[Proxy]

[Remote Proxy]

[Proxy Group]

[Rule]

[Remote Rule]

[URL Rewrite]
enable = true
^https?:\/\/(www.)?(g|google)\.cn https://www.google.com 302

[Remote Rewrite]
https://raw.githubusercontent.com/Loon0x00/LoonExampleConfig/master/Rewrite/AutoRewrite_Example.list,auto

[MITM]
hostname = *.example.com,*.sample.com
enable = true
skip-server-cert-verify = true
#ca-p12 =
#ca-passphrase =

{% endif %}
{% if request.target == "quan" %}

[SERVER]

[SOURCE]

[BACKUP-SERVER]

[SUSPEND-SSID]

[POLICY]

[DNS]
1.1.1.1

[REWRITE]

[URL-REJECTION]

[TCP]

[GLOBAL]

[HOST]

[STATE]
STATE,AUTO

[MITM]

{% endif %}
{% if request.target == "quanx" %}

[general]
excluded_routes=192.168.0.0/16, 172.16.0.0/12, 100.64.0.0/10, 10.0.0.0/8
geo_location_checker=http://ip-api.com/json/?lang=zh-CN, https://github.com/KOP-XIAO/QuantumultX/raw/master/Scripts/IP_API.js
network_check_url=http://www.baidu.com/
server_check_url=http://www.gstatic.com/generate_204

[dns]
server=119.29.29.29
server=223.5.5.5
server=1.0.0.1
server=8.8.8.8

[policy]
static=♻️ 自动选择, direct, img-url=https://raw.githubusercontent.com/Koolson/Qure/master/IconSet/Auto.png
static=🔰 节点选择, direct, img-url=https://raw.githubusercontent.com/Koolson/Qure/master/IconSet/Proxy.png
static=🌍 国外媒体, direct, img-url=https://raw.githubusercontent.com/Koolson/Qure/master/IconSet/GlobalMedia.png
static=🌏 国内媒体, direct, img-url=https://raw.githubusercontent.com/Koolson/Qure/master/IconSet/DomesticMedia.png
static=Ⓜ️ 微软服务, direct, img-url=https://raw.githubusercontent.com/Koolson/Qure/master/IconSet/Microsoft.png
static=📲 电报信息, direct, img-url=https://raw.githubusercontent.com/Koolson/Qure/master/IconSet/Telegram.png
static=🍎 苹果服务, direct, img-url=https://raw.githubusercontent.com/Koolson/Qure/master/IconSet/Apple.png
static=🎯 全球直连, direct, img-url=https://raw.githubusercontent.com/Koolson/Qure/master/IconSet/Direct.png
static=🛑 全球拦截, direct, img-url=https://raw.githubusercontent.com/Koolson/Qure/master/IconSet/Advertising.png
static=🐟 漏网之鱼, direct, img-url=https://raw.githubusercontent.com/Koolson/Qure/master/IconSet/Final.png

[server_remote]

[filter_remote]

[rewrite_remote]

[server_local]

[filter_local]

[rewrite_local]

[mitm]

{% endif %}
{% if request.target == "mellow" %}

[Endpoint]
DIRECT, builtin, freedom, domainStrategy=UseIP
REJECT, builtin, blackhole
Dns-Out, builtin, dns

[Routing]
domainStrategy = IPIfNonMatch

[Dns]
hijack = Dns-Out
clientIp = 114.114.114.114

[DnsServer]
localhost
223.5.5.5
8.8.8.8, 53, Remote
8.8.4.4

[DnsRule]
DOMAIN-KEYWORD, geosite:geolocation-!cn, Remote
DOMAIN-SUFFIX, google.com, Remote

[DnsHost]
doubleclick.net = 127.0.0.1

[Log]
loglevel = warning

{% endif %}
{% if request.target == "surfboard" %}

[General]
loglevel = notify
interface = 127.0.0.1
skip-proxy = 127.0.0.1, 192.168.0.0/16, 10.0.0.0/8, 172.16.0.0/12, 100.64.0.0/10, localhost, *.local
ipv6 = false
dns-server = system, 223.5.5.5
exclude-simple-hostnames = true
enhanced-mode-by-rule = true
{% endif %}
{% if request.target == "sssub" %}
{
  "route": "bypass-lan-china",
  "remote_dns": "dns.google",
  "ipv6": false,
  "metered": false,
  "proxy_apps": {
    "enabled": false,
    "bypass": true,
    "android_list": [
      "com.eg.android.AlipayGphone",
      "com.wudaokou.hippo",
      "com.zhihu.android"
    ]
  },
  "udpdns": false
}

{% endif %}
