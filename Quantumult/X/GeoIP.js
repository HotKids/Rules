// if ($response.statusCode != 200) {
//   $done(Null);
// }

// var body = $response.body;
// var obj = JSON.parse(body);

if ($response.statusCode != 200) {
  $done(Null);
}

function ValidCheck(para) {
  if(para) {
  return para
  } else
  {
  return obj['capital']
  }
}

var body = $response.body;
var obj = JSON.parse(body);
var title = obj['country_flag_emoji'] + obj['country_name'];
var subtitle = '⛱️'+ValidCheck(obj['city'])+' - '+obj['ip'];
var ip = obj['ip'];
var description = obj['country_name'] + '-' +ValidCheck(obj['city']) + obj['ip'];

$done({title, subtitle, ip, description});
