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
console.log(JSON.stringify(rows));
