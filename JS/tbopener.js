/*
 在微信中点击淘宝链接，点击 Surge/QuantumultX 通知自动跳转到淘宝 App
 修改自@江湖中人

/*********************
QuantumultX 远程脚本配置:
**********************
[rewrite_local]
^https?:\/\/weixin110\.qq\.com\/cgi-bin\/mmspamsupport-bin\/newredirectconfirmcgi url script-response-body https://raw.githubusercontent.com/HotKids/Rules/master/JS/tbopener.js
[mitm] 
hostname= weixin110.qq.com
**********************
Surge 4.2.0+ 脚本配置:
**********************
[Script]
tbopener.js = type=http-response,pattern=^https?:\/\/weixin110\.qq\.com\/cgi-bin\/mmspamsupport-bin\/newredirectconfirmcgi,script-path=https://raw.githubusercontent.com/HotKids/Rules/master/JS/tbopener.js
[MITM] 
hostname= weixin110.qq.com
*/

var str = ($response.body);

str = str.match(/:&#x2f;&#x2f;(\S*)"}/)[1]
str = str.replace(/&#x2f;/g, '/');
str = str.replace(/&amp;/g, '&');
console.log(str);

const $ = new cmp()

let opener = "taobao://"+str

$.notify(``, "", "🛍️点击打开淘宝", opener)

$done({body: $response.body});

function cmp() {
    _isQuanX = typeof $task != "undefined"
    _isLoon = typeof $loon != "undefined"
    _isSurge = typeof $httpClient != "undefined" && !_isLoon
    this.notify = (title, subtitle, message, url) => {
        if (_isLoon) $notification.post(title, subtitle, message, url)
        if (_isQuanX) $notify(title, subtitle, message, { "open-url": url })
        if (_isSurge) $notification.post(title, subtitle, message, { url: url })
    }
}
