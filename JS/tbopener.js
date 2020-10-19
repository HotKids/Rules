/*
 在微信中点击淘宝链接，点击 Surge/QuantumultX 通知自动跳转到淘宝 App
 @江湖中人

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
console.log(str);//结果bbbcccdddeee 

var option1={"open-url": "taobao://"}
	option1["open-url"]="taobao://"+str
	$notify(``, "","🛍️点击打开淘宝", option1);
console.log(option1["open-url"])

$done({body: $response.body});
