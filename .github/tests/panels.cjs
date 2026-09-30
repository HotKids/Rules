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
  scriptType='tile', intercept, now, storageThrows=false, system, virtualTimers=false}={}) {
  const requests=[], rawRequests=[], notifications=[], apiCalls=[], outputs=[], handles=[], logs=[], requestEvents=[], timerEvents=[];
  const nativeNow=Date.now.bind(Date);
  const clockStart=now===undefined?100000000:now;
  let clockTime=clockStart, nextTimer=0, timerPump=false, finishedAt;
  const activeTimers=new Map();
  const testNow=()=>virtualTimers?clockTime:now===undefined?nativeNow():now;
  const schedule=(fn,ms)=>{
    timerEvents.push({at:testNow(),delay:ms});
    if(!virtualTimers){const handle=setTimeout(fn,ms);handles.push(handle);return handle;}
    const handle=++nextTimer;activeTimers.set(handle,{at:clockTime+ms,fn});
    if(!timerPump){timerPump=true;setImmediate(pumpTimers);}
    return handle;
  };
  const cancel=handle=>{if(virtualTimers)activeTimers.delete(handle);else clearTimeout(handle);};
  const pumpTimers=()=>{
    timerPump=false;
    const next=[...activeTimers.entries()].sort((a,b)=>a[1].at-b[1].at)[0];
    if(!next)return;
    activeTimers.delete(next[0]);clockTime=next[1].at;next[1].fn();
    if(activeTimers.size&&!timerPump){timerPump=true;setImmediate(pumpTimers);}
  };
  let deadline;
  try {
    const output=await Promise.race([
      new Promise((resolve,reject)=>{
        const request=(raw,cb)=>{
          rawRequests.push(raw);
          const options=typeof raw==='string'?{url:raw,headers:{}}:{headers:{},...raw};
          requests.push(options);
          requestEvents.push({url:options.url,at:testNow(),timeout:options.timeout,rawType:typeof raw});
          if(intercept && intercept(options,cb,{schedule,now:testNow})) return;
          const url=options.url;
          let body, status=200;
          if(url.includes('bilibili')) body={data:{addr:localIP,country:'中国',province:'广东',city:'深圳',isp:'电信'}};
          else if(url.includes('2606:4700') || url.includes('api-ipv6') || url.includes('api6.ipify.org')) {
            if(outIPv6) body=url.includes('trace')?`ip=${outIPv6}\nloc=SG`:{ip:outIPv6};
            else status=503;
          }
          else if(url.includes('cdn-cgi/trace') || url.includes('api-ipv4')) {
            if(ipFailure) status=503;
            else body=url.includes('trace')?`ip=${outIP}\nloc=SG`:{ip:outIP,country_code:'SG'};
          }
          else if(url.includes('api.ipify.org')) {
            if(ipFailure) status=503;
            else body={ip:outIP};
          }
          else if(url.includes('proxycheck')) {
            if(riskFailure) status=503;
            else body={[outIP]:{risk:12,type:'Residential'}};
          }
          else if(url.includes('ippure') || url.includes('scamalytics')) {
            if(riskFailure) {status=503;body='<html>service unavailable</html>';}
            else body=ippureData===undefined?{ip:ipFailure?null:outIP,isResidential:true,isBroadcast:false,fraudScore:12}:ippureData;
          }
          else if(url.includes('edns')) {if(dnsFailure)status=503;else body={dns:{ip:'203.0.113.53',geo:'China - Example DNS'}};}
          else if(url.includes('opendata.baidu')) body={status:'0',data:[{location:'广东省深圳市 电信'}]};
          else if(url.includes('ip-api.com')) body={status:'success',country:'台湾',countryCode:'TW',regionName:'台湾',city:'台北市',isp:'Example Telecom',org:'Example'};
          else if(url.includes('ipinfo')) body={country:'SG',city:'Singapore',org:'AS64500 Example'};
          else if(url.includes('ip.sb')) body={country_code:'CN',country:'China',city:'Shenzhen',isp:'Example'};
          else throw Error(`unexpected request: ${url}`);
          cb(null,{status},typeof body==='string'?body:JSON.stringify(body||{}));
        };
        const ctx={$argument:argument,$httpClient:{get:request},console:{log:(...v)=>logs.push(v.join(' ')),error:(...v)=>logs.push(v.join(' '))},
          $persistentStore:{read:k=>{if(storageThrows)throw Error("store unavailable");return store.get(k)||null;},write:(v,k)=>{if(storageThrows)throw Error("store unavailable");store.set(k,v);return true;}},
          $done:o=>{outputs.push(o);finishedAt=testNow();resolve(o);}};
        if(client==='stash') {
          ctx.$environment={'stash-version':'1.1.5',system};ctx.$script={type:scriptType};
          // No $httpAPI; no JS timers unless explicitly requested.
        } else {
          ctx.$input={purpose:'panel'};
          ctx.$httpAPI=(method,path,body,cb)=>{
            apiCalls.push(path);
            cb(path==='/v1/traffic'?{interface:{en0:{in:2048,out:1024}}}:
              {requests:[{URL:'https://ipinfo.io/test/json',policyName:'Test Proxy',remoteAddress:'192.0.2.1:443 (Proxy)'}]});
          };
        }
        if(now!==undefined||virtualTimers)ctx.Date=class extends Date{static now(){return testNow();}};
        if(timers || virtualTimers || client==='surge') {
          ctx.setTimeout=schedule;ctx.clearTimeout=cancel;
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
    return {output,requests,rawRequests,notifications,apiCalls,store,logs,requestEvents,timerEvents,elapsed:finishedAt-clockStart};
  } finally {clearTimeout(deadline);handles.forEach(clearTimeout);activeTimers.clear();}
}

test('Stash home summary keeps full geography and organization in the approved dual-stack layout',async()=>{
  const {output,requests,notifications,apiCalls,store}=await ipPanel({
    argument:'tile=summary&mode=home&notify=true&proxy=HK%20%E8%8A%82%E7%82%B9',
    outIPv6:'2001:db8:85a3::8a2e:370:7334',
    ippureData:{ip:'198.51.100.10',fraudScore:42,isResidential:true,isBroadcast:false},
    intercept(o,cb) {
      if(o.url.includes('ip-api.com')) {
        cb(null,{status:200},JSON.stringify({status:'success',country:'香港',countryCode:'HK',
          regionName:'東區',city:'Kai Tsui Court',isp:'Fallback ISP'}));return true;
      }
      if(o.url.includes('ipinfo')) {
        cb(null,{status:200},JSON.stringify({country:'HK',org:'AS64500 HKT Limited'}));return true;
      }
    }
  });
  assert.equal(output.title,'IP 信息卡');assert.equal(output.backgroundColor,'#D4A017');
  assert.equal(output.content,[
    'IP 风控值：42% 中风险','IP 类型：住宅 · 原生','',
    '本地 IP：203.0.113.2','地区：🇨🇳 广东省深圳市','运营商：中国电信','',
    '出口 IP⁴：198.51.100.10','出口 IP⁶：2001:db8:85a3::8a2e:370:7334',
    '地区：🇭🇰 Kai Tsui Court, 東區, 香港','运营商：HKT Limited'
  ].join('\n'));
  assert.equal(output.url,'https://ippure.com');assert.equal(requests.length,7);
  assert.equal(requests.filter(r=>r.url.includes('ippure')).length,1);
  assert.equal(output.icon,undefined); // Preserve the IPPure icon supplied by the override.
  assert.deepEqual(apiCalls,[]);assert.deepEqual(notifications,[]);
  assert.ok(![...store.keys()].some(key=>/monitor|lastNetworkInfoEvent/.test(key)));
  for(const r of requests) assert.equal(r.headers['X-Stash-Selected-Proxy'],
    /bilibili|opendata|api\.ip\.sb\/geoip\//.test(r.url)?'DIRECT':encodeURIComponent('HK 节点'));
});

test('Stash home summary keeps existing risk thresholds and colors including boundaries',async()=>{
  for(const score of [0,39,40,69,70,100,null,101]) {
    const ippureData={ip:'198.51.100.10',fraudScore:score,isResidential:false,isBroadcast:true};
    const summary=await ipPanel({argument:'tile=summary&mode=home',ippureData});
    const collapsed=await ipPanel({argument:'tile=risk&mode=collapsed',ippureData});
    assert.equal(summary.output.backgroundColor,collapsed.output.backgroundColor);
    assert.equal(summary.output.content.split('\n')[0],
      'IP 风控值：'+collapsed.output.title.split('\n')[1]);
    assert.equal(summary.output.content.split('\n')[1],'IP 类型：'+collapsed.output.content);
    assert.match(summary.output.content,/IP 类型：机房 · 广播/);
  }
});

test('Stash home summary retains independent results, hides absent IPv6 and honors masking',async()=>{
  for(const failure of [{riskFailure:true},{localIP:null},{ipFailure:true},
    {riskFailure:true,localIP:null,ipFailure:true}]) {
    const {output}=await ipPanel({argument:'tile=summary&mode=home',...failure});
    assert.equal(output.title,'IP 信息卡');
    assert.match(output.content,failure.riskFailure?/IP 风控值：暂无有效评分/:/IP 风控值：12% 低风险/);
    assert.match(output.content,failure.localIP===null?/本地 IP：查询失败/:/本地 IP：203\.0\.113\.2/);
    assert.match(output.content,failure.ipFailure?/出口 IP：查询失败/:/出口 IP：198\.51\.100\.10/);
    assert.doesNotMatch(output.content,/出口 IP[⁴⁶]|IPv6/);
    assert.equal(output.backgroundColor,failure.riskFailure?'#9E9E9E':'#88A788');
  }
  const {output}=await ipPanel({argument:'tile=summary&mode=home&mask_ip=2',outIPv6:'2001:db8::10'});
  assert.doesNotMatch(JSON.stringify(output),/203\.0|198\.51|2001:/);
  assert.match(output.content,/出口 IP⁴：\[IP 已隐藏\]\n出口 IP⁶：\[IP 已隐藏\]/);
});

test('Stash home summary starts local and IPPure concurrently and shares the official IPPure response',async()=>{
  const pending=new Map();
  const result=await ipPanel({argument:'tile=summary&mode=home',intercept(o,cb) {
    const kind=o.url.includes('ippure')?'risk':o.url.includes('bilibili')?'local':null;
    if(!kind)return false;
    pending.set(kind,cb);
    if(pending.size===2) {
      pending.get('risk')(null,{status:200},JSON.stringify({ip:'198.51.100.10',fraudScore:12}));
      pending.get('local')(null,{status:200},JSON.stringify({data:{addr:'203.0.113.2'}}));
    }
    return true;
  }});
  assert.equal(pending.size,2);assert.match(result.output.content,/IP 风控值：12% 低风险/);
  assert.match(result.output.content,/出口 IP：198\.51\.100\.10/);
  assert.equal(result.requests.filter(o=>o.url.includes('ippure')).length,1);
  assert.ok(!result.requests.some(o=>/api\.ipify.org|cdn-cgi\/trace|api-ipv4/.test(o.url)));
});

test('Stash prefers current IPPure metadata and each official location fallback without supplemental requests',async()=>{
  for(const [fields,location] of [[{city:'Test City',region:'Test Region',country:'美国'},'Test City, Test Region, 美国'],
    [{region:'Test Region',country:'美国'},'Test Region, 美国'],[{country:'美国'},'美国'],[{},'US']]) {
    const result=await ipPanel({argument:'tile=summary&mode=home',timers:true,
      ippureData:{ip:'198.51.100.10',countryCode:'US',...fields,asOrganization:'Example Network Limited',fraudScore:42,isResidential:true,isBroadcast:false},
      intercept(o,cb) {if(/ip-api.com|ipinfo/.test(o.url)){cb('timeout',null,null);return true;}}
    });
    assert.match(result.output.content,/IP 风控值：42% 中风险/);
    assert.ok(result.output.content.endsWith(`地区：🇺🇸 ${location}\n运营商：Example Network Limited`));
    assert.equal(result.requests.filter(o=>o.url.includes('ippure')).length,1);
    assert.ok(!result.requests.some(o=>/api\.ipify|api-ipv4|cdn-cgi\/trace/.test(o.url)));
    assert.ok(!result.requests.some(o=>/ip-api.com|ipinfo/.test(o.url)));
  }
  const partial=await ipPanel({argument:'mode=collapsed',ippureData:{ip:'198.51.100.10',asOrganization:'IPPure ISP'},
    intercept(o,cb){if(o.url.includes('ipinfo')){cb(null,{status:200},'{"country":"SG"}');return true;}}
  });
  assert.equal(partial.output.content,'🇹🇼 台北 · IPPure ISP');
  assert.equal(partial.requests.filter(o=>o.url.includes('ip-api.com')).length,1);
  assert.ok(!partial.requests.some(o=>o.url.includes('ipinfo')));
  const orgFallback=await ipPanel({argument:'mode=collapsed',ippureData:{ip:'198.51.100.10',asOrganization:'IPPure ISP'},
    intercept(o,cb){
      if(o.url.includes('ip-api.com')){cb('timeout',null,null);return true;}
      if(o.url.includes('ipinfo')){cb(null,{status:200},'{"country":"SG"}');return true;}
    }
  });
  assert.equal(orgFallback.output.content,'地区查询失败 · IPPure ISP');
  assert.ok(!orgFallback.requests.some(o=>o.url.includes('ipinfo')));
});

test('Stash complete official metadata returns immediately even if supplemental services would never call back',async()=>{
  for(const mode of ['home','collapsed']) {
    const r=await ipPanel({virtualTimers:true,argument:`tile=outbound&mode=${mode}`,
      ippureData:{ip:'198.51.100.10',countryCode:'US',country:'美国',region:'Pure Region',city:'Pure City',
        asOrganization:'Pure ISP',fraudScore:12},
      intercept(o,cb){return /ip-api.com|ipinfo/.test(o.url);}
    });
    assert.equal(r.elapsed,0);assert.equal(r.output.backgroundColor,'#1565C0');
    assert.match(r.output.content,/Pure City[\s\S]*Pure ISP/);
    assert.ok(!r.requests.some(o=>/ip-api.com|ipinfo/.test(o.url)));
    assert.equal(r.requests.filter(o=>o.url.includes('ippure')).length,1);
  }
});

test('Stash supplements only missing organization and cannot overwrite the official IPPure location',async()=>{
  const r=await ipPanel({argument:'mode=collapsed',
    ippureData:{ip:'198.51.100.10',countryCode:'US',country:'美国',region:'Pure Region',city:'Pure City'},
    intercept(o,cb){
      if(o.url.includes('ipinfo')){
        cb(null,{status:200},JSON.stringify({country:'SG',city:'Wrong City',org:'AS64500 Supplemental ISP'}));return true;
      }
    }});
  assert.equal(r.output.content,'🇺🇸 Pure City · Supplemental ISP');
  assert.equal(r.requests.filter(o=>o.url.includes('ipinfo')).length,1);
  assert.ok(!r.requests.some(o=>o.url.includes('ip-api.com')));
  assert.doesNotMatch(r.output.content,/🇸🇬|Wrong/);
});

test('Stash fills both missing metadata fields in parallel for a valid official IP or a fallback address',async()=>{
  for(const riskFailure of [false,true]) {
    let pendingGeo, pendingOrg;
    const r=await ipPanel({argument:'mode=collapsed',riskFailure,intercept(o,cb){
      if(o.url.includes('ip-api.com'))pendingGeo=cb;
      else if(o.url.includes('ipinfo'))pendingOrg=cb;
      else return false;
      if(pendingGeo&&pendingOrg){
        pendingGeo(null,{status:200},JSON.stringify({status:'success',countryCode:'TW',country:'台湾',city:'台北市'}));
        pendingOrg(null,{status:200},JSON.stringify({country:'TW',org:'AS64500 Supplemental ISP'}));
      }
      return true;
    }});
    assert.equal(r.output.content,'🇹🇼 台北 · Supplemental ISP');
    assert.equal(r.requests.filter(o=>o.url.includes('ip-api.com')).length,1);
    assert.equal(r.requests.filter(o=>o.url.includes('ipinfo')).length,1);
  }
});

test('Stash invalid IPPure responses do not affect its independently probed exit or supply metadata',async()=>{
  for(const response of [{error:'timeout'}, {status:503,body:'{}'}, {body:'<html>bad JSON</html>'},
    {body:{ip:'999.1.1.1',city:'Wrong City',asOrganization:'Wrong ISP'}},
    {body:{ip:'2001:db8::2',city:'IPv6 City',asOrganization:'IPv6 ISP'}}, {body:null}]) {
    const result=await ipPanel({argument:'mode=collapsed',intercept(o,cb){
      if(o.url.includes('ippure')) {
        cb(response.error||null,{status:response.status||200},typeof response.body==='string'?response.body:JSON.stringify(response.body));return true;
      }
      if(/ip-api.com|ipinfo/.test(o.url)){cb('timeout',null,null);return true;}
    }});
    assert.equal(result.output.title,'出口 IP\n198.51.100.10');
    assert.equal(result.output.content,'地区查询失败 · 运营商未知');
    assert.doesNotMatch(result.output.content,/Wrong|IPv6 City|IPv6 ISP/);
    assert.equal(result.requests.filter(o=>o.url.includes('ippure')).length,1);
    assert.equal(result.requests.filter(o=>o.url==='https://api.ipify.org?format=json').length,1);
    assert.ok(!result.requests.some(o=>/cdn-cgi\/trace|api-ipv4/.test(o.url)));
  }
});

test('Stash rejects invalid or wrong-family fallback addresses without using a previous IP',async()=>{
  for(const ip of ['2001:db8::1','999.1.1.1','bad-ip',null,42]) {
    const store=new Map();await ipPanel({store,argument:'mode=collapsed'});
    const r=await ipPanel({store,argument:'mode=collapsed',ipFailure:true,riskFailure:true,intercept(o,cb){
      if(o.url.includes('api.ipify.org')){cb(null,{status:200},JSON.stringify({ip}));return true;}
    }});
    assert.equal(r.output.content,'无法获取出口 IPv4');assert.equal(r.output.backgroundColor,'#9E9E9E');
  }
  for(const ip of ['198.51.100.10','2001:::1',null]) {
    const r=await ipPanel({argument:'tile=summary&mode=home',intercept(o,cb){
      if(o.url.includes('api6.ipify.org')){cb(null,{status:200},JSON.stringify({ip}));return true;}
    }});
    assert.match(r.output.content,/出口 IP：198\.51\.100\.10/);assert.doesNotMatch(r.output.content,/出口 IP⁶/);
  }
});

test('Stash accepts official IPPure IPv6 risk without using its metadata for the fallback IPv4',async()=>{
  for(const timers of [false,true]) {
    const r=await ipPanel({argument:'tile=summary&mode=home',timers,outIPv6:'2001:db8::99',
      ippureData:{ip:'2001:DB8::2',city:'IPv6 City',asOrganization:'IPv6 ISP',fraudScore:42}});
    assert.match(r.output.content,/出口 IP⁴：198\.51\.100\.10\n出口 IP⁶：2001:db8::2/);
    assert.match(r.output.content,/IP 风控值：42% 中风险/);
    assert.doesNotMatch(r.output.content,/IPv6 City|IPv6 ISP/);
    assert.equal(r.requests.filter(o=>o.url.includes('ippure')).length,1);
    assert.equal(r.requests.filter(o=>o.url==='https://api.ipify.org?format=json').length,1);
    assert.equal(r.requests.filter(o=>o.url==='https://api6.ipify.org?format=json').length,0);
    assert.ok(!r.requests.some(o=>/cdn-cgi\/trace|api-ipv/.test(o.url)));
  }
});

test('Stash uses one IPv4 ipify fallback after official IPPure fails and never requests Cloudflare or ip.sb probes',async()=>{
  for(const timers of [false,true]) {
    const r=await ipPanel({argument:'tile=summary&mode=home&proxy=HK%20%E8%8A%82%E7%82%B9',
      timers,outIPv6:'2001:db8::10',riskFailure:true});
    assert.match(r.output.content,/出口 IP⁴：198\.51\.100\.10\n出口 IP⁶：2001:db8::10/);
    for(const url of ['https://api.ipify.org?format=json','https://api6.ipify.org?format=json'])
      assert.equal(r.requests.filter(o=>o.url===url).length,1);
    assert.ok(!r.requests.some(o=>/cdn-cgi\/trace|api-ipv[46]/.test(o.url)));
    const probes=r.requests.filter(o=>/ipify/.test(o.url));
    assert.ok(probes.every(o=>o.headers['X-Stash-Selected-Proxy']===encodeURIComponent('HK 节点')));
    assert.ok(probes.every(o=>o.timeout>0 && o.timeout<=5));
    assert.equal(probes.find(o=>o.url.includes('api6.ipify.org')).timeout,3);
    assert.match(r.output.content,/IP 风控值：暂无有效评分/);
  }
});

test('Stash ipify fallback success avoids Cloudflare, ip.sb and IPv6 probes in a collapsed tile',async()=>{
  for(const timers of [false,true]) {
    const r=await ipPanel({timers,riskFailure:true,argument:'mode=collapsed'});
    assert.equal(r.output.title,'出口 IP\n198.51.100.10');
    assert.equal(r.requests.filter(o=>o.url==='https://api.ipify.org?format=json').length,1);
    assert.ok(!r.requests.some(o=>/cdn-cgi\/trace|api-ipv|api6\.ipify/.test(o.url)));
    assert.equal(r.requests.find(o=>o.url.includes('api.ipify.org')).timeout,5);
  }
});

test('Stash native IPPure with no callback reaches the script deadline without starting a fallback',async()=>{
  const r=await ipPanel({virtualTimers:true,argument:'mode=collapsed',intercept(o,cb){
    return o.url.includes('ippure');
  }});
  const probes=r.requestEvents.filter(o=>/ippure|api\.ipify\.org/.test(o.url));
  assert.deepEqual(probes.map(o=>o.url),[
    'https://my.ippure.com/v1/info'
  ]);
  assert.equal(probes[0].timeout,undefined);
  assert.equal(probes[0].rawType,'string');
  assert.equal(r.elapsed,19750);
  assert.equal(r.output.content,'无法获取出口 IPv4');assert.equal(r.output.backgroundColor,'#9E9E9E');
  assert.ok(!r.requests.some(o=>/cdn-cgi\/trace|api-ipv[46]/.test(o.url)));
  assert.match(r.logs.join('\n'),/脚本等待期限已到/);
  assert.doesNotMatch(r.logs.join('\n'),/请求超时/);
});

test('Stash uses native URL-string IPPure requests for collapsed tiles and adds only explicit manual proxy headers',async()=>{
  for(const timers of [false,true]) {
    const collapsed=await ipPanel({timers,argument:'tile=risk&mode=collapsed&proxy=ignored'});
    assert.deepEqual(collapsed.rawRequests,['https://my.ippure.com/v1/info']);
    assert.equal(collapsed.requests[0].timeout,undefined);
    assert.equal(collapsed.requests[0].headers['X-Stash-Selected-Proxy'],undefined);
    const manual=await ipPanel({timers,argument:'tile=risk&mode=home&proxy=HK%20%E8%8A%82%E7%82%B9'});
    assert.equal(typeof manual.rawRequests[0],'object');
    assert.equal(manual.rawRequests[0].url,'https://my.ippure.com/v1/info');
    assert.equal(manual.rawRequests[0].headers['X-Stash-Selected-Proxy'],encodeURIComponent('HK 节点'));
    assert.equal(manual.rawRequests[0].timeout,undefined);
    assert.equal(manual.requests.length,1);
  }
});

test('Stash starts the five-second IPv4 fallback only after a native IPPure HTTP timeout',async()=>{
  for(const stalledFallback of [false,true]) {
    const r=await ipPanel({virtualTimers:true,argument:'mode=collapsed',intercept(o,cb,{schedule}){
      if(o.url.includes('ippure')){schedule(()=>cb('request timed out',null,null),5000);return true;}
      return stalledFallback&&o.url.includes('api.ipify.org');
    }});
    const fallback=r.requestEvents.find(o=>o.url.includes('api.ipify.org'));
    assert.equal(fallback.at-r.requestEvents[0].at,5000);assert.equal(fallback.timeout,5);
    assert.equal(r.elapsed,stalledFallback?10000:5000);
    assert.equal(r.requests[0].timeout,undefined);
    assert.match(r.logs.join('\n'),/my\.ippure\.com：请求超时/);
    if(stalledFallback){
      assert.equal(r.output.content,'无法获取出口 IPv4');
      assert.match(r.logs.join('\n'),/api\.ipify\.org：脚本等待期限已到/);
    }else assert.equal(r.output.title,'出口 IP\n198.51.100.10');
    assert.ok(!r.requests.some(o=>/cdn-cgi\/trace|api-ipv[46]/.test(o.url)));
  }
});

test('Stash limits a fallback started near the script deadline to the remaining time',async()=>{
  const r=await ipPanel({virtualTimers:true,argument:'mode=collapsed',intercept(o,cb,{schedule}){
    if(o.url.includes('ippure')){schedule(()=>cb('request timed out',null,null),19000);return true;}
    return o.url.includes('api.ipify.org');
  }});
  const fallback=r.requestEvents.find(o=>o.url.includes('api.ipify.org'));
  assert.equal(fallback.at-r.requestEvents[0].at,19000);assert.equal(fallback.timeout,0.75);
  assert.equal(r.elapsed,19750);assert.equal(r.output.content,'无法获取出口 IPv4');
});

test('Stash optional IPv6 has one three-second attempt and cannot hold back an otherwise complete summary',async()=>{
  const r=await ipPanel({virtualTimers:true,argument:'tile=summary&mode=home',intercept(o,cb){
    return o.url.includes('api6.ipify.org');
  }});
  assert.equal(r.elapsed,3000);
  assert.match(r.output.content,/出口 IP：198\.51\.100\.10/);
  assert.doesNotMatch(r.output.content,/出口 IP[⁴⁶]/);
  const ipv6=r.requests.filter(o=>/2606:4700|api-ipv6|api6\.ipify/.test(o.url));
  assert.equal(ipv6.length,1);assert.equal(ipv6[0].timeout,3);
  assert.match(r.output.content,/IP 风控值：12% 低风险/);
  const stalledPure=await ipPanel({virtualTimers:true,argument:'tile=summary&mode=home',intercept(o,cb,{schedule}){
    if(o.url.includes('ippure')){schedule(()=>cb('request timed out',null,null),5000);return true;}
    return o.url.includes('api6.ipify');
  }});
  assert.equal(stalledPure.elapsed,8000);
  assert.match(stalledPure.output.content,/出口 IP：198\.51\.100\.10/);
  assert.doesNotMatch(stalledPure.output.content,/出口 IP[⁴⁶]/);
  const fallback6=stalledPure.requestEvents.find(o=>o.url.includes('api6.ipify.org'));
  assert.equal(fallback6.at-stalledPure.requestEvents[0].at,5000);assert.equal(fallback6.timeout,3);
  assert.equal(stalledPure.requests.filter(o=>o.url.includes('ippure')).length,1);
});

test('Stash native IPPure can succeed after six seconds and ignores duplicate callbacks',async()=>{
  let delayedCalls=0;
  const r=await ipPanel({virtualTimers:true,argument:'tile=summary&mode=home',intercept(o,cb,{schedule}){
    if(o.url.includes('ippure')) {
      schedule(()=>{
        delayedCalls++;cb(null,{status:200},JSON.stringify({ip:'198.51.100.99',fraudScore:42,
          isResidential:false,isBroadcast:true,countryCode:'HK',country:'香港',asOrganization:'Pure ISP'}));
        cb(null,{status:200},'{"ip":"198.51.100.88","fraudScore":1}');
      },6000);return true;
    }
  }});
  assert.equal(delayedCalls,1);assert.equal(r.elapsed,6000);
  assert.match(r.output.content,/出口 IP：198\.51\.100\.99/);
  assert.match(r.output.content,/IP 风控值：42% 中风险\nIP 类型：机房 · 广播/);
  assert.doesNotMatch(JSON.stringify(r.output),/198\.51\.100\.88/);
  assert.equal(r.requests.filter(o=>o.url.includes('ippure')).length,1);
  assert.ok(!r.requests.some(o=>o.url.includes('api.ipify.org')));
  assert.ok(!r.requests.some(o=>/cdn-cgi\/trace|api-ipv[46]/.test(o.url)));
});

test('Stash unavailable or malformed official risk never starts auxiliary probes',async()=>{
  for(const ippureData of [null,{ip:'999.1.1.1',fraudScore:null}]) {
    const r=await ipPanel({virtualTimers:true,argument:'tile=risk&mode=collapsed',
      riskFailure:ippureData===null,ippureData,intercept(o,cb){return o.url.includes('api.ipify.org');}});
    assert.equal(r.elapsed,0);assert.equal(r.output.backgroundColor,'#9E9E9E');
    assert.doesNotMatch(JSON.stringify(r.output),/12%|999\.1\.1\.1/);
    assert.equal(r.requests.length,1);
    assert.ok(!r.requests.some(o=>/ipify|cdn-cgi\/trace|proxycheck/.test(o.url)));
  }
});

test('Stash official risk does not require cross-endpoint IP equality or an independent exit probe',async()=>{
  for(const ip of ['203.0.113.2','2001:db8::10']) {
    const r=await ipPanel({argument:'tile=risk&mode=collapsed',ipFailure:true,
      ippureData:{ip,fraudScore:6,isResidential:true,isBroadcast:false}});
    assert.equal(r.output.title,'IP 纯净度\n6% 低风险');assert.equal(r.output.content,'住宅 · 原生');
    assert.equal(r.requests.length,1);assert.equal(r.requests[0].url,'https://my.ippure.com/v1/info');
    assert.doesNotMatch(r.logs.join('\n'),/未对应|203\.0\.113\.2|2001:db8/);
  }
});

test('Stash official fresh risk remains usable without a valid IP but cannot borrow or save an IP cache',async()=>{
  const store=new Map();await ipPanel({store,argument:'tile=risk&mode=collapsed'});
  const before=JSON.stringify([...store]);
  for(const ip of [undefined,null,'','999.1.1.1']) {
    const r=await ipPanel({store,argument:'tile=risk&mode=collapsed',
      ippureData:{ip,fraudScore:'0',isResidential:false,isBroadcast:false}});
    assert.equal(r.output.title,'IP 纯净度\n0% 低风险');assert.equal(r.output.content,'机房 · 原生');
    assert.equal(r.output.backgroundColor,'#88A788');assert.equal(r.output.url,'https://ippure.com');
    assert.equal(r.requests.length,1);assert.equal(JSON.stringify([...store]),before);
  }
});

test('Stash native risk missing HTTP callback finishes at the script deadline without auxiliary requests',async()=>{
  const r=await ipPanel({virtualTimers:true,argument:'tile=risk&mode=collapsed',intercept(o,cb){
    return o.url.includes('ippure');
  }});
  assert.equal(r.elapsed,19750);assert.equal(r.requests.length,1);
  assert.equal(r.output.backgroundColor,'#9E9E9E');assert.match(r.output.content,/IPPure 检测失败/);
  assert.match(r.logs.join('\n'),/脚本等待期限已到/);
});

test('Stash risk opens the current official IPPure address only when IP masking is disabled',async()=>{
  for(const ip of ['198.51.100.10','2001:db8::10'])for(const mask of [0,1,2])for(const mode of ['home','collapsed']) {
    const r=await ipPanel({system:'iOS',argument:`tile=risk&mode=${mode}&mask_ip=${mask}`,
      ippureData:{ip,fraudScore:12,isResidential:true,isBroadcast:false}});
    assert.equal(r.output.url,mask===0?'https://ippure.com/?ip='+encodeURIComponent(ip):'https://ippure.com');
    if(mask!==0)assert.doesNotMatch(JSON.stringify(r.output),/198\.51\.100\.10|2001:db8/);
    assert.equal(r.requests.length,1);
  }
});

test('Stash official IPPure response supplies the same exit, score, types and metadata without auxiliary queries',async()=>{
  const store=new Map(),now=100000000;
  // A fresh response for this same address must replace its older score.
  await ipPanel({store,now,argument:'tile=risk&mode=collapsed',outIP:'203.0.113.2'});
  const options={store,now:now+600000,system:'iOS',
    ippureData:{ip:'203.0.113.2',fraudScore:6,isResidential:true,isBroadcast:false,
      countryCode:'HK',country:'香港',city:'Hong Kong',asOrganization:'China Mobile'},
    intercept(o,cb){if(/ip-api.com|ipinfo/.test(o.url)){cb('timeout',null,null);return true;}}
  };
  const summary=await ipPanel({...options,argument:'tile=summary&mode=home&proxy=HK%20%E8%8A%82%E7%82%B9'});
  assert.match(summary.output.content,/本地 IP：203\.0\.113\.2/);
  assert.match(summary.output.content,/出口 IP：203\.0\.113\.2/);
  assert.match(summary.output.content,/IP 风控值：6% 低风险\nIP 类型：住宅 · 原生/);
  assert.match(summary.output.content,/香港[\s\S]*China Mobile/);
  assert.doesNotMatch(summary.output.content,/198\.51\.100\.10|暂无有效评分/);
  const direct=summary.requests.filter(o=>/bilibili|opendata|api\.ip\.sb\/geoip\//.test(o.url));
  assert.ok(direct.length>0 && direct.every(o=>o.headers['X-Stash-Selected-Proxy']==='DIRECT'));
  assert.equal(summary.requests.find(o=>o.url==='https://my.ippure.com/v1/info').headers['X-Stash-Selected-Proxy'],encodeURIComponent('HK 节点'));
  assert.equal(summary.requests.filter(o=>o.url.includes('ippure')).length,1);
  assert.ok(!summary.requests.some(o=>/api\.ipify|cdn-cgi\/trace|api-ipv|proxycheck/.test(o.url)));
  const outbound=await ipPanel({...options,argument:'mode=collapsed&proxy=ignored'});
  assert.equal(outbound.output.title,'🅟 203.0.113.2');
  assert.match(outbound.output.content,/🇭🇰.*中国移动/);
  assert.ok(outbound.requests.every(o=>!o.headers?.['X-Stash-Selected-Proxy']));
  const risk=await ipPanel({...options,argument:'tile=risk&mode=collapsed'});
  assert.equal(risk.output.title,'6% 低风险');assert.equal(risk.output.content,'住宅 · 原生');
  assert.equal(risk.output.backgroundColor,'#88A788');assert.equal(risk.requests.length,1);
  const records=JSON.parse(store.get('stash.ip-security.last-good.v1'));
  assert.equal(records['risk:203.0.113.2'].fields.score.value,6);
  assert.equal(records['risk:198.51.100.10'],undefined);
});

test('Stash permits equal direct and outbound addresses when the selected route really is direct',async()=>{
  const r=await ipPanel({argument:'tile=summary&mode=home&proxy=DIRECT',outIP:'203.0.113.2'});
  assert.match(r.output.content,/本地 IP：203\.0\.113\.2/);
  assert.match(r.output.content,/出口 IP：203\.0\.113\.2/);
  assert.match(r.output.content,/IP 风控值：12% 低风险/);
  assert.ok(r.requests.every(o=>o.headers['X-Stash-Selected-Proxy']==='DIRECT'));
});

test('Stash rejects wrong-family and malformed primary probes before using a valid fallback',async()=>{
  for(const badIPv4 of ['999.1.1.1','2001:db8::1','bad-ip']) {
    const r=await ipPanel({argument:'mode=collapsed',ippureData:{ip:badIPv4}});
    assert.equal(r.output.title,'出口 IP\n198.51.100.10');
    assert.equal(r.requests.filter(o=>o.url.includes('api.ipify.org')).length,1);
    assert.ok(!r.requests.some(o=>/cdn-cgi\/trace|api-ipv[46]/.test(o.url)));
  }
  const ipv6=await ipPanel({argument:'tile=summary&mode=home',intercept(o,cb){
    if(o.url.includes('api6.ipify.org')){cb(null,{status:200},'{"ip":"2001:::1"}');return true;}
  }});
  assert.doesNotMatch(ipv6.output.content,/出口 IP⁶/);
  assert.equal(ipv6.requests.filter(o=>o.url.includes('api6.ipify.org')).length,1);
  assert.ok(!ipv6.requests.some(o=>/2606:4700|api-ipv6/.test(o.url)));
});

test('Surge keeps Cloudflare IPv4 and IPv6 probes plus the ip.sb fallback',async()=>{
  for(const failedPrimary of [false,true]) {
    const r=await ipPanel({client:'surge',outIPv6:'2001:db8::1',intercept(o,cb){
      if(failedPrimary && o.url.includes('cdn-cgi/trace')){cb('timeout',null,null);return true;}
    }});
    assert.match(r.output.content,/出口 IP⁴：198\.51\.100\.10\n出口 IP⁶：2001:db8::1/);
    assert.ok(r.requests.some(o=>o.url==='https://1.1.1.1/cdn-cgi/trace'));
    assert.ok(r.requests.some(o=>o.url.includes('2606:4700')));
    assert.equal(r.requests.some(o=>o.url.includes('api-ipv4.ip.sb')),failedPrimary);
    assert.equal(r.requests.some(o=>o.url.includes('api-ipv6.ip.sb')),failedPrimary);
    assert.ok(!r.requests.some(o=>o.url.includes('ipify')));
  }
});

test('Stash outbound tile uses Chinese geography without timers or Surge API',async()=>{
  const {output,requests,apiCalls}=await ipPanel({argument:'tile=outbound&proxy=SG%20%E8%8A%82%E7%82%B9&mask_ip=2',outIPv6:'2001:db8::10'});
  assert.equal(output.title,'出口 IP');assert.equal(output.backgroundColor,'#1565C0');
  assert.match(output.content,/🇹🇼/);assert.match(output.content,/台北市/);
  assert.match(output.content,/IPv6：\[IP 已隐藏\]/);assert.doesNotMatch(output.content,/198\.51|203\.0|2001:|流量统计|入口 IP/);
  assert.equal(output['icon-color'],undefined);assert.deepEqual(apiCalls,[]);
  assert.ok(requests.some(r=>r.url.includes('lang=zh-CN')));
  assert.ok(!requests.some(r=>/proxycheck|scamalytics|edns|opendata/.test(r.url)));
  for(const req of requests){
    if(req.url.includes('ippure'))assert.equal(req.timeout,undefined);
    else assert.ok(req.timeout>0 && req.timeout<=5);
    assert.equal(req.policy,undefined);
    assert.equal(req.headers['X-Stash-Selected-Proxy'],req.url.includes('bilibili')?'DIRECT':encodeURIComponent('SG 节点'));
  }
});
test('Stash risk uses one IPPure request and ignores other configured risk sources',async()=>{
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
        outIP:'192.0.2.22',ippureData:{ip:'192.0.2.22',isResidential,isBroadcast,fraudScore}});
      assert.equal(output.title,'IP 纯净度\n'+(fraudScore===null?'暂无有效评分':'12% 低风险'));
      assert.doesNotMatch(output.title+'\n'+output.content,/192\.0\.2\.22/);
      assert.equal(output.content,label);assert.equal(output.backgroundColor,fraudScore===null?'#9E9E9E':'#88A788');
      assert.equal(output.url,'https://ippure.com/?ip=192.0.2.22');
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
  assert.ok(changed.requests.every(r=>/bilibili|ippure|cdn-cgi\/trace|ip\.sb|ipify/.test(r.url)));
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
      assert.ok(!result.requests.some(r=>/bilibili|ipv6|2606:4700|api6\.ipify/.test(r.url)));
    }
    for(const req of result.requests)assert.equal(req.headers?.['X-Stash-Selected-Proxy'],undefined);
  }
  const wrongContext=await ipPanel({store,argument:'task=monitor&notify=true',outIP:'198.51.100.99'});
  assert.equal(wrongContext.notifications.length,0);assert.equal(wrongContext.requests.length,0);
  assert.equal(store.get(key),baseline);
  assert.equal((await monitor({store,outIP:'198.51.100.11'})).notifications.length,1);
});
test('Stash collapsed IP summaries keep essential information visible and respect masking',async()=>{
  const outbound=await ipPanel({system:'Android',argument:'tile=outbound&mode=collapsed'});
  assert.equal(outbound.output.title,'出口 IP\n198.51.100.10');
  assert.equal(outbound.output.content,'🇹🇼 台北 · Example');
  assert.equal(outbound.output.url,'https://ippure.com');
  const local=await ipPanel({system:'Android',argument:'tile=local&mode=collapsed'});
  assert.equal(local.output.title,'本地 IP\n203.0.113.2');
  assert.equal(local.output.content,'🇨🇳 深圳 · 中国电信');
  assert.equal(local.output.url,'https://ippure.com/?ip=203.0.113.2');
  const risk=await ipPanel({system:'Android',argument:'tile=risk&mode=collapsed'});
  assert.equal(risk.output.title,'IP 纯净度\n12% 低风险');
  assert.doesNotMatch(risk.output.title+'\n'+risk.output.content,/198\.51\.100\.10/);
  assert.equal(risk.output.content,'住宅 · 原生');
  assert.equal(risk.output.url,'https://ippure.com/?ip=198.51.100.10');
  for(const service of ['outbound','local','risk']) {
    const {output}=await ipPanel({system:'Android',argument:`tile=${service}&mode=collapsed&mask_ip=2`});
    if(['outbound','local'].includes(service)) assert.match(output.title,/\[IP 已隐藏\]/);
    assert.doesNotMatch(JSON.stringify(output),/198\.51\.100\.10|203\.0\.113\.2/);
    assert.doesNotMatch(output.content,/\n/);
    assert.equal(output.url,'https://ippure.com');
  }
});

test('Stash iOS uses single-line marker titles, short carrier names and the existing masking',async()=>{
  for(const system of ['iOS','iPadOS',' ios ']) {
    const outbound=await ipPanel({system,argument:'tile=outbound&mode=collapsed',outIP:'255.255.255.255'});
    assert.equal(outbound.output.title,'🅟 255.255.255.255');
    assert.equal(outbound.output.content,'🇹🇼 台北 · Example');
    const local=await ipPanel({system,argument:'tile=local&mode=collapsed'});
    assert.equal(local.output.title,'Ⓓ 203.0.113.2');
    assert.equal(local.output.content,'🇨🇳 深圳 · 中国电信');
    const risk=await ipPanel({system,argument:'tile=risk&mode=collapsed'});
    assert.equal(risk.output.title,'12% 低风险');
    assert.equal(risk.output.content,'住宅 · 原生');
    for(const tile of ['local','outbound','risk']) {
      const {output}=await ipPanel({system,argument:`tile=${tile}&mode=collapsed&mask_ip=2`});
      assert.doesNotMatch(output.title,/\n/);assert.doesNotMatch(output.content,/\n/);
      assert.doesNotMatch(JSON.stringify(output),/203\.0\.113\.2|198\.51\.100\.10/);
      assert.equal(output.url,'https://ippure.com');
    }
  }
  for(const [organization,expected] of [
    ['AS64500 China Mobile International Limited','中国移动'],
    ['AS64500 China Unicom Global Limited','中国联通'],
    ['AS64500 China Telecom Corporation','中国电信'],
    ['AS64500 China Broadnet Network Co., Ltd.','中国广电']
  ]) {
    const {output}=await ipPanel({system:'iOS',argument:'mode=collapsed',intercept(o,cb){
      if(o.url.includes('ip-api.com')) {
        cb(null,{status:200},JSON.stringify({status:'success',country:'香港',countryCode:'HK',city:'香港'}));return true;
      }
      if(o.url.includes('ipinfo')) {
        cb(null,{status:200},JSON.stringify({country:'HK',org:organization}));return true;
      }
    }});
    assert.equal(output.content,'🇭🇰 香港 · '+expected);
  }
  for(const tile of ['summary','local','outbound','risk']) {
    const ios=await ipPanel({system:'iOS',argument:`tile=${tile}&mode=home`});
    const android=await ipPanel({system:'Android',argument:`tile=${tile}&mode=home`});
    assert.equal(JSON.stringify(ios.output),JSON.stringify(android.output));
  }
});
test('Stash IPPure failures stay unknown without switching risk services',async()=>{
  const failedRisk=await ipPanel({argument:'tile=risk',riskFailure:true});
  assert.equal(failedRisk.output.backgroundColor,'#9E9E9E');assert.match(failedRisk.output.content,/IPPure 检测失败/);
  assert.equal(failedRisk.requests.length,1);assert.equal(failedRisk.store.size,0);
  for(const data of [{},{fraudScore:null},{fraudScore:''},{fraudScore:false},{fraudScore:101},{fraudScore:-1}]) {
    const bad=await ipPanel({argument:'tile=risk',ippureData:data});
    assert.equal(bad.output.backgroundColor,'#9E9E9E');assert.match(bad.output.content,/暂无有效评分/);
  }
  for(const [score,color] of [[0,'#88A788'],[40,'#D4A017'],[70,'#C44444']]) {
    const valid=await ipPanel({argument:'tile=risk',ippureData:{ip:'198.51.100.10',fraudScore:score}});
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
  for(const [response,expected] of [[{body:{models:[]}},'OK'],[{status:429,body:'rate limited'},'Error'],
    [{status:400,body:'API_KEY_INVALID'},'Invalid Key'],[{status:400,body:'User location is not supported'},'NO']]) {
    const result=await tile('gemini',o=>o.url.includes('generativelanguage')?response:{body:'unknown page'},
      {argument:'geminiapikey=example'});
    assert.equal(result.output.content,expected);
  }
});
test('AI services keep unknown HTTP failures and missing regional evidence as Error',async()=>{
  for(const service of ['chatgpt','claude','gemini'])for(const [status,body,expected] of [
    [403,'<title>Just a moment...</title>','Error'],[429,'too many requests','Error'],
    [403,'Forbidden','Error']]) {
    const result=await tile(service,o=>o.url.includes('trace')?{error:'Timeout'}:{status,body});
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
    [{body:'GeoBlockedErrorRoot'},'NO'],[{body:'AbraRateLimitedErrorRoot'},'Error'],
    [{status:403,body:'Forbidden'},'Error'],[{body:'<title>Just a moment...</title>'},'Error'],[{body:'generic home'},'Error']]) {
    const r=await tile('metaai',o=>o.url.endsWith('/ajax')?{status:403,body:'Forbidden'}:home);
    assert.equal(r.output.content,expected);
  }
  assert.equal((await tile('metaai',{status:429,body:'slow down'})).output.content,'Error');
});
test('TikTok checks fallback status, regions and explicit Hong Kong restriction',async()=>{
  const first=await tile('tiktok',{body:'"region":"SG"'});assert.equal(first.output.content,'SG');assert.equal(first.requests.length,1);
  const fallback=await tile('tiktok',o=>o.url.endsWith('/explore')?{body:'unknown'}:{body:'"region": "US"'});
  assert.equal(fallback.output.content,'US');assert.equal(fallback.requests.length,2);
  for(const response of [{status:200,body:'https://www.tiktok.com/hk/notfound'},
    {status:404,url:'https://www.tiktok.com/hk/notfound',body:'Not found'}])assert.equal((await tile('tiktok',response)).output.content,'NO');
  const rejected=await tile('tiktok',o=>o.url.endsWith('/explore')?{body:'unknown'}:{status:403,body:'"region":"US"'});
  assert.equal(rejected.output.content,'Error');
  assert.equal((await tile('tiktok',{body:'<title>Just a moment...</title>'})).output.content,'Error');
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
    assert.deepEqual(names,['Netflix','Disney+','HBO Max','YouTube','Spotify','TikTok','ChatGPT','Claude','Gemini','Meta AI','Reddit']);
    assert.match(r.output.title,/11\/11/);
    assert.ok(r.output[client==='stash'?'backgroundColor':'icon-color']);
  }
  const viu=await tile('all',response,{client:'surge',argument:'viu=true'});
  assert.match(viu.output.title,/12\/12/);assert.match(viu.output.content.split('\n')[4],/^Viu/);
});
test('IP metadata starts while IPv6 is still pending',async()=>{
  let pending, geoStarted=false;
  const r=await ipPanel({argument:'mode=home',intercept:(o,cb)=>{
    if(o.url.includes('api6.ipify.org')){pending=cb;return true;}
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

test('Stash local geography survives Baidu timeout using the current DIRECT response',async()=>{
  for(const mode of ['home','collapsed']) {
    const r=await ipPanel({argument:`tile=local&mode=${mode}`,now:100000000,intercept:(o,cb)=>{
      if(o.url.includes('opendata.baidu')) {
        assert.equal(o.timeout,5);cb('request timed out',null,null);return true;
      }
    }});
    assert.equal(r.output.backgroundColor,'#00796B');assert.match(r.output.content,/深圳[\s\S]*中国电信/);
    assert.match(JSON.stringify(r.output),/203\.0\.113\.2/);assert.doesNotMatch(r.output.content,/失败/);
    assert.equal(r.requests.length,3);assert.ok(r.requests.every(o=>o.headers['X-Stash-Selected-Proxy']==='DIRECT'));
  }
});
test('Stash local fallback preserves roaming country and can use the same-IP geo lookup',async()=>{
  for(const country of ['新加坡',null]) {
    const r=await ipPanel({argument:'tile=local&mode=collapsed',intercept:(o,cb)=>{
      if(o.url.includes('bilibili')) {cb(null,{status:200},JSON.stringify({data:{addr:'203.0.113.2',country,isp:'Singtel'}}));return true;}
      if(o.url.includes('opendata.baidu')) {cb(null,{status:200},'<html>unavailable</html>');return true;}
      if(o.url.includes('ip.sb')) {
        cb(null,{status:200},JSON.stringify({ip:'203.0.113.2',country_code:'SG',country:'Singapore',city:'Singapore',organization:'Singtel'}));return true;
      }
    }});
    assert.equal(r.output.backgroundColor,'#00796B');assert.match(r.output.content,/🇸🇬.*Singtel/);
    assert.doesNotMatch(r.output.content,/🇨🇳|中国/);assert.equal(r.requests.length,3);
  }
});
test('Stash outbound geography uses existing HTTPS ipinfo data after ip-api failure',async()=>{
  for(const mode of ['home','collapsed']) {
    const r=await ipPanel({argument:`tile=outbound&mode=${mode}&mask_ip=2`,now:100000000,intercept:(o,cb)=>{
      if(o.url.includes('ip-api.com')) {assert.equal(o.timeout,5);cb(null,{status:403},'denied');return true;}
    }});
    assert.equal(r.output.backgroundColor,'#1565C0');assert.match(r.output.content,/🇸🇬[\s\S]*SG[\s\S]*Example/);
    assert.doesNotMatch(JSON.stringify(r.output),/198\.51\.100\.10|失败/);
    assert.ok(r.requests.every(o=>!o.headers?.['X-Stash-Selected-Proxy']));
  }
});
test('Stash outbound retains only known country when both detailed geo sources fail',async()=>{
  const r=await ipPanel({argument:'mode=collapsed',ippureData:{ip:'198.51.100.10',countryCode:'SG',country:'SG'},intercept:(o,cb)=>{
    if(/ip-api.com|ipinfo/.test(o.url)){cb('timeout',null,null);return true;}
  }});
  assert.equal(r.output.title,'出口 IP\n198.51.100.10');assert.equal(r.output.backgroundColor,'#1565C0');
  assert.equal(r.output.content,'🇸🇬 SG · 运营商未知');assert.equal(r.requests.length,2);
});
test('Stash keeps current IP and unknown geography when every metadata source is empty',async()=>{
  for(const service of ['local','outbound']) {
    const r=await ipPanel({argument:`tile=${service}&mode=collapsed`,intercept:(o,cb)=>{
      if(o.url.includes('bilibili')) {cb(null,{status:200},JSON.stringify({data:{addr:'203.0.113.2'}}));return true;}
      if(o.url==='https://1.1.1.1/cdn-cgi/trace') {cb(null,{status:200},'ip=198.51.100.10\n');return true;}
      if(/ip-api.com|ipinfo|opendata|ip.sb/.test(o.url)){cb('timeout',null,null);return true;}
    }});
    assert.equal(r.output.backgroundColor,'#9E9E9E');assert.match(r.output.content,/地区查询失败/);
    assert.match(r.output.title,/203\.0\.113\.2|198\.51\.100\.10/);
    assert.doesNotMatch(r.output.content,/🇨🇳|🇸🇬|台北|深圳/);
  }
});

const failedGeography = (localIP='203.0.113.2') => (o,cb) => {
  if(o.url.includes('bilibili')) {cb(null,{status:200},JSON.stringify({data:{addr:localIP}}));return true;}
  if(/ip-api.com|ipinfo|opendata|ip.sb\/geoip\//.test(o.url)){cb('timeout',null,null);return true;}
};
test('Stash summary reuses collapsed same-IP cache without borrowing results after an IP change',async()=>{
  const store=new Map(), now=100000000;
  for(const service of ['local','outbound','risk'])
    await ipPanel({store,now,argument:`tile=${service}&mode=collapsed`});
  const argument='tile=summary&mode=home';
  const same=await ipPanel({store,now:now+7*3600000,argument,intercept:failedGeography(),
    ippureData:{ip:'198.51.100.10'}});
  assert.match(same.output.content,/IP 风控值：12% 低风险\nIP 类型：住宅 · 原生/);
  assert.match(same.output.content,/地区：🇨🇳 广东省深圳市\n运营商：中国电信/);
  assert.match(same.output.content,/地区：🇹🇼 台北市, 台湾\n运营商：Example/);
  assert.doesNotMatch(same.output.content,/缓存|cache|失败|IP⁶/);
  const changed=await ipPanel({store,now:now+7*3600000,argument,intercept:failedGeography('203.0.113.3'),
    outIP:'198.51.100.11',ippureData:{ip:'198.51.100.11'}});
  assert.match(changed.output.content,/IP 风控值：暂无有效评分/);
  assert.doesNotMatch(changed.output.content,/台北|深圳|Example|中国电信|住宅|原生/);
  assert.match(changed.output.content,/本地 IP：203\.0\.113\.3/);
  assert.match(changed.output.content,/出口 IP：198\.51\.100\.11/);
});
test('Stash IP tiles reuse successful same-IP fields after fresh geography expires without a label',async()=>{
  for(const service of ['local','outbound']) {
    const store=new Map(), now=100000000, argument=`tile=${service}&mode=collapsed`;
    const initial=await ipPanel({store,now,argument});
    const again=await ipPanel({store,now:now+7*3600000,argument,intercept:failedGeography()});
    assert.deepEqual(JSON.parse(JSON.stringify(again.output)),JSON.parse(JSON.stringify(initial.output)));
    assert.doesNotMatch(again.output.content,/缓存|cache|失败/i);
    assert.equal(again.notifications.length,0);
    assert.ok(again.requests.some(o=>/ip-api.com|opendata/.test(o.url)));
  }
});
test('Stash failed node changes do not borrow or overwrite another IP result',async()=>{
  for(const service of ['local','outbound']) {
    const store=new Map(), now=100000000, argument=`tile=${service}&mode=collapsed`;
    const initial=await ipPanel({store,now,argument});
    const next=await ipPanel({store,now:now+7*3600000,argument,outIP:'198.51.100.11',
      intercept:failedGeography('203.0.113.3')});
    assert.doesNotMatch(next.output.content,/深圳|台北|Example|中国电信/);
    assert.match(next.output.title,service==='local'?/203\.0\.113\.3/:/198\.51\.100\.11/);
    const back=await ipPanel({store,now:now+8*3600000,argument,intercept:failedGeography()});
    assert.equal(back.output.content,initial.output.content);
  }
});
test('Stash cached data respects current masking, layout and flags without stale IPv6',async()=>{
  const store=new Map(), now=100000000;
  await ipPanel({store,now,argument:'mode=home',outIPv6:'2001:db8::10'});
  const r=await ipPanel({store,now:now+7*3600000,argument:'mode=home&mask_ip=2&tw_flag=cn',intercept:failedGeography()});
  assert.equal(r.output.title,'出口 IP');assert.match(r.output.content,/🇨🇳/);assert.doesNotMatch(r.output.content,/🇹🇼|198\.51|2001:|IPv6/);
  const localStore=new Map();await ipPanel({store:localStore,now,argument:'tile=local&mode=collapsed'});
  const local=await ipPanel({store:localStore,now:now+7*3600000,argument:'tile=local&mode=home&mask_ip=2',intercept:failedGeography()});
  assert.equal(local.output.url,'https://ippure.com');assert.doesNotMatch(JSON.stringify(local.output),/203\.0\.113\.2/);
});
test('Stash purity reuses missing fields only for IPPure current IP and accepts fresh zero/false',async()=>{
  const store=new Map(), now=100000000, argument='tile=risk&mode=collapsed';
  const initial=await ipPanel({store,now,argument});
  const same=await ipPanel({store,now:now+600000,argument,ippureData:{ip:'198.51.100.10'}});
  assert.equal(same.output.content,initial.output.content);assert.equal(same.output.title,initial.output.title);
  const fresh=await ipPanel({store,now:now+1200000,argument,
    ippureData:{ip:'198.51.100.10',fraudScore:0,isResidential:false,isBroadcast:false}});
  assert.equal(fresh.output.content,'机房 · 原生');assert.equal(fresh.output.title,'IP 纯净度\n0% 低风险');
  for(const ip of ['198.51.100.11',undefined,'','Unknown','999.1.1.1']) {
    const next=await ipPanel({store,now:now+1800000,argument,outIP:'198.51.100.10',ippureData:{ip}});
    assert.equal(next.output.backgroundColor,'#9E9E9E');assert.match(next.output.content,/类型未知/);
    assert.equal(next.requests.length,1);
  }
  const failed=await ipPanel({store,now:now+1800000,argument,riskFailure:true});
  assert.equal(failed.output.content,'IPPure 检测失败');assert.equal(failed.requests.length,1);
});
test('Stash failed refreshes do not renew old fields and all-expired geography stays unknown',async()=>{
  const store=new Map(), now=100000000, argument='tile=risk&mode=collapsed';
  await ipPanel({store,now,argument});
  await ipPanel({store,now:now+23*3600000,argument,ippureData:{ip:'198.51.100.10',fraudScore:90}});
  const partial=await ipPanel({store,now:now+25*3600000,argument,ippureData:{ip:'198.51.100.10'}});
  assert.equal(partial.output.title,'IP 纯净度\n90% 高风险');assert.match(partial.output.content,/类型未知 · 来源未知/);
  for(const service of ['local','outbound']) {
    const geoStore=new Map(), arg=`tile=${service}&mode=collapsed`;
    await ipPanel({store:geoStore,now,argument:arg});
    await ipPanel({store:geoStore,now:now+3600000,argument:arg}); // six-hour geo cache hit must not renew timestamps
    await ipPanel({store:geoStore,now:now+23*3600000,argument:arg,intercept:failedGeography()});
    const expired=await ipPanel({store:geoStore,now:now+25*3600000,argument:arg,intercept:failedGeography()});
    assert.doesNotMatch(expired.output.content,/台北|深圳|Example|中国电信/);
  }
});
test('Stash cache survives unavailable/corrupt storage and caps saved IPs',async()=>{
  const key='stash.ip-security.last-good.v1';
  for(const value of ['invalid','[]','null']) {
    const store=new Map([[key,value]]);
    assert.match((await ipPanel({store,argument:'tile=risk'})).output.content,/12 \/ 100/);
  }
  assert.match((await ipPanel({storageThrows:true,argument:'tile=risk'})).output.content,/12 \/ 100/);
  const store=new Map();
  for(let i=1;i<=35;i++)await ipPanel({store,now:100000000+i,argument:'tile=risk',outIP:`198.51.100.${i}`});
  const records=JSON.parse(store.get(key));assert.equal(Object.keys(records).length,32);
  assert.ok(!records['risk:198.51.100.1']);assert.ok(records['risk:198.51.100.35']);
});
test('Stash IP lookup failure never reuses a last-success address',async()=>{
  for(const service of ['local','outbound']) {
    const store=new Map(), argument=`tile=${service}&mode=collapsed`;
    await ipPanel({store,argument});
    const failed=await ipPanel({store,argument,localIP:null,ipFailure:true});
    assert.equal(failed.output.backgroundColor,'#9E9E9E');assert.match(failed.output.content,/无法获取/);
    assert.doesNotMatch(JSON.stringify(failed.output),/198\.51\.100|203\.0\.113|台北|深圳/);
  }
  const store=new Map(), now=100000000, argument='tile=risk&mode=collapsed';
  await ipPanel({store,now,argument,outIPv6:'2001:db8::1',ippureData:{ip:'2001:db8::1',fraudScore:0,isResidential:false,isBroadcast:false}});
  const same=await ipPanel({store,now:now+600000,argument,outIPv6:'2001:db8::1',ippureData:{ip:'2001:DB8::1'}});
  assert.equal(same.output.title,'IP 纯净度\n0% 低风险');assert.match(same.output.content,/机房 · 原生/);
  const changed=await ipPanel({store,now:now+600000,argument,ippureData:{ip:'2001:db8::2'}});
  assert.equal(changed.output.backgroundColor,'#9E9E9E');
  for(const ip of ['2001:::1',':2001::1','2001::1:']) {
    const invalidStore=new Map();
    await ipPanel({store:invalidStore,now,argument,ippureData:{ip,fraudScore:12}});
    assert.equal(invalidStore.size,0);
  }
});

test('Netflix accepts known video markup and prioritizes request country',async()=>{
  for(const marker of ['<meta property="og:video" content="video">','<div data-uia="episodes">','"playableVideo":{}']) {
    const r=await tile('netflix',{body:marker+' "preferredLocale":{"country":"US"},"requestCountry":{"id":"SG"}'});
    assert.equal(r.output.content,'SG');assert.equal(r.requests.length,1);
  }
});
test('Reddit distinguishes rate limiting, explicit blocks and unknown responses',async()=>{
  for(const [status,body,expected] of [[429,'slow down','Error'],[403,'You have been blocked','NO'],
    [403,'Forbidden','Error'],[200,'<title>Just a moment...</title>','Error'],[200,'Welcome','OK']]) {
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

// Redacted responses captured through Pixel Stash on 2026-09-30.
const pixelResponses=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/media-pixel-20260930.json'),'utf8'));
test('Pixel generic App probe denial must not become a false Web Only result',async()=>{
  for(const client of ['stash','surge']) {
    const r=await tile('chatgpt',o=>o.url.includes('/trace')?{body:'loc=US\n'}:
      pixelResponses[o.url.includes('ios.chat')?'gpt-app':'gpt-web'],{client});
    if(client==='stash') assert.equal(r.output.content,'US');
    else assert.match(r.output.content,/ChatGPT.*US/);
  }
});
test('Claude retains regional fallback for a browser challenge, without treating generic 403 as success',async()=>{
  for(const [trace,expected] of [[{body:'loc=US\n'},'US'],[{body:'loc=HK\n'},'Error'],[{error:'Timeout'},'Error']]) {
    const r=await tile('claude',o=>o.url.includes('/trace')?trace:pixelResponses['claude-login']);
    assert.equal(r.output.content,expected);
  }
  for(const login of [{status:403,body:'Forbidden'},{status:429,body:'<title>Just a moment...</title>'}]) {
    const r=await tile('claude',o=>o.url.includes('/trace')?{body:'loc=US\n'}:login);
    assert.equal(r.output.content,'Error');
  }
  const restricted=await tile('claude',o=>o.url.includes('/trace')?{body:'loc=US\n'}:{status:403,body:'app-unavailable-in-region'});
  assert.equal(restricted.output.content,'NO');
});
test('Ordinary challenge-platform script inclusion is not a verification page',async()=>{
  const r=await tile('claude',o=>o.url.includes('/trace')?{body:'loc=US\n'}:
    {body:'<title>Claude</title><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>'});
  assert.equal(r.output.content,'US');
});
test('Meta AI accepts the captured endpoint authentication response, not arbitrary 401 errors',async()=>{
  const r=await tile('metaai',o=>o.url.endsWith('/ajax')?pixelResponses['meta-ajax']:{error:'Timeout'});
  assert.equal(r.output.content,'OK');
  const region=await tile('metaai',o=>o.url.endsWith('/ajax')?pixelResponses['meta-ajax']:
    {body:'<link rel="canonical" href="https://www.meta.com/us/legal/">'});
  assert.equal(region.output.content,'US');
  const bad=await tile('metaai',{status:401,body:'Unauthorized'});assert.equal(bad.output.content,'Error');
});
test('TikTok HK about page is unavailable; infrastructure ALISG is never a user region',async()=>{
  const r=await tile('tiktok',pixelResponses['tiktok-explore']);
  assert.equal(r.output.content,'NO');assert.equal(r.requests.length,1);
  assert.equal((await tile('tiktok',pixelResponses['tiktok-home'])).output.content,'Error');
  assert.equal((await tile('tiktok',pixelResponses['tiktok-sg'])).output.content,'SG');
});
