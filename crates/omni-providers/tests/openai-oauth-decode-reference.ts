import {openaiCodec} from '../../../packages/providers/src/openai/codec.ts';
import {collect} from '../../../packages/ir/src/index.ts';
import {anthropicResponse} from '../../../apps/gateway/src/egress/anthropic.ts';
import {openaiResponse} from '../../../apps/gateway/src/egress/openai.ts';
import {responsesResponse} from '../../../apps/gateway/src/egress/responses.ts';

const run=Bun.spawnSync(['bun','tests/openai-decode-reference.ts']);
if(run.exitCode!==0) throw new Error(run.stderr.toString());
const rows=JSON.parse(run.stdout.toString());
for(const row of rows) {
 const request={model:'pool',stream:false,messages:[{role:'user',content:[{type:'text',text:'hi'}]}],
  ...(row.native?{vendor:{openai:{include:['reasoning.encrypted_content']}}}:{})};
 for(const oauth of [true,false]) {
  const built=openaiCodec.buildRequest({request,model:'gpt-6-astra',credentials:{accessToken:oauth?'oauth-token':null,apiKey:oauth?null:'sk-test',providerData:{}},requestId:'req',requestStartedAt:123,fail:(c,m)=>new Error(c+':'+m)});
  if(built.decodeState.nativeReasoning!==row.native) throw new Error('client include state');
  if(oauth&&!JSON.parse(built.request.body).include.includes('reasoning.encrypted_content')) throw new Error('OAuth include default');
  for(const chunk of [new TextEncoder().encode(row.wire).length||1,1,7]) {
   const bytes=new TextEncoder().encode(row.wire);
   const body=new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=chunk)c.enqueue(bytes.slice(i,i+chunk));c.close();}});
   const events=[]; let threw=false; try {for await(const event of openaiCodec.decode({body,decodeState:built.decodeState,headers:new Headers()})) events.push(event);} catch(e) {if (!(e instanceof TypeError)) throw e;threw=true;}
   if(threw!==Boolean(row.throws)) throw new Error(`${row.category}: codec throw`);
   if(JSON.stringify(events)!==JSON.stringify(row.events)) throw new Error(`${row.category}: codec events ${oauth}/${chunk}`);
   const collected=collect(events);
   const json=[anthropicResponse(collected,'req'),openaiResponse(collected,'req',123),responsesResponse(collected,{requestId:'req',created:123,customToolNames:new Set()})].map(JSON.stringify);
   if(JSON.stringify(json)!==JSON.stringify(row.json)) throw new Error(`${row.category}: codec buffered ${oauth}/${chunk}`);
  }
 }
 row.request=request;
}
console.log(JSON.stringify(rows));
