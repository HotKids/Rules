// if ($response.statusCode != 200) {
//   $done(Null);
// }

function getRandomInt(max) {
  return Math.floor(Math.random() * Math.floor(max));
}

function ValidCheck(para) {
  if(para) {
  return para
  } else
  {
  return obj['country_flag_emoji']
  }
}

var flags = new Map([[ "TW" , "🇨🇳" ])
var body = $response.body;
var bd=body.split('\n')[1];
//$notify("test","test",bd);
var obj = JSON.parse(bd);
var title = flags.get(ValidCheck(obj['country_code'])) + ' '+ obj['country_name']+ obj['city'];
var subtitle ='⛱️ '+obj['continent_name']+'-'+obj['longitude']+obj['latitude'];
var ip = obj['ip'];
var description = obj['country_name'] + '-' +obj['city'] + '\n' + obj['type'] + '\n' + obj['ip'];
$done({title, subtitle, ip, description});
