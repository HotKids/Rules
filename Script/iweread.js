var body = $response.body;
const path1 = "/pay/memberCardSummary";
const path2 = "/pay/balance";
var path = $request.path;
function modify_card() {
  let obj = JSON.parse(body);
  obj["remainCoupon"] = 99999;
  obj["expiredTime"] = 1594223999;
  obj["expired"] = 0;
  obj["remainTime"] = 2678400;
  body = JSON.stringify(obj);
}

function modify_balance() {
  let obj = JSON.parse(body);
  obj["balance"] = 200;
  obj["giftBalance"] = 100;
  obj["peerBalance"] = 100;
  body = JSON.stringify(obj);
   }
   
if (path.indexOf(path1) != -1){
  modify_card();
}
if (path.indexOf(path2) != -1 ){
  modify_balance();
}
$done(body);

/**********************************************************
微信读书 Forked from yxiaocai
Surge
[URL Rewrite]
^https?:\/\/p\.du\.163\.com\/readtime\/info\.json - reject
[Script]
http-response ^https?:\/\/i.weread.qq.com\/pay script-path=https://raw.githubusercontent.com/JO2EY/Rules/master/Script/iweread.js,requires-body=true
[MITM]
hostname = i.weread.qq.com

Quantumult X
hostname = i.weread.qq.com
^https?:\/\/i.weread.qq.com\/pay url script-response-body https://raw.githubusercontent.com/JO2EY/Rules/master/Script/iweread.js
OR
^https?:\/\/i.weread.qq.com\/pay\/memberCardSummary url response-body (expiredTime":|remainTime":)\d+,(.?)(red":\d+,)(.*?)(ime":\d+,) response-body $12602963199,2$red":0,$4ime":2602963199,
^https?:\/\/i.weread.qq.com\/pay\/balance url response-body "[Bb]alance":\d(.\d+)? response-body "balance":999999
**********************************************************/
