import {toWire} from '../../../packages/providers/src/anthropic/wire.ts';
import {buildToolCloak} from '../../../packages/providers/src/anthropic/cloak.ts';
const rows=[];
for(const model of ['m','claude-opus-5-5','claude-haiku-4-5-20251001[1m]']) for(const oauth of [false,true]) for(const reasoning of [undefined,{mode:'off'},{mode:'budget',budgetTokens:1024},{mode:'adaptive',effort:'high',display:'omitted'},{mode:'betweenTools'}]) for(const trailing of [false,true]) {
 const request:any={model:'virtual',stream:false,system:[{type:'text',text:'system',cacheControl:{type:'ephemeral'}}],messages:[{role:'user',content:[{type:'text',text:'hello'}]},{role:'assistant',content:[{type:'thinking',text:'unsigned'}]},{role:'assistant',content:[{type:'toolUse',id:'t',name:'read_file',input:{}}]}],tools:[{kind:'portable',name:'read_file',description:'read',inputSchema:{type:'object'},options:{strict:true}},{kind:'provider',provider:'anthropic',type:'web_search_20250305',name:'web_search',wire:{max_uses:3}}],toolChoice:{type:'tool',name:'read_file'},reasoning,temperature:0.3,stopSequences:['stop']};
 if(trailing)request.messages.push({role:'system',content:[{type:'text',text:'reminder',cacheControl:{type:'ephemeral',ttl:'1h'}}]});
 const cloak=oauth?buildToolCloak(request):null;
 const result=toWire(request,model,{oauth,cloak,maxOutputTokens:100000});
 rows.push({request,model,oauth,body:JSON.stringify(result.body),degradations:result.degradations});
}
console.log(JSON.stringify(rows));
