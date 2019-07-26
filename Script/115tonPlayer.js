/*
提取115中的视频使用 nPlayer 进行播放.
使用方法：
1.在[Script]分组下添加下面这行配置
http-request ^https?:\/\/.*\.115\.com\/.*\.m3u8.*$ script-path=https://raw.githubusercontent.com/JO2EY/Rules/master/Script/115tonPlayer.js
^https?:\/\/.*\.115\.com\/.*\.m3u8.*$ url script-response-body https://raw.githubusercontent.com/JO2EY/Rules/master/Script/115tonPlayer.js
*/

$notify('播放地址提取成功, 长按(重按)通知查看', '',  'nplayer-' + $request.url);
$done({});
