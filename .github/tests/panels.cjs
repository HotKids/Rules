const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const read = name => fs.readFileSync(path.join(root, 'Surge/Module/Scripts', name), 'utf8');
const quiet = {log(){},error(){}};

async function tile(service, response, {client="stash", argument="", store=new Map()}={}) {
  const requests = [];
  let deadline;
  try {
    const output = await Promise.race([
      new Promise((resolve, reject) => {
        const request = (options, cb) => {
          requests.push(options);
          const r = typeof response === 'function' ? response(options) : response;
          cb(r.error || null, {status:r.status || 200, headers:r.headers || {}, url:r.url, responseURL:r.responseURL},
            r.body == null ? '' : typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
        };
        const ctx = {$environment:client==='stash'?{'stash-version':'1.1.5'}:{'surge-version':'5'}, $script:{type:client==='stash'?'tile':'generic'},
          $argument:`service=${service}&mode=collapsed&notify=false&nfprice=false&${argument}`,
          $httpClient:{get:request,post:request},$done:resolve,console:quiet,
          $persistentStore:{read:k=>store.get(k)||null,write:(v,k)=>{store.set(k,v);return true;}}};
        // Intentionally no setTimeout/clearTimeout: Android Stash compatibility.
        try {vm.runInNewContext(read('media-check.js'),ctx,{timeout:1000});} catch(e){reject(e);}
      }),
      new Promise((_,reject)=>{deadline=setTimeout(()=>reject(Error('tile did not finish')),2000);})
    ]);
    return {output,requests};
  } finally {clearTimeout(deadline);}
}

test('Spotify locale, no JS timers, brand color', async()=>{
  const {output,requests}=await tile('spotify',{body:'<link rel="canonical" href="https://www.spotify.com/hk-zh/premium/">'});
  assert.equal(output.content,'HK');assert.equal(output.backgroundColor,'#117C39');
  assert.equal(requests[0].timeout,8);
});
test('Unavailable service uses NO and grey',async()=>{
  const {output}=await tile('spotify',{body:'Spotify is not available in your country'});
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
  assert.equal(requests.length,1);assert.equal(output.content,'NO');
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
  notificationThrows=false, ipFailure=false, timers=false, ippureData, dnsFailure=false,
  scriptType='tile', intercept, now, storageThrows=false}={}) {
  const requests=[], notifications=[], apiCalls=[], outputs=[], handles=[];
  let deadline;
  try {
    const output=await Promise.race([
      new Promise((resolve,reject)=>{
        const request=(options,cb)=>{
          requests.push(options);
          if(intercept && intercept(options,cb)) return;
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
          $persistentStore:{read:k=>{if(storageThrows)throw Error("store unavailable");return store.get(k)||null;},write:(v,k)=>{if(storageThrows)throw Error("store unavailable");store.set(k,v);return true;}},
          $done:o=>{outputs.push(o);resolve(o);}};
        if(client==='stash') {
          ctx.$environment={'stash-version':'1.1.5'};ctx.$script={type:scriptType};
          // No $httpAPI; no JS timers unless explicitly requested.
        } else {
          ctx.$input={purpose:'panel'};
          ctx.$httpAPI=(method,path,body,cb)=>{
            apiCalls.push(path);
            cb(path==='/v1/traffic'?{interface:{en0:{in:2048,out:1024}}}:
              {requests:[{URL:'https://ipinfo.io/test/json',policyName:'Test Proxy',remoteAddress:'192.0.2.1:443 (Proxy)'}]});
          };
        }
        if(now!==undefined)ctx.Date=class extends Date{static now(){return now;}};
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
  assert.equal(output.url,'https://ippure.com/?ip=203.0.113.2');
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
const monitor = (options={}) => ipPanel({...options, scriptType:'cron',
  argument:'task=monitor&notify=true&'+(options.argument||'')});
test('Stash scheduled notifications establish independent field baselines',async()=>{
  const store=new Map(), argument='mask_ip=2';
  assert.equal((await monitor({store,argument})).notifications.length,0);
  assert.equal((await monitor({store,argument})).notifications.length,0);
  const changed=await monitor({store,argument,outIP:'198.51.100.11',localIP:null});
  assert.equal(changed.notifications.length,1);assert.match(changed.notifications[0][0],/IP 已变化/);
  assert.doesNotMatch(changed.notifications[0].join('\n'),/198\.51|203\.0/);
  assert.deepEqual(JSON.parse(JSON.stringify(changed.output)),{});
  assert.ok(changed.requests.every(r=>/bilibili|cdn-cgi\/trace|api-ipv[46]/.test(r.url)));
  assert.equal((await monitor({store,argument,outIP:'198.51.100.11'})).notifications.length,0);
  const localChanged=await monitor({store,localIP:'203.0.113.3',ipFailure:true});
  assert.equal(localChanged.notifications.length,1);assert.match(localChanged.notifications[0][2],/本地 IP/);
  assert.doesNotMatch(localChanged.notifications[0][2],/出口 IP/);
  const disabled=await monitor({store,argument:'notify=false',outIP:'198.51.100.12'});
  assert.equal(disabled.notifications.length,0);assert.equal(disabled.requests.length,0);
});
test('Stash node testing never changes scheduled notification baselines',async()=>{
  const store=new Map();await monitor({store});
  const key=[...store.keys()].find(k=>k.includes('monitor.v2'));
  const baseline=store.get(key);
  for(const mode of ['collapsed','home'])for(const outIP of ['198.51.100.20','198.51.100.30']) {
    const result=await ipPanel({store,outIP,argument:`mode=${mode}&notify=true`});
    assert.equal(result.notifications.length,0);assert.equal(store.get(key),baseline);
    assert.equal(result.output.icon,undefined);
    if(mode==='collapsed') {
      assert.equal(result.output.title,`出口 IP\n${outIP}`);
      assert.ok(!result.requests.some(r=>/bilibili|ipv6|2606:4700/.test(r.url)));
    }
    for(const req of result.requests)assert.equal(req.headers?.['X-Stash-Selected-Proxy'],undefined);
  }
  const wrongContext=await ipPanel({store,argument:'task=monitor&notify=true',outIP:'198.51.100.99'});
  assert.equal(wrongContext.notifications.length,0);assert.equal(wrongContext.requests.length,0);
  assert.equal(store.get(key),baseline);
  assert.equal((await monitor({store,outIP:'198.51.100.11'})).notifications.length,1);
});
test('Stash collapsed IP summaries keep essential information visible and respect masking',async()=>{
  const outbound=await ipPanel({argument:'tile=outbound&mode=collapsed'});
  assert.equal(outbound.output.title,'出口 IP\n198.51.100.10');
  assert.equal(outbound.output.content,'🇹🇼 台北 · Example');
  assert.equal(outbound.output.url,'https://ippure.com');
  const local=await ipPanel({argument:'tile=local&mode=collapsed'});
  assert.equal(local.output.title,'本地 IP\n203.0.113.2');
  assert.equal(local.output.content,'🇨🇳 深圳 · 中国电信');
  assert.equal(local.output.url,'https://ippure.com/?ip=203.0.113.2');
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
    assert.equal(output.url,'https://ippure.com');
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
  assert.equal(localFailure.output.url,'https://ippure.com');
  const dnsFailure=await ipPanel({argument:'tile=dns',dnsFailure:true});
  assert.equal(dnsFailure.output.backgroundColor,'#9E9E9E');assert.equal(dnsFailure.requests.length,1);
});
test('Stash failed notifications retain changes for a later retry',async()=>{
  for(const options of [{missingNotification:true},{notificationThrows:true}]) {
    const store=new Map();await monitor({store});
    const before=JSON.stringify([...store]);
    const result=await monitor({...options,store,outIP:'198.51.100.11',timers:true});
    assert.equal(result.notifications.length,0);assert.equal(JSON.stringify([...store]),before);
    assert.equal((await monitor({store,outIP:'198.51.100.11'})).notifications.length,1);
    assert.equal((await monitor({store,outIP:'198.51.100.11'})).notifications.length,0);
  }
});
test('Stash transient IPv6 failure does not report a network change',async()=>{
  const store=new Map();await monitor({store,outIPv6:'2001:db8::10'});
  assert.equal((await monitor({store})).notifications.length,0);
  assert.equal((await monitor({store,outIPv6:'2001:db8::10'})).notifications.length,0);
  assert.equal((await monitor({store,outIPv6:'2001:db8::11'})).notifications.length,1);
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

const spotifyConfig = market => `<script type="text/plain" id="appServerConfig">${Buffer.from(JSON.stringify({market,label:'地区'})).toString('base64')}</script>`;
test('Spotify reads market without atob and ignores alternate country links',async()=>{
  const primary=await tile('spotify',{body:spotifyConfig('HK')+'<a href="https://www.spotify.com/us/">US</a>'});
  assert.equal(primary.output.content,'HK');assert.equal(primary.requests.length,1);
  const fallback=await tile('spotify',o=>o.url.includes('open.spotify')?{body:'<html>changed</html>'}:
    {body:'<link rel="alternate" href="https://www.spotify.com/us/premium/"><link rel="canonical" href="https://www.spotify.com/hk-zh/premium/">'});
  assert.equal(fallback.output.content,'HK');
  for(const body of ['<a href="https://www.spotify.com/us/">US</a>','<script id="appServerConfig">bad encoding!</script>','<html>unknown</html>'])
    assert.equal((await tile('spotify',{body})).output.content,'Error');
});
test('Gemini maps ISO regions and keeps availability without a country',async()=>{
  for(const [code,expected] of [['KOR','KR'],['AUT','AT'],['CHE','CH'],['CHN','CN'],['HKG','HK'],['SGP','SG'],['US','US'],['XXX','OK']]) {
    const result=await tile('gemini',{body:`45617354,null,true ,2,1,200,"${code}"`});
    assert.equal(result.output.content,expected);
  }
  assert.equal((await tile('gemini',{body:'45631641,null,true'})).output.content,'OK');
  assert.equal((await tile('gemini',{body:'<html>unknown</html>'})).output.content,'Error');
});
test('Gemini API fallback distinguishes valid models, rate limits and invalid keys',async()=>{
  for(const [response,expected] of [[{body:{models:[]}},'OK'],[{status:429,body:'rate limited'},'Rate Limited'],
    [{status:400,body:'API_KEY_INVALID'},'Invalid Key'],[{status:400,body:'User location is not supported'},'NO']]) {
    const result=await tile('gemini',o=>o.url.includes('generativelanguage')?response:{body:'unknown page'},
      {argument:'geminiapikey=example'});
    assert.equal(result.output.content,expected);
  }
});
test('AI services do not turn HTTP errors and browser challenges into availability',async()=>{
  for(const service of ['chatgpt','claude','gemini'])for(const [status,body,expected] of [
    [403,'<title>Just a moment...</title>','Verify'],[429,'too many requests','Rate Limited'],
    [403,'Forbidden','Error'],[200,'<script src="/cdn-cgi/challenge-platform/test"></script>','Verify']]) {
    const result=await tile(service,o=>o.url.includes('trace')?{body:'loc=SG\n'}:{status,body});
    assert.equal(result.output.content,expected,service);assert.equal(result.output.backgroundColor,'#8E8E93');
  }
});
test('ChatGPT keeps one result and only uses Only labels for confirmed restrictions',async()=>{
  for(const [web,app,expected] of [[false,false,'SG'],[false,true,'Web Only'],[true,false,'Mobile Only'],[true,true,'NO']]) {
    const result=await tile('chatgpt',o=>o.url.includes('trace')?{body:'loc=SG\n'}:
      o.url.includes('ios.chat')?(app?{status:403,body:{error:{code:'unsupported_country_region_territory'}}}:{body:'App landing'}):
      web?{status:403,body:'unsupported_country'}:{body:{requires_cookie_consent:false}});
    assert.equal(result.output.title,'ChatGPT');assert.equal(result.output.content,expected);
  }
  for(const body of ['disallowed isp','You have been blocked','blocked_why_headline','{"cf_details":"blocked (1)"}']) {
    const result=await tile('chatgpt',o=>o.url.includes('trace')?{error:'Timeout'}:o.url.includes('ios.chat')?{status:403,body}:{body:'{}'});
    assert.equal(result.output.content,'Web Only');
  }
  const unknown=await tile('chatgpt',o=>o.url.includes('ios.chat')?{error:'Timeout'}:{body:'{}'});
  assert.equal(unknown.output.content,'Timeout');
});
test('Netflix needs a title page and independent original-title confirmation',async()=>{
  for(const body of ['', '<html>generic home</html>', '<title>Just a moment...</title>']) {
    const r=await tile('netflix',{body});assert.notEqual(r.output.content,'US');assert.equal(r.output.backgroundColor,'#8E8E93');
  }
  assert.equal((await tile('netflix',{body:'<title>Watch Example | Netflix</title>'})).output.content,'OK');
  const originals=await tile('netflix',o=>o.url.includes('80197526')?
    {body:'<title>Watch Original | Netflix</title>',headers:{'X-Originating-Url':o.url.replace('/title/','/hk/title/')}}:
    {status:404,body:'Not found'});
  assert.equal(originals.output.content,'HK (Originals)');assert.equal(originals.requests.length,3);
  const denied=await tile('netflix',{status:404,body:'Not found'});assert.equal(denied.output.content,'NO');
});
test('Netflix prices have a short timeout and use cached data on refresh failure',async()=>{
  const store=new Map([['stash_media_check_nf_prices_v1',JSON.stringify({ts:1,body:JSON.stringify([
    {country_code:'HK',currency:'HKD',plans:[{name:'premium',price:118}]}
  ])})]]);
  const r=await tile('netflix',o=>o.url.includes('latest.json')?{error:'Timeout'}:
    {body:'<title>Watch Example | Netflix</title> "id":"hk","countryName":"Hong Kong"'},
    {argument:'nfprice=true',store});
  assert.equal(r.requests.find(o=>o.url.includes('latest.json')).timeout,2);
  assert.equal(r.output.content,'HK | 118 HKD');
});
test('Disney requires explicit support flags and does not invent coming status',async()=>{
  for(const [flag,expected] of [[true,'SG'],[false,'NO'],['true','SG'],['false','NO'],[undefined,'Error']]) {
    const r=await tile('disney',o=>o.url.includes('graphql')?
      {body:{extensions:{sdk:{session:{inSupportedLocation:flag,location:{countryCode:'SG'}}}}}}:
      {status:403,body:'Forbidden'});
    assert.equal(r.output.content,expected);
  }
});
test('YouTube uses one normal request and can recover a failed primary probe',async()=>{
  const primary=await tile('youtube',{body:'ad-free "INNERTUBE_CONTEXT_GL": "HK"'});
  assert.equal(primary.output.content,'HK');assert.equal(primary.requests.length,1);
  const fallback=await tile('youtube',o=>o.headers.Cookie?{body:'purchaseButtonOverride "contentRegion":"SG"'}:{error:'Timeout'});
  assert.equal(fallback.output.content,'SG');assert.equal(fallback.requests.length,2);
  for(const body of ['"contentRegion":"SG"','<html>unknown</html>'])
    assert.equal((await tile('youtube',{body})).output.content,'Error');
});
test('Meta AI shows legal redirect region and tolerates a failed optional lookup',async()=>{
  for(const legal of [{url:'https://www.meta.com/sg/legal/',body:'Legal'},
    {body:'<link rel="canonical" href="https://www.meta.com/sg/legal/">'}]) {
    const r=await tile('metaai',o=>o.url.endsWith('/ajax')?{status:404,body:'Not found'}:legal);
    assert.equal(r.output.title,'Meta AI');assert.equal(r.output.content,'SG');assert.equal(r.output.backgroundColor,'#0866FF');
    assert.equal(r.requests[1].timeout,1);
  }
  const failed=await tile('metaai',o=>o.url.endsWith('/ajax')?{status:400,body:'Bad request'}:{error:'Timeout'});
  assert.equal(failed.output.content,'OK');
});
test('Meta AI home fallback requires evidence and distinguishes blocked/rate-limited pages',async()=>{
  for(const [home,expected] of [[{body:'KadabraRootContainer "code":"en_US"'},'US'],
    [{body:'GeoBlockedErrorRoot'},'NO'],[{body:'AbraRateLimitedErrorRoot'},'Rate Limited'],
    [{status:403,body:'Forbidden'},'Error'],[{body:'<title>Just a moment...</title>'},'Verify'],[{body:'generic home'},'Error']]) {
    const r=await tile('metaai',o=>o.url.endsWith('/ajax')?{status:403,body:'Forbidden'}:home);
    assert.equal(r.output.content,expected);
  }
  assert.equal((await tile('metaai',{status:429,body:'slow down'})).output.content,'Rate Limited');
});
test('TikTok checks fallback status, regions and explicit Hong Kong restriction',async()=>{
  const first=await tile('tiktok',{body:'"region":"SG"'});assert.equal(first.output.content,'SG');assert.equal(first.requests.length,1);
  const fallback=await tile('tiktok',o=>o.url.endsWith('/explore')?{body:'unknown'}:{body:'"region": "US"'});
  assert.equal(fallback.output.content,'US');assert.equal(fallback.requests.length,2);
  for(const response of [{status:200,body:'https://www.tiktok.com/hk/notfound'},
    {status:404,url:'https://www.tiktok.com/hk/notfound',body:'Not found'}])assert.equal((await tile('tiktok',response)).output.content,'NO');
  const rejected=await tile('tiktok',o=>o.url.endsWith('/explore')?{body:'unknown'}:{status:403,body:'"region":"US"'});
  assert.equal(rejected.output.content,'Error');
  assert.equal((await tile('tiktok',{body:'<title>Just a moment...</title>'})).output.content,'Verify');
});
test('Surge and Stash summaries include all eleven services in the requested order',async()=>{
  const response=o=>{
    const u=o.url;
    if(u.includes('netflix'))return {body:'<title>Watch Example | Netflix</title>'};
    if(u.includes('graphql'))return {body:{extensions:{sdk:{session:{inSupportedLocation:true,location:{countryCode:'SG'}}}}}};
    if(u.includes('disneyplus'))return {body:'Region: SG CNBL: 1'};
    if(u.includes('hbomax'))return {body:'<script id="__NEXT_DATA__">{"props":{"pageProps":{"userCountry":"SG","isUserOutOfRegion":false}}}</script>'};
    if(u.includes('youtube'))return {body:'ad-free "countryCode":"SG"'};
    if(u.includes('spotify'))return {body:spotifyConfig('SG')};
    if(u.includes('trace'))return {body:'loc=SG\n'};
    if(u.includes('gemini'))return {body:'45631641,null,true ,2,1,200,"SGP"'};
    if(u.includes('meta.ai'))return {body:'KadabraRootContainer "code":"en_SG"'};
    if(u.includes('tiktok'))return {body:'"region":"SG"'};
    if(u.includes('viu'))return {body:'/ott/hk/'};
    return {body:'<html>Welcome</html>'};
  };
  for(const client of ['stash','surge']) {
    const r=await tile('all',response,{client});
    const names=r.output.content.split('\n').map(line=>line.split('➟')[0].trim());
    assert.deepEqual(names,['Netflix','Disney+','HBO Max','YouTube','Spotify','ChatGPT','Claude','Gemini','Meta AI','TikTok','Reddit']);
    assert.match(r.output.title,/11\/11/);
    assert.ok(r.output[client==='stash'?'backgroundColor':'icon-color']);
  }
  const viu=await tile('all',response,{client:'surge',argument:'viu=true'});
  assert.match(viu.output.title,/12\/12/);assert.match(viu.output.content.split('\n')[4],/^Viu/);
});
test('IP metadata starts while IPv6 is still pending',async()=>{
  let pending, geoStarted=false;
  const r=await ipPanel({argument:'mode=home',intercept:(o,cb)=>{
    if(o.url.includes('2606:4700')){pending=cb;return true;}
    if(o.url.includes('ip-api.com')){geoStarted=true;assert.equal(typeof pending,'function');pending(null,{status:503},'');}
  }});
  assert.ok(geoStarted);assert.match(r.output.content,/198\.51\.100\.10/);
});
test('IP geography cache follows IP and source, expires, and tolerates unavailable storage',async()=>{
  const store=new Map(), now=100000000, argument='tile=local&mode=collapsed';
  const initial=await ipPanel({store,now,argument});assert.equal(initial.requests.length,3);
  assert.equal(initial.requests.find(r=>r.url.includes('ip.sb')).timeout,1);
  assert.equal((await ipPanel({store,now:now+600000,argument})).requests.length,1);
  assert.equal((await ipPanel({store,now:now+600000,argument,localIP:'203.0.113.3'})).requests.length,3);
  assert.equal((await ipPanel({store,now:now+21600001,argument})).requests.length,3);
  const outbound=await ipPanel({store,argument:'mode=collapsed',outIP:'203.0.113.2'});
  assert.ok(outbound.requests.some(r=>r.url.includes('ip-api.com')));
  const noStorage=await ipPanel({argument,storageThrows:true});assert.match(noStorage.output.content,/深圳/);
});

test('Netflix accepts known video markup and prioritizes request country',async()=>{
  for(const marker of ['<meta property="og:video" content="video">','<div data-uia="episodes">','"playableVideo":{}']) {
    const r=await tile('netflix',{body:marker+' "preferredLocale":{"country":"US"},"requestCountry":{"id":"SG"}'});
    assert.equal(r.output.content,'SG');assert.equal(r.requests.length,1);
  }
});
test('Reddit distinguishes rate limiting, explicit blocks and unknown responses',async()=>{
  for(const [status,body,expected] of [[429,'slow down','Rate Limited'],[403,'You have been blocked','NO'],
    [403,'Forbidden','Error'],[200,'<title>Just a moment...</title>','Verify'],[200,'Welcome','OK']]) {
    assert.equal((await tile('reddit',{status,body})).output.content,expected);
  }
});
test('Surge Viu recognizes final region and no-service before body country links',async()=>{
  // Invoke the real optional checker without making unrelated service requests.
  const source=read('media-check.js');
  const declarations=source.slice(0,source.indexOf('/** 主流程：'));
  for(const [url,body,expectedStatus,region] of [
    ['https://www.viu.com/ott/sg/','Welcome',1,'SG'],
    ['https://www.viu.com/ott/no-service','<a href="/ott/hk/">Hong Kong</a>',0,'NO']]) {
    const ctx={$environment:{'surge-version':'5'},console:quiet,
      $httpClient:{get:(o,cb)=>cb(null,{status:200,url,headers:{}},body)}};
    vm.createContext(ctx);
    const result=await vm.runInContext(declarations+'\nServiceChecker.checkViu()',ctx);
    assert.equal(result.status,expectedStatus);assert.equal(result.region,region);
  }
});
