var body = $response.body;
var obj = JSON.parse(body);

obj["tradeEndTime"] = "1357924680";
body = JSON.stringify(obj);
$done(body);
