// Expected JSON travels as a string: parsing it into serde Value would itself
// reject the surrogate we are trying to measure.
import {decodeResponses} from '../../../packages/providers/src/openai/decode.ts';
import {parseSse} from '../../../packages/providers/src/sse.ts';
import {collect} from '../../../packages/ir/src/index.ts';
import {anthropicResponse} from '../../../apps/gateway/src/egress/anthropic.ts';
import {openaiResponse} from '../../../apps/gateway/src/egress/openai.ts';
import {responsesResponse} from '../../../apps/gateway/src/egress/responses.ts';
const enc=new TextEncoder();
const m=(event:string,data:unknown)=>`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const end=m('response.completed',{response:{status:'completed'}});
const start=m('response.created',{response:{id:'r',model:'m'}});
const textStart=m('response.content_part.added',{part:{type:'output_text'}});
const textEnd=m('response.content_part.done',{});
const cases=[
 {name:'surrogate-text',native:false,bytes:enc.encode(start+textStart+m('response.output_text.delta',{delta:'\uD83D'})+textEnd+end)},
 {name:'surrogate-arguments',native:false,bytes:enc.encode(start+m('response.output_item.added',{item:{type:'function_call',call_id:'c',name:'f'}})+m('response.function_call_arguments.delta',{delta:'{"x":"\uD83D"}'})+m('response.output_item.done',{})+end)},
 {name:'surrogate-reasoning',native:true,bytes:enc.encode(start+m('response.output_item.added',{item:{type:'reasoning'}})+m('response.output_item.done',{item:{type:'reasoning',summary:[{type:'summary_text',text:'\uD83D'}],encrypted_content:'\uD83D'}})+end)},
 {name:'surrogate-error',native:false,bytes:enc.encode(start+m('error',{error:{code:'server_error',message:'\uD83D'}}))},
 {name:'invalid-utf8',native:false,bytes:Uint8Array.from([...enc.encode(start+textStart+'event: response.output_text.delta\ndata: {"delta":"'),0xff,0xc0,0xaf,...enc.encode('"}\n\n'+textEnd+end)])},
 {name:'truncated-utf8',native:false,bytes:Uint8Array.from([...enc.encode(start+textStart+'event: response.output_text.delta\ndata: {"delta":"'),0xf0,0x9f])},
];
const rows=[];
for(const c of cases){
 for(const chunk of [c.bytes.length,1,7]){
  const body=new ReadableStream({start(controller){for(let i=0;i<c.bytes.length;i+=chunk)controller.enqueue(c.bytes.slice(i,i+chunk));controller.close();}});
  const events=[];for await(const event of decodeResponses(parseSse(body),{nativeReasoning:c.native}))events.push(event);
  const collected=collect(events);
  rows.push({name:c.name,native:c.native,bytes:[...c.bytes],chunk,events:events.map(JSON.stringify),json:[anthropicResponse(collected,'req'),openaiResponse(collected,'req',123),responsesResponse(collected,{requestId:'req',created:123,customToolNames:new Set()})].map(JSON.stringify)});
 }
}
console.log(JSON.stringify(rows));
