/*
 在微博中打开第三方链接，点击 Surge/QuantumultX 通知跳转到 Safari
 by @XIAO_KOP
 /*********************
QuantumultX 远程脚本配置:
**********************
[rewrite_local]
^https?:\/\/weibo\.cn\/sinaurl url script-request-header https://raw.githubusercontent.com/HotKids/Rules/master/JS/weibourl.js
[mitm] 
hostname= weibo.cn
**********************
Surge 4.2.0+ 脚本配置:
**********************
[Script]
weibourl.js = type=http-request,pattern=^https?:\/\/weibo\.cn\/sinaurl,script-path=https://raw.githubusercontent.com/HotKids/Rules/master/JS/weibourl.js
[MITM] 
hostname= weibo.cn
*/

var url = decodeURIComponent($request.url.split("toasturl=")[1])


const $ = new cmp()

$.notify("👽去你大爷的内置浏览器", "", "🔗点击打开链接", url)

$done({});


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
