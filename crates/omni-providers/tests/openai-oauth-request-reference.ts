import {openaiCodec} from '../../../packages/providers/src/openai/codec.ts';
import {parseAnthropicRequest} from '../../../apps/gateway/src/ingress/anthropic.ts';
import {parseOpenAIRequest} from '../../../apps/gateway/src/ingress/openai.ts';
import {parseResponsesRequest} from '../../../apps/gateway/src/ingress/responses.ts';
const requestId='fixed-oauth-request';
const requestStartedAt=1794000000123;
const credentials={apiKey:null,accessToken:'oauth-token',providerData:{accountId:'account'}};
const rows=[];
for(const stream of [false,true]) for(const [dialect,parse,body] of [
 ['anthropic',parseAnthropicRequest,{model:'pool',max_tokens:123,messages:[{role:'user',content:'hi'}],system:'be brief'}],
 ['openai',parseOpenAIRequest,{model:'pool',messages:[{role:'system',content:'be brief'},{role:'user',content:'hi'}],max_tokens:123}],
 ['responses',parseResponsesRequest,{model:'pool',input:'hi',instructions:'be brief',max_output_tokens:123}],
] as const) {
 const client={...body,stream};
 const request=parse(client);
 const model='gpt-5-codex';
 const built=openaiCodec.buildRequest({request,model,credentials,requestId,requestStartedAt,fail:(c,m)=>new Error(c+':'+m)});
 rows.push({category:'three-dialects',dialect,client,model,codec:built.request,notes:built.degradations,state:built.decodeState});
}
const base={model:'pool',stream:false,messages:[{role:'user',content:[{type:'text',text:'hi'}]}]};
function add(category:string, request:any, model:string, label:string) {
 const built=openaiCodec.buildRequest({request,model,credentials,requestId,requestStartedAt,fail:(c,m)=>new Error(c+':'+m)});
 rows.push({category,label,request,model,codec:built.request,notes:built.degradations,state:built.decodeState});
}
for(const model of ['gpt-6-astra','gpt-5.5']) {
 for(const effort of ['none','minimal','low','medium','high','xhigh','max'])
  for(const display of [undefined,'omitted','updates'])
   add('reasoning', {...base,reasoning:{mode:'adaptive',effort,display}},model,`${effort}/${display}`);
 for(const reasoning of [undefined,{mode:'off'},{mode:'betweenTools'},{mode:'budget',budgetTokens:1024},{mode:'adaptive'}])
  add('reasoning',{...base,reasoning},model,`mode/${reasoning?.mode}`);
 for(const reasoning of [{},{effort:'high'},{effort:'ultra'},{effort:'persistent'},{effort:'invalid'},{effort:null},{effort:7},{effort:''},{effort:'bad\r\nheader'},null,7,'invalid'])
  add('reasoning',{...base,vendor:{openai:{reasoning}}},model,`vendor/${JSON.stringify(reasoning)}`);
}
for(const model of ['gpt-6-astra','gpt-5.5']) for(const count of [1,2]) for(const answered of [false,true]) for(const mixed of [false,true]) {
 const calls=Array.from({length:count},(_,i)=>({type:'toolUse',id:`call-${i}`,name:'read',input:{path:`file-${i}`}}));
 const messages:any[]=[...base.messages,{role:'assistant',content:[{type:'text',text:'checking'},...calls]}];
 if(answered) messages.push({role:'user',content:calls.flatMap((c,i)=>[
  {type:'toolResult',toolUseId:c.id,content:'result',...(mixed?{images:[{mediaType:'image/png',data:'aA=='}],files:[{mediaType:'application/pdf',data:'aA==',name:'doc.pdf'}]}:{})},
  ...(mixed?[{type:'text',text:`followup-${i}`},{type:'image',mediaType:'image/png',data:'aA=='}]:[])
 ])});
 messages.push({role:'user',content:[{type:'text',text:'continue'}]});
 add('tools',{...base,messages,system:[{type:'text',text:'use tools'}],tools:[{kind:'portable',name:'read',description:'Read file',inputSchema:{type:'object',properties:{path:{type:'string'}}}}]},model,`${count}/${answered}/${mixed}`);
}
console.log(JSON.stringify(rows));
