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
function add(category:string, request:any, model:string, label:string, credential=credentials) {
 const credentials=credential;
 const built=openaiCodec.buildRequest({request,model,credentials,requestId,requestStartedAt,fail:(c,m)=>new Error(c+':'+m)});
 rows.push({category,label,request,model,credentials,codec:built.request,notes:built.degradations,state:built.decodeState});
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
for(const model of ['gpt-6-astra','gpt-5.5']) for(const stream of [false,true]) for(const media of ['text/plain','application/pdf','application/octet-stream']) {
 const url='data:image/png;base64,aA==';
 for(const [dialect,parse,body] of [
  ['anthropic',parseAnthropicRequest,{model:'pool',max_tokens:123,messages:[{role:'user',content:[{type:'text',text:'hi'},{type:'image',source:{type:'base64',media_type:'image/png',data:'aA=='}}]},{role:'assistant',content:[{type:'tool_use',id:'c',name:'read',input:{}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'c',content:[{type:'text',text:'done'},{type:'image',source:{type:'base64',media_type:'image/png',data:'aA=='}},{type:'document',source:{type:'base64',media_type:media,data:'aGk='}}]}]}]}],
  ['openai',parseOpenAIRequest,{model:'pool',messages:[{role:'user',content:[{type:'text',text:'hi'},{type:'image_url',image_url:{url}}],attachments:[{url:`data:${media};base64,aGk=`,mediaType:media}]},{role:'assistant',tool_calls:[{id:'c',type:'function',function:{name:'read',arguments:'{}'}}]},{role:'tool',tool_call_id:'c',content:'done'}]}],
  ['responses',parseResponsesRequest,{model:'pool',input:[{role:'user',content:[{type:'input_text',text:'hi'},{type:'input_image',image_url:url}]},{type:'function_call',call_id:'c',name:'read',arguments:'{}'},{type:'function_call_output',call_id:'c',output:[{type:'input_text',text:'done'},{type:'input_image',image_url:url},{type:'input_file',filename:'a',file_data:`data:${media};base64,aGk=`}]}]}],
 ] as const) {
  const client={...body,stream};
  add('media',parse(client),model,`${dialect}/${stream}/${media}`);
  Object.assign(rows.at(-1),{dialect,client});
 }
}
for(const model of ['gpt-6-astra','gpt-5.5']) for(const vendor of [
 {response_format:{type:'json_object'}},
 {response_format:{type:'json_schema',json_schema:{name:'answer',strict:true,schema:{type:'object',properties:{answer:{type:'string'}}}}}},
 {response_format:{type:'text'}},
 {text:{format:{type:'json_schema',name:'answer',schema:{type:'object'}}}},
 {text:{verbosity:'high',format:{type:'json_object'}},response_format:{type:'json_object'}},
 {text:7,response_format:{type:'json_object'}},
]) add('response-format',{...base,vendor:{openai:vendor}},model,JSON.stringify(vendor));
for(const model of ['gpt-6-astra','gpt-6.1-sol','gpt-6.1-terra','gpt-6-sol','gpt-6-luna','gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna','gpt-daybreak-blue-latest','gpt-daybreak-red-latest','gpt-5.5','codex-auto-review','unlisted','__proto__']) for(const prefix of [false,true]) {
 const messages=[...base.messages,{role:'assistant',content:[{type:'providerNative',provider:'openai',blockType:'reasoning',data:{id:'discard',encrypted_content:'secret',internal_chat_message_metadata_passthrough:{bad:true}}},{type:'text',text:'answer'}]},{role:'user',content:[{type:'text',text:'next'}]},{role:'system',content:[{type:'text',text:'operator'}]}];
 add('lite-catalog',{...base,messages,...(prefix?{system:[{type:'text',text:'Unicode 日本語'}],tools:[{kind:'portable',name:'read',inputSchema:{type:'object'}}]}:{})},model,`prefix/${prefix}`);
}
const branchCases=[
 ['baseline',{}],
 ['controls',{system:[{type:'text',text:'instructions'}],maxTokens:123,temperature:0.4,reasoning:{mode:'betweenTools'},tools:[{kind:'portable',name:'read',inputSchema:{type:'object'}}]}],
 ['choice',{toolChoice:{type:'tool',name:'read'},tools:[]}],
 ['merge',{vendor:{openai:{text:{format:{type:'json_object'}},reasoning:{effort:'high'},client_metadata:{foreign:'secret'},input:[],instructions:'vendor instructions',tools:[],max_output_tokens:9,temperature:0.7,store:true,stream:false,parallel_tool_calls:true}}}],
 ['scalar-merge',{vendor:{openai:{text:7,reasoning:null,client_metadata:null,include:[]}}}],
 ['tier',{vendor:{openai:{service_tier:'priority',include:['reasoning.encrypted_content']}}}],
 ['bad-tier',{vendor:{openai:{service_tier:'bad;tier'}}}],
 ['invalid-effort',{vendor:{openai:{reasoning:{effort:'invalid'}}}}],
] as const;
for(const model of ['gpt-6-astra','gpt-5.5']) for(const oauth of [true,false]) for(const [name,patch] of branchCases) {
 add('oauth-branches',{...base,...patch},model,`${oauth}/${name}`,{apiKey:oauth?null:'sk-oa',accessToken:oauth?'oauth-token':null,providerData:{accountId:'account',idSalt:'a'.repeat(64)}} as any);
}
for(const model of ['bad model','日本語']) add('oauth-branches',base,model,'routing-omitted');
for(const accountId of [undefined,7]) add('oauth-branches',base,'gpt-6-astra','account-omitted',{...credentials,providerData:{accountId}} as any);
const installationId='12345678-1234-4234-8234-123456789abc';
for(const providerData of [{},{accountId:'account'},{installationId,idSalt:'a'.repeat(64)},{installationId},{idSalt:'b'.repeat(64)},
 {installationId:'bad',idSalt:'A'.repeat(64)},{installationId:7,idSalt:null},{installationId:{nested:[]},idSalt:[]},
 {installationId:installationId.toUpperCase(),idSalt:'0'.repeat(64)},{installationId:'',idSalt:'a'.repeat(63)},
 {installationId:installationId+'\n',idSalt:'a'.repeat(64)+'\n'}])
 for(const model of ['gpt-6-astra','gpt-5.5']) add('identity',base,model,JSON.stringify(providerData),{...credentials,providerData} as any);
console.log(JSON.stringify(rows));
