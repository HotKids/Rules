const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const read = name => fs.readFileSync(path.join(root, 'Surge/Module/Scripts', name), 'utf8');
const quiet = {log(){},error(){}};

async function tile(service, response) {
  const requests = [];
  let deadline;
  try {
    const output = await Promise.race([
      new Promise((resolve, reject) => {
        const request = (options, cb) => {
          requests.push(options);
          const r = typeof response === 'function' ? response(options) : response;
          cb(r.error || null, {status:r.status || 200, headers:r.headers || {}}, r.body || '');
        };
        const ctx = {$environment:{'stash-version':'1.1.5'}, $script:{type:'tile'},
          $argument:`service=${service}&mode=collapsed&notify=false&nfprice=false`,
          $httpClient:{get:request,post:request},$done:resolve,console:quiet,
          $persistentStore:{read:()=>null,write:()=>true}};
        // Intentionally no setTimeout/clearTimeout: Android Stash compatibility.
        try {vm.runInNewContext(read('media-check.js'),ctx,{timeout:1000});} catch(e){reject(e);}
      }),
      new Promise((_,reject)=>{deadline=setTimeout(()=>reject(Error('tile did not finish')),2000);})
    ]);
    return {output,requests};
  } finally {clearTimeout(deadline);}
}

test('Spotify locale, no JS timers, brand color', async()=>{
  const {output,requests}=await tile('spotify',{body:'<a href="https://www.spotify.com/hk-zh/premium/">Premium</a>'});
  assert.equal(output.content,'HK');assert.equal(output.backgroundColor,'#117C39');
  assert.equal(requests[0].timeout,8);
});
test('Unavailable service uses NO and grey',async()=>{
  const {output}=await tile('spotify',{body:'not available'});
  assert.equal(output.content,'NO');assert.equal(output.backgroundColor,'#8E8E93');
});
test('HTTP 503 remains an error',async()=>{
  const {output}=await tile('spotify',{status:503});
  assert.equal(output.content,'Error');assert.equal(output.backgroundColor,'#8E8E93');
});
test('Missing timer error is not mislabeled timeout',async()=>{
  const {output}=await tile('spotify',{error:'ReferenceError: setTimeout is not defined'});
  assert.equal(output.content,'Error');
});
test('YouTube explicit unsupported country beats country code',async()=>{
  const {output,requests}=await tile('youtube',{body:'"countryCode":"HK" YouTube Premium is not available in your country'});
  assert.equal(requests.length,2);assert.equal(output.content,'NO');
});

test('Komari preserves regex and token equals signs',()=>{
  const code=read('komari-traffic.js');const ctx={$argument:'nodes=^(?=.*HK)&token=abc==&url=https%3A%2F%2Fexample.invalid'};
  vm.createContext(ctx);vm.runInContext(code.slice(code.indexOf('const args ='),code.indexOf('const clean ='))+'\nglobalThis.parsed=args;',ctx);
  assert.equal(ctx.parsed.nodes,'^(?=.*HK)');assert.equal(ctx.parsed.token,'abc==');
  assert.equal(ctx.parsed.url,'https://example.invalid');
});

async function friday(response, rejected=false) {
  const code=read('friday-checkin.js');
  const part=code.slice(code.indexOf('async function doSign('),code.indexOf('function req('))+
    code.slice(code.indexOf('function Checkin('),code.indexOf('function Points('));
  const ctx={store:{},CODE:{OK:'0000',SIGNED:'2302'},today:()=> '2026-09-29',
    req:()=>rejected?Promise.reject(Error('timeout')):Promise.resolve(response),Points:async()=>'',
    $:{debug(){},toStr:JSON.stringify,error(){},setjson(){},name:'test'}};
  vm.createContext(ctx);await vm.runInContext(part+'\ndoSign("token",store)',ctx);
  return ctx.store;
}
test('friDay failures leave retry available',async()=>{
  for(const r of [{status:500,data:{}},{status:200,data:{code:'9999'}},{status:401,data:{}}])
    assert.equal((await friday(r)).signedDate,undefined);
  assert.equal((await friday(null,true)).signedDate,undefined);
});
test('friDay success and already-signed save the date',async()=>{
  for(const code of ['0000','2302']) assert.equal((await friday({status:200,data:{code}})).signedDate,'2026-09-29');
});
test('Unknown risk never renders a numeric score',()=>{
  const code=read('ip-security.js');const part=code.slice(code.indexOf('function riskText('),code.indexOf('function maskIP('));
  const ctx={CONFIG:{riskLevels:[{max:100,label:'Risk',color:'#123456'}]}};
  vm.createContext(ctx);vm.runInContext(part,ctx);
  assert.equal(ctx.formatRisk({score:null,source:'Unavailable'}),'未知（检测失败）');
  assert.equal(ctx.riskText(null).color,'#9E9E9E');
  assert.match(ctx.formatRisk({score:0,source:'Test'}),/^0%/);
});

test('Generated Mihomo scripts run with both subscription variants',()=>{
  for(const name of fs.readdirSync(path.join(root,'Clash/Script')).filter(n=>n.endsWith('.js'))){
    const code=fs.readFileSync(path.join(root,'Clash/Script',name),'utf8');
    const main=new Function(code+'\nreturn main;')();
    for(const input of [{proxies:[{name:'HK01',type:'ss',server:'1.2.3.4'}]},
      {proxies:[{name:'US 02',type:'vmess',server:'n.example'}],dns:{'proxy-server-nameserver':['https://p.example/dq']},hosts:{'n.example':'1.2.3.4'}}]) {
      const output=main(input);
      assert.ok(output['proxy-groups'].length);assert.ok(output.rules.length);
    }
  }
});
