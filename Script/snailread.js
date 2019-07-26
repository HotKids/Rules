var body = $response.body;
const path = "/gain/readtime/info.json";
var path = $request.path;
function modify_time() {
  let obj = JSON.parse(body);
  obj["tradeEndTime"] = 1679685290;
  body = JSON.stringify(obj);
   }

if (path.indexOf(path) != -1){
  modify_time();
}
$done(body);
