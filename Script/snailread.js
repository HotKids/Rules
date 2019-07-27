var body = $response.body;
var obj = JSON.parse(body);

obj.tradeEndTime = 1679685290000;
body = JSON.stringify(obj);
$done(body);

/**********************************************************
网易蜗牛读书
Surge
[URL Rewrite]
^https?:\/\/p\.du\.163\.com\/readtime\/info\.json - reject
[Script]
http-response ^https?:\/\/p\.du\.163\.com\/gain\/readtime\/info\.json script-path=https://raw.githubusercontent.com/JO2EY/Rules/master/Script/snailread.js,requires-body=true
[MITM]
hostname = p.du.163.com

Quantumult X Forked from yxiaocai
hostname = p.du.163.com
^https?:\/\/p\.du\.163\.com\/readtime\/info.json url reject-img
以下二选一
^https?:\/\/p\.du\.163\.com\/gain\/readtime\/info\.json url script-response-body https://raw.githubusercontent.com/JO2EY/Rules/master/Script/snailread.js
^https?:\/\/p\.du\.163\.com\/gain\/readtime\/info.json url response-body "tradeEndTime":\d{10} response-body "tradeEndTime":1679685290
**********************************************************/
