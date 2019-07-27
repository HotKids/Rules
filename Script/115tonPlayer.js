$notify('播放地址提取成功, 长按(重按)通知查看', '',  'nplayer-' + $request.url);
$done({});

/**********************************************************
提取115中的视频使用 nPlayer 进行播放

^https?:\/\/.*\.115\.com\/.*\.m3u8.* url script-response-body https://raw.githubusercontent.com/JO2EY/Rules/master/Script/115tonPlayer.js
**********************************************************/
