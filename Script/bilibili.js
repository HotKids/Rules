/*
Surge:

[URL Rewrite]
^https?:\/\/api\.bilibili\.com\/pgc\/player\/api\/playurl https://bili.miao.best/geturl/maom/ 302

[Script]
http-response ^https?:\/\/api\.bilibili\.com\/pgc\/view\/app\/season requires-body=1,max-size=0,script-path=https://raw.githubusercontent.com/JO2EY/Rules/master/Script/bilibili.js

QuantumultX:

^https?:\/\/api\.bilibili\.com\/pgc\/player\/api\/playurl url 302 https://bili.miao.best/geturl/maom/
^https?:\/\/api\.bilibili\.com\/pgc\/view\/app\/season url script-response-body https://raw.githubusercontent.com/JO2EY/Rules/master/Script/bilibili.js

MITM = api.bilibili.com

*/

let obj = JSON.parse($response.body);
obj["result"]["user_status"]["vip"] = 1;
$done({body: JSON.stringify(obj)});
