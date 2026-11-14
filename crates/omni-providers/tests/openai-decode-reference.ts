import {decodeResponses} from '../../../packages/providers/src/openai/decode.ts';
import {parseSse} from '../../../packages/providers/src/sse.ts';
import {collect} from '../../../packages/ir/src/index.ts';
import {anthropicResponse} from '../../../apps/gateway/src/egress/anthropic.ts';
import {openaiResponse} from '../../../apps/gateway/src/egress/openai.ts';
import {responsesResponse} from '../../../apps/gateway/src/egress/responses.ts';
const m=(event:string,data:any)=>`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const end=m('response.completed',{response:{status:'completed',usage:{input_tokens:10,output_tokens:4,input_tokens_details:{cached_tokens:3}}}});
const text=m('response.created',{response:{id:'r',model:'m'}})+m('response.content_part.added',{output_index:2,part:{type:'output_text'}})+m('response.output_text.delta',{output_index:2,delta:'hello 🌍'})+m('response.content_part.done',{output_index:2});
const cases:any[]=[];
function add(category:string,wire:string,native=false){cases.push({category,wire,native});}
add('text',text+end);
for(const count of [1,2]) for(const interleave of [false,true]) {
 let wire='';for(let i=0;i<count;i++)wire+=m('response.output_item.added',{output_index:i,item:{type:'function_call',call_id:`c${i}`,name:'read'}});
 if(interleave)wire+=text;
 for(let i=0;i<count;i++)wire+=m('response.function_call_arguments.delta',{output_index:i,delta:'{"x":1}'})+m('response.output_item.done',{output_index:i,item:{type:'function_call'}});
 add('tools',wire+end);
}
for(const native of [false,true]) add('reasoning',m('response.output_item.added',{output_index:7,item:{type:'reasoning'}})+m('response.reasoning_summary_text.delta',{output_index:7,delta:'why'})+m('response.output_item.done',{output_index:7,item:{type:'reasoning',id:'rs',summary:[{type:'summary_text',text:'why'}],encrypted_content:'opaque'}})+text+end,native);
for(const usage of [undefined,{}, {input_tokens:3,output_tokens:4,input_tokens_details:{cached_tokens:9}}, {input_tokens:10,output_tokens:2,prompt_tokens_details:{cached_tokens:4},output_tokens_details:{reasoning_tokens:1}}])add('usage',text+m('response.completed',{response:{usage}}));
for(const event of ['response.completed','response.incomplete'])for(const status of [undefined,'completed','incomplete','cancelled'])for(const reason of [undefined,'max_output_tokens','content_filter','future',null])add('terminal',m(event,{response:{status,incomplete_details:{reason}}}));
for(const code of ['rate_limit_exceeded','insufficient_quota','invalid_api_key','server_error','context_length_exceeded','content_policy_violation','constructor'])for(const event of ['error','response.failed'])for(const prefix of ['',text])add('errors',prefix+m(event,{error:{code,message:'bad'},response:{error:{code,message:'bad'}}}));
for(const wire of ['',text,text+end+end,'data: [DONE]\n\n',m('unknown',{})+'data: [DONE]\n\n','event: response.output_text.delta\ndata: {broken}\n\n'+end,'event: unknown\ndata: broken\n\n',text+'event: response.completed\ndata: {',m('response.output_text.delta',{delta:'out of order'})+end,m('response.output_item.added',{item:{type:'unknown',payload:{opaque:1}}})+end,m('response.metadata',{})+m('keepalive',{})+end,m('response.output_text.delta',{delta:'x'.repeat(20000)})+end])add('malformed',wire);
const rows=[];
add('decoder-literal-edges',text+m('response.output_item.done',{output_index:2,item:{type:'message'}})+m('response.output_item.done',{output_index:2,item:{type:'message'}})+end);
add('decoder-literal-edges',m('response.output_item.added',{item:{type:'reasoning'}})+m('response.reasoning_summary_text.delta',{delta:'why'})+m('response.output_item.done',{item:{type:'reasoning'}})+m('response.output_item.done',{item:{type:'reasoning'}})+text+end);
add('decoder-literal-edges',text+end+'data: [DONE]\n\n');
add('decoder-literal-edges',m('response.in_progress',{})+text+end);
add('decoder-literal-edges',text+m('response.metadata',{metadata:{opaque:1}})+end);
add('decoder-literal-edges',m('keepalive',{})+text+end);
const malformedValues=[undefined,null,'2',2.5,-1,1e100,{},[],true];
for(const value of malformedValues){
 add('coercion-index',m('response.output_item.added',{output_index:value,item:{type:'function_call',call_id:'c',name:'f'}})+m('response.function_call_arguments.delta',{output_index:value,delta:'{}'})+m('response.output_item.done',{output_index:value})+m('response.content_part.added',{output_index:value,content_index:value,part:{type:'output_text'}})+m('response.output_text.delta',{output_index:value,content_index:value,delta:'hi'})+m('response.content_part.done',{output_index:value,content_index:value})+end);
 add('coercion-delta',textStart()+m('response.output_text.delta',{delta:value})+m('response.content_part.done',{})+end);
 add('coercion-response',m('response.completed',{response:value}));
 for(const field of ['input_tokens','output_tokens','cached_tokens']){
  const usage:any={input_tokens:10,output_tokens:2,input_tokens_details:{cached_tokens:3}};
  if(field==='cached_tokens')usage.input_tokens_details.cached_tokens=value;else usage[field]=value;
  add('coercion-usage',m('response.completed',{response:{usage}}));
 }
}
function textStart(){return m('response.content_part.added',{part:{type:'output_text'}});}
for(const item of [undefined,null,{}, {id:'id'}, {type:'function_call'}, {type:'reasoning'}, {type:'unknown'}])add('coercion-item',m('response.output_item.added',{item})+m('response.output_item.done',{item})+end);
for(const c of cases){
 const bytes=new TextEncoder().encode(c.wire);
 let expected:string|undefined;
 let originalEvents:any[]=[];
 for(const chunk of [bytes.length||1,1,7]){
  const body=new ReadableStream({start(controller){for(let i=0;i<bytes.length;i+=chunk)controller.enqueue(bytes.slice(i,i+chunk));controller.close();}});
  const events=[];for await(const e of decodeResponses(parseSse(body),{nativeReasoning:c.native}))events.push(e);
  const encoded=JSON.stringify(events);if(expected!==undefined&&expected!==encoded)throw new Error('TS chunk dependence');expected=encoded;
  originalEvents=events;
 }
 const collected=collect(originalEvents);
 rows.push({...c,events:JSON.parse(expected!),json:[anthropicResponse(collected,'req'),openaiResponse(collected,'req',123),responsesResponse(collected,{requestId:'req',created:123,customToolNames:new Set()})].map(JSON.stringify)});
}
console.log(JSON.stringify(rows));
