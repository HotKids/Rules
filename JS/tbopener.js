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

/******************** 转换器 ********************/
let isQuantumultX=$task!=undefined;let isSurge=$httpClient!=undefined;let isLoon=isSurge&&typeof $loon!=undefined;var $task=isQuantumultX?$task:{};var $httpClient=isSurge?$httpClient:{};var $prefs=isQuantumultX?$prefs:{};var $persistentStore=isSurge?$persistentStore:{};var $notify=isQuantumultX?$notify:{};var $notification=isSurge?$notification:{};if(isQuantumultX){var errorInfo={error:"",};$httpClient={get:(url,cb)=>{var urlObj;if(typeof url=="string"){urlObj={url:url,}}else{urlObj=url}
$task.fetch(urlObj).then((response)=>{cb(undefined,response,response.body)},(reason)=>{errorInfo.error=reason.error;cb(errorInfo,response,"")})},post:(url,cb)=>{var urlObj;if(typeof url=="string"){urlObj={url:url,}}else{urlObj=url}
url.method="POST";$task.fetch(urlObj).then((response)=>{cb(undefined,response,response.body)},(reason)=>{errorInfo.error=reason.error;cb(errorInfo,response,"")})},}}
if(isSurge){$task={fetch:(url)=>{return new Promise((resolve,reject)=>{if(url.method=="POST"){$httpClient.post(url,(error,response,data)=>{if(response){response.body=data;resolve(response,{error:error,})}else{resolve(null,{error:error,})}})}else{$httpClient.get(url,(error,response,data)=>{if(response){response.body=data;resolve(response,{error:error,})}else{resolve(null,{error:error,})}})}})},}}
if(isQuantumultX){$persistentStore={read:(key)=>{return $prefs.valueForKey(key)},write:(val,key)=>{return $prefs.setValueForKey(val,key)},}}
if(isSurge){$prefs={valueForKey:(key)=>{return $persistentStore.read(key)},setValueForKey:(val,key)=>{return $persistentStore.write(val,key)},}}
if(isQuantumultX){$notify=((notify)=>{return function(title,subTitle,detail,url=undefined){detail=url===undefined?detail:`${detail}\n点击链接跳转: ${url}`;notify(title,subTitle,detail)}})($notify);$notification={post:(title,subTitle,detail,url=undefined)=>{detail=url===undefined?detail:`${detail}\n点击链接跳转: ${url}`;$notify(title,subTitle,detail)},}}
if(isSurge&&!isLoon){$notification.post=((notify)=>{return function(title,subTitle,detail,url=undefined){detail=url===undefined?detail:`${detail}\n点击链接跳转: ${url}`;notify.call($notification,title,subTitle,detail)}})($notification.post);$notify=(title,subTitle,detail,url=undefined)=>{detail=url===undefined?detail:`${detail}\n点击链接跳转: ${url}`;$notification.post(title,subTitle,detail)}}
if(isLoon){$notify=(title,subTitle,detail,url=undefined)=>{$notification.post(title,subTitle,detail,url)}}
/******************** 转换器 ********************/

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
