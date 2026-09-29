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

async function ipPanel({client='stash', argument='', store=new Map(), outIP='198.51.100.10',
  outIPv6=null, localIP='203.0.113.2', riskFailure=false, missingNotification=false,
  notificationThrows=false, ipFailure=false, timers=false, ippureData, dnsFailure=false}={}) {
  const requests=[], notifications=[], apiCalls=[], outputs=[], handles=[];
  let deadline;
  try {
    const output=await Promise.race([
      new Promise((resolve,reject)=>{
        const request=(options,cb)=>{
          requests.push(options);
          const url=options.url;
          let body, status=200;
          if(url.includes('bilibili')) body={data:{addr:localIP,country:'中国',province:'广东',city:'深圳',isp:'电信'}};
          else if(url.includes('2606:4700') || url.includes('api-ipv6')) {
            if(outIPv6) body=url.includes('trace')?`ip=${outIPv6}\nloc=SG`:{ip:outIPv6};
            else status=503;
          }
          else if(url.includes('cdn-cgi/trace') || url.includes('api-ipv4')) {
            if(ipFailure) status=503;
            else body=url.includes('trace')?`ip=${outIP}\nloc=SG`:{ip:outIP,country_code:'SG'};
          }
          else if(url.includes('proxycheck')) {
            if(riskFailure) status=503;
            else body={[outIP]:{risk:12,type:'Residential'}};
          }
          else if(url.includes('ippure') || url.includes('scamalytics')) {
            if(riskFailure) {status=503;body='<html>service unavailable</html>';}
            else body=ippureData===undefined?{ip:outIP,isResidential:true,isBroadcast:false,fraudScore:12}:ippureData;
          }
          else if(url.includes('edns')) {if(dnsFailure)status=503;else body={dns:{ip:'203.0.113.53',geo:'China - Example DNS'}};}
          else if(url.includes('opendata.baidu')) body={status:'0',data:[{location:'广东省深圳市 电信'}]};
          else if(url.includes('ip-api.com')) body={status:'success',country:'台湾',countryCode:'TW',regionName:'台湾',city:'台北市',isp:'Example Telecom',org:'Example'};
          else if(url.includes('ipinfo')) body={country:'SG',city:'Singapore',org:'AS64500 Example'};
          else if(url.includes('ip.sb')) body={country_code:'CN',country:'China',city:'Shenzhen',isp:'Example'};
          else throw Error(`unexpected request: ${url}`);
          cb(null,{status},typeof body==='string'?body:JSON.stringify(body||{}));
        };
        const ctx={$argument:argument,$httpClient:{get:request},console:quiet,
          $persistentStore:{read:k=>store.get(k)||null,write:(v,k)=>{store.set(k,v);return true;}},
          $done:o=>{outputs.push(o);resolve(o);}};
        if(client==='stash') {
          ctx.$environment={'stash-version':'1.1.5'};ctx.$script={type:'tile'};
          // No $httpAPI; no JS timers unless explicitly requested.
        } else {
          ctx.$input={purpose:'panel'};
          ctx.$httpAPI=(method,path,body,cb)=>{
            apiCalls.push(path);
            cb(path==='/v1/traffic'?{interface:{en0:{in:2048,out:1024}}}:
              {requests:[{URL:'https://ipinfo.io/test/json',policyName:'Test Proxy',remoteAddress:'192.0.2.1:443 (Proxy)'}]});
          };
        }
        if(timers || client==='surge') {
          ctx.setTimeout=(fn,ms)=>{const h=setTimeout(fn,ms);handles.push(h);return h;};ctx.clearTimeout=clearTimeout;
        }
        if(!missingNotification) ctx.$notification={post:(...args)=>{
          if(notificationThrows) throw Error('notification unavailable');notifications.push(args);
        }};
        try {vm.runInNewContext(read('ip-security.js'),ctx,{timeout:1000});} catch(e){reject(e);}
      }),
      new Promise((_,reject)=>{deadline=setTimeout(()=>reject(Error('IP panel did not finish')),2000);})
    ]);
    // Drain continuations to catch accidental second completion.
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(outputs.length,1);
    return {output,requests,notifications,apiCalls,store};
  } finally {clearTimeout(deadline);handles.forEach(clearTimeout);}
}

test('Stash outbound tile uses Chinese geography without timers or Surge API',async()=>{
  const {output,requests,apiCalls}=await ipPanel({argument:'tile=outbound&proxy=SG%20%E8%8A%82%E7%82%B9&mask_ip=2',outIPv6:'2001:db8::10'});
  assert.equal(output.title,'出口 IP');assert.equal(output.backgroundColor,'#1565C0');
  assert.match(output.content,/🇹🇼/);assert.match(output.content,/台北市/);
  assert.match(output.content,/IPv6：\[IP 已隐藏\]/);assert.doesNotMatch(output.content,/198\.51|203\.0|2001:|流量统计|入口 IP/);
  assert.equal(output['icon-color'],undefined);assert.deepEqual(apiCalls,[]);
  assert.ok(requests.some(r=>r.url.includes('lang=zh-CN')));
  assert.ok(!requests.some(r=>/ippure|proxycheck|scamalytics|edns|opendata/.test(r.url)));
  for(const req of requests){
    assert.ok(req.timeout>0 && req.timeout<=5);
    assert.equal(req.policy,undefined);
    assert.equal(req.headers['X-Stash-Selected-Proxy'],req.url.includes('bilibili')?'DIRECT':encodeURIComponent('SG 节点'));
  }
});
test('Stash risk uses one IPPure request, ignoring other configured risk sources',async()=>{
  const result=await ipPanel({argument:'tile=risk&risk_api=proxycheck&ipqs_key=unused'});
  assert.equal(result.requests.length,1);assert.equal(result.requests[0].url,'https://my.ippure.com/v1/info');
  assert.equal(result.output.title,'IP 纯净度');
  assert.equal(result.output.content,'住宅 · 原生\n12 / 100 · 低风险');
  assert.equal(result.output.backgroundColor,'#88A788');assert.equal(result.notifications.length,0);
});
test('Stash purity preserves classifications without a score and never invents missing types',async()=>{
  for(const [isResidential,isBroadcast,label] of [
    [true,false,'住宅 · 原生'], [true,true,'住宅 · 广播'],
    [false,false,'机房 · 原生'], [false,true,'机房 · 广播'],
    [undefined,undefined,'类型未知 · 来源未知'],
    ['true','false','类型未知 · 来源未知']
  ]) {
    for(const fraudScore of [null,12]) {
      const {output,requests,notifications}=await ipPanel({argument:'tile=risk&mode=collapsed',
        ippureData:{ip:'192.0.2.22',isResidential,isBroadcast,fraudScore}});
      assert.equal(output.title,'IP 纯净度\n'+label);
      assert.doesNotMatch(JSON.stringify(output),/192\.0\.2\.22/);
      assert.equal(output.content,fraudScore===null?'暂无有效评分':'12 / 100 · 低风险');assert.equal(output.backgroundColor,fraudScore===null?'#9E9E9E':'#88A788');
      assert.equal(output.url,'https://ippure.com');
      assert.equal(requests.length,1);assert.equal(requests[0].url,'https://my.ippure.com/v1/info');
      assert.equal(notifications.length,0);
    }
  }
});
test('Stash local tile looks up Baidu via DIRECT without outbound probes',async()=>{
  const {output,requests,notifications}=await ipPanel({argument:'tile=local'});
  assert.equal(output.title,'本地 IP');assert.equal(output.backgroundColor,'#00796B');assert.match(output.content,/203\.0\.113\.2/);
  assert.match(output.content,/广东省深圳市/);assert.match(output.content,/中国电信/);
  assert.equal(requests.length,3);assert.ok(requests.some(r=>r.url.includes('opendata.baidu')));
  assert.ok(requests.every(r=>r.headers['X-Stash-Selected-Proxy']==='DIRECT'));
  assert.equal(notifications.length,0);
});
test('Stash DNS tile displays resolver and Chinese geography without declaring a leak',async()=>{
  const {output,requests,notifications}=await ipPanel({argument:'tile=dns'});
  assert.equal(output.title,'DNS 解析器');assert.match(output.content,/203\.0\.113\.53/);
  assert.match(output.content,/🇹🇼/);assert.match(output.content,/Example Telecom/);assert.doesNotMatch(output.content,/泄露/);
  assert.equal(requests.length,2);assert.equal(notifications.length,0);
});
test('Stash IP notifications establish a baseline then only report changes',async()=>{
  const store=new Map();const argument='notify=true&mask_ip=2';
  assert.equal((await ipPanel({store,argument})).notifications.length,0);
  assert.equal((await ipPanel({store,argument})).notifications.length,0);
  const changed=await ipPanel({store,argument,outIP:'198.51.100.11'});
  assert.equal(changed.notifications.length,1);assert.match(changed.notifications[0][0],/IP 已变化/);
  assert.doesNotMatch(changed.notifications[0].join('\n'),/198\.51|203\.0|泄露/);
  assert.equal((await ipPanel({store,argument,outIP:'198.51.100.11'})).notifications.length,0);
  assert.equal((await ipPanel({store,argument,localIP:null})).notifications.length,0);
  assert.equal((await ipPanel({store,argument:'notify=false',outIP:'198.51.100.12'})).notifications.length,0);
});
test('Stash collapsed IP detection keeps selected-node routing and reports changes',async()=>{
  const store=new Map();
  const argument='mode=collapsed&proxy=Ignored&notify=true';
  for(const outIP of ['198.51.100.10','198.51.100.11']) {
    const result=await ipPanel({store,outIP,argument});
    assert.equal(result.output.title,`出口 IP\n${outIP}`);
    assert.equal(result.notifications.length,outIP==='198.51.100.10'?0:1);
    assert.ok([...store.keys()].some(k=>k.endsWith('lastNetworkInfoEvent')));
    for(const req of result.requests.filter(r=>!r.url.includes('bilibili')))
      assert.equal(req.headers?.['X-Stash-Selected-Proxy'],undefined);
  }
  const outIP='198.51.100.11';
  assert.equal((await ipPanel({store,outIP,argument})).notifications.length,0);
  const beforeFailure=JSON.stringify([...store]);
  assert.equal((await ipPanel({store,outIP,argument,localIP:null})).notifications.length,0);
  assert.equal((await ipPanel({store,outIP,argument,ipFailure:true})).notifications.length,0);
  assert.equal(JSON.stringify([...store]),beforeFailure);
  assert.equal((await ipPanel({store,outIP,argument,localIP:'203.0.113.3'})).notifications.length,1);
  const beforeDisabled=JSON.stringify([...store]);
  assert.equal((await ipPanel({store,argument:'mode=collapsed&notify=false'})).notifications.length,0);
  assert.equal(JSON.stringify([...store]),beforeDisabled);
});
test('Stash collapsed IP summaries keep essential information visible and respect masking',async()=>{
  const outbound=await ipPanel({argument:'tile=outbound&mode=collapsed'});
  assert.equal(outbound.output.title,'出口 IP\n198.51.100.10');
  assert.equal(outbound.output.content,'🇹🇼 台北 · Example');
  assert.equal(outbound.output.url,'https://ipinfo.io/198.51.100.10');
  const local=await ipPanel({argument:'tile=local&mode=collapsed'});
  assert.equal(local.output.title,'本地 IP\n203.0.113.2');
  assert.equal(local.output.content,'🇨🇳 深圳 · 中国电信');
  const risk=await ipPanel({argument:'tile=risk&mode=collapsed'});
  assert.equal(risk.output.title,'IP 纯净度\n住宅 · 原生');
  assert.doesNotMatch(JSON.stringify(risk.output),/198\.51\.100\.10/);
  assert.equal(risk.output.content,'12 / 100 · 低风险');
  assert.equal(risk.output.url,'https://ippure.com');
  for(const service of ['outbound','local','risk']) {
    const {output}=await ipPanel({argument:`tile=${service}&mode=collapsed&mask_ip=2`});
    if(['outbound','local'].includes(service)) assert.match(output.title,/\[IP 已隐藏\]/);
    assert.doesNotMatch(JSON.stringify(output),/198\.51\.100\.10|203\.0\.113\.2/);
    assert.doesNotMatch(output.content,/\n/);
  }
});
test('Stash failures stay unknown and never fall back to other risk services',async()=>{
  const failedRisk=await ipPanel({argument:'tile=risk',riskFailure:true});
  assert.equal(failedRisk.output.backgroundColor,'#9E9E9E');assert.match(failedRisk.output.content,/IPPure 检测失败/);
  assert.equal(failedRisk.requests.length,1);assert.equal(failedRisk.store.size,0);
  for(const data of [{},{fraudScore:null},{fraudScore:''},{fraudScore:false},{fraudScore:101},{fraudScore:-1}]) {
    const bad=await ipPanel({argument:'tile=risk',ippureData:data});
    assert.equal(bad.output.backgroundColor,'#9E9E9E');assert.match(bad.output.content,/暂无有效评分/);
  }
  for(const [score,color] of [[0,'#88A788'],[40,'#D4A017'],[70,'#C44444']]) {
    const valid=await ipPanel({argument:'tile=risk',ippureData:{fraudScore:score}});
    assert.equal(valid.output.backgroundColor,color);
  }
  const failedIP=await ipPanel({ipFailure:true});assert.equal(failedIP.output.title,'出口 IP');
  assert.equal(failedIP.output.backgroundColor,'#9E9E9E');assert.match(failedIP.output.content,/无法获取出口/);
  const localFailure=await ipPanel({argument:'tile=local',localIP:null});
  assert.match(localFailure.output.content,/无法获取直连公网/);assert.equal(localFailure.requests.length,1);
  const dnsFailure=await ipPanel({argument:'tile=dns',dnsFailure:true});
  assert.equal(dnsFailure.output.backgroundColor,'#9E9E9E');assert.equal(dnsFailure.requests.length,1);
});
test('Stash missing or denied notifications still finish the tile',async()=>{
  for(const options of [{missingNotification:true},{notificationThrows:true}]) {
    const store=new Map();await ipPanel({store});
    const result=await ipPanel({...options,store,outIP:'198.51.100.11',timers:true});
    assert.match(result.output.content,/198\.51\.100\.11/);assert.equal(result.notifications.length,0);
  }
});
test('Stash transient IPv6 failure does not report a network change',async()=>{
  const store=new Map();await ipPanel({store,outIPv6:'2001:db8::10'});
  assert.equal((await ipPanel({store})).notifications.length,0);
  assert.equal((await ipPanel({store,outIPv6:'2001:db8::10'})).notifications.length,0);
  assert.equal((await ipPanel({store,outIPv6:'2001:db8::11'})).notifications.length,1);
});
test('Surge IP panel retains policy, entrance, traffic and request routing',async()=>{
  const {output,requests,apiCalls}=await ipPanel({client:'surge'});
  assert.equal(output.title,'代理策略：Test Proxy');assert.equal(output.icon,'leaf.fill');
  assert.equal(output.backgroundColor,undefined);assert.equal(output['icon-color'],'#0D6E3D');
  assert.match(output.content,/入口 IP：192\.0\.2\.1/);assert.match(output.content,/流量统计：↑ 1 KB  ↓ 2 KB/);
  assert.ok(apiCalls.includes('/v1/traffic'));assert.ok(apiCalls.includes('/v1/requests/recent'));
  assert.ok(requests.some(r=>r.url.includes('opendata.baidu')));
  assert.ok(requests.some(r=>r.url.includes('lang=zh-CN')));
  assert.ok(requests.some(r=>r.url.includes('proxycheck'))); // Surge retains its risk fallback chain.
  assert.match(output.content,/🇨🇳/); // Only Stash defaults its Taiwan flag to tw.
  assert.equal(requests.find(r=>r.url.includes('bilibili')).policy,'DIRECT');
  assert.equal(requests.find(r=>r.url.includes('edns')).policy,'Test Proxy');
  assert.ok(requests.every(r=>!r.headers?.['X-Stash-Selected-Proxy']));
});
