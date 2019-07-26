let result = JSON.parse(body);

delete result.data.boot;
delete result.data.bootAnimation;

JSON.stringify(result);

/**********************************************************
毒去广告
Surge
[Script]
http-request ^https?:\/\/.*\.115\.com\/.*\.m3u8.*$ script-path=https://raw.githubusercontent.com/JO2EY/Rules/master/Script/Poizon.js,requires-body=true
[MITM]
hostname = m.poizon.com

Quantumult X
^https?:\/\/.*\.115\.com\/.*\.m3u8.*$ url script-response-body https://raw.githubusercontent.com/JO2EY/Rules/master/Script/Poizon.js
**********************************************************/
