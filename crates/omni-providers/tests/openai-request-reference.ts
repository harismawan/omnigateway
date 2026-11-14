import {toResponsesWire} from '../../../packages/providers/src/openai/wire.ts';
import {openaiCodec} from '../../../packages/providers/src/openai/codec.ts';
import {parseAnthropicRequest} from '../../../apps/gateway/src/ingress/anthropic.ts';
import {parseOpenAIRequest} from '../../../apps/gateway/src/ingress/openai.ts';
import {parseResponsesRequest} from '../../../apps/gateway/src/ingress/responses.ts';
const rows=[];
const base={model:'pool',stream:false,messages:[{role:'user',content:[{type:'text',text:'hi'}]}]};
function add(request:any){
 request=JSON.parse(JSON.stringify(request));
 const model='gpt-5-codex';
 const wire=toResponsesWire(request,model);
 const codec=openaiCodec.buildRequest({request,model,credentials:{apiKey:'sk-oa',accessToken:null,providerData:{}},fail:(c,m)=>new Error(c+':'+m)});
 rows.push({request,model,wire:JSON.stringify(wire.body),notes:wire.degradations,key:wire.cacheKey,codec:codec.request,state:codec.decodeState});
}
add(base);
for(const stream of [false,true]) for(const reasoning of [undefined,{mode:'off'},{mode:'betweenTools'},{mode:'budget',budgetTokens:1024},{mode:'adaptive'},{mode:'adaptive',effort:'high',display:'omitted'},{mode:'adaptive',effort:'max',display:'updates'}]) for(const key of [undefined,'',7,'chosen-by-caller','01a143df-3401-73a0-96db-901f105e1409','bad\r\nx: yes','日本語','x'.repeat(1024),'x'.repeat(1025)]) {
 add({...base,stream,reasoning,system:[{type:'text',text:'be brief'}],maxTokens:123,temperature:0.2,vendor:{openai:{prompt_cache_key:key,session_id:'fallback',response_format:{type:'json_object'}}}});
}
for(const answered of [false,true]) for(const native of [false,true]) {
 const messages:any[]=[...base.messages,{role:'assistant',content:[{type:'text',text:'calling'},{type:'toolUse',id:'t',name:'read',input:{z:1,'2':'two',a:[true]}}]}];
 if(answered) messages.push({role:'user',content:[{type:'toolResult',toolUseId:'t',content:'done',images:[{mediaType:'image/png',data:'aA=='}]}]});
 messages.push({role:'system',content:[{type:'text',text:'reminder'},{type:'thinking',text:'hidden'},{type:'image',mediaType:'image/png',data:'aA=='}]});
 if(native)messages.push({role:'assistant',content:[{type:'providerNative',provider:'openai',blockType:'reasoning',data:{id:'strip',encrypted_content:'abc',summary:[]}}]});
 for(const choice of ['auto','any','none','tool']) add({...base,messages,tools:[{kind:'portable',name:'read',description:'read it',inputSchema:{type:'object',properties:{path:{type:'string'}}}}],toolChoice:{type:choice,name:'read'},vendor:{openai:{include:['reasoning.encrypted_content']}}});
}
for(const vendor of [{},{input:[],model:'override',stream:false,store:true},{text:7},{response_format:{type:'json_schema',json_schema:{name:'n',schema:{type:'object'}}}},{text:{verbosity:'high',format:{type:'json_schema',schema:{type:'object'}}}}]) for(const conversationId of [undefined,'','private-id']) add({...base,conversationId,vendor:{openai:vendor}});
add({...base,messages:[]});
for(const stream of [true,false]) {
 for(const [dialect,parse,body] of [
 ['anthropic',parseAnthropicRequest,{model:'pool',max_tokens:123,messages:[{role:'user',content:'hi'}],system:'be brief'}],
 ['openai',parseOpenAIRequest,{model:'pool',messages:[{role:'system',content:'be brief'},{role:'user',content:'hi'}],max_tokens:123}],
 ['responses',parseResponsesRequest,{model:'pool',input:'hi',instructions:'be brief',max_output_tokens:123}]
 ] as const){const client={...body,stream};add(parse(client));Object.assign(rows.at(-1),{dialect,client});}
}
for(const mediaType of ['text/plain','application/pdf','application/octet-stream']) add({...base,messages:[{role:'assistant',content:[{type:'toolUse',id:'t',name:'read',input:{}}]},{role:'user',content:[{type:'toolResult',toolUseId:'t',content:'done',files:[{mediaType,data:'aGk=',name:'a.txt'}]}]}]});
console.log(JSON.stringify(rows));
