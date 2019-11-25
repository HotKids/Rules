/*
add deviceID to QuantumultX remote script
QuantumultX:
^https?:\/\/(raw.githubusercontent|\w+\.github)\.(com|io)\/.*\.js$ url script-response-body QuantumultX.js

MITM = raw.githubusercontent.com, *.github.io
*/


var body = $response.body;
body = '\/*\n@supported 643679A71911\n*\/\n' + body;
$done(body);
