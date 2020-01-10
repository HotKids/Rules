const path1 = "/app/user/pro/stat?";
const path2 = "/app/user/init?";
const path3 = "/app/user/pay/checkIntroOfferPeriod?";

const url = $request.url;
let body = $response.body;

if (url.indexOf(path1) != -1){
body = JSON.parse(body);
body.data.isActive = true;
body.data.expireDate = "2029-10-02 10:49:24";
body = JSON.stringify(body);
}

if (url.indexOf(path2) != -1){
body = JSON.parse(body);
body.data.isProActive = true;
body.data.expireDate = "2029-10-02 10:49:24";
body = JSON.stringify(body);
}

if (url.indexOf(path3) != -1){
body = JSON.parse(body);
body.data.hasIntroPeriod = true;
body = JSON.stringify(body);
}

$done({body})