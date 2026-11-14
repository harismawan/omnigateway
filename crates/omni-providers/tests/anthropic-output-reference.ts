import {decodeAnthropic} from '../../../packages/providers/src/anthropic/decode.ts';
import {collect,estimateInputTokens} from '../../../packages/ir/src/index.ts';
import {anthropicResponse,anthropicStream} from '../../../apps/gateway/src/egress/anthropic.ts';
import {openaiResponse,openaiStream} from '../../../apps/gateway/src/egress/openai.ts';
import {responsesResponse,responsesStream} from '../../../apps/gateway/src/egress/responses.ts';
const m=(event:string,data:any)=>({event,data:JSON.stringify(data)});
const rows=[];
for(const type of ['text','thinking','tool_use']) for(const reason of ['end_turn','max_tokens','tool_use']) {
 const messages=[m('message_start',{message:{id:'upstream',model:'m',usage:{input_tokens:10,cache_read_input_tokens:2}}}),m('content_block_start',{index:0,content_block:{type,id:'t',name:'read_file'}}),m('content_block_delta',{index:0,delta:type==='text'?{type:'text_delta',text:'hello'}:type==='thinking'?{type:'thinking_delta',thinking:'why'}:{type:'input_json_delta',partial_json:'{"a":1}'}}),m('content_block_stop',{index:0}),m('message_delta',{delta:{stop_reason:reason},usage:{output_tokens:3}}),m('message_stop',{})];
 const iter=async function*(){yield* messages;};const events=[];for await(const e of decodeAnthropic(iter()))events.push(e);
 const source=async function*(){yield* events;};const collected=collect(events);const render={requestId:'req',created:123,customToolNames:new Set<string>()};
 const streams=[];for(const stream of [anthropicStream(source(),'req'),openaiStream(source(),'req',123),responsesStream(source(),render)]) {let text='';for await(const f of stream)text+=`event: ${f.event}\ndata: ${f.data}\n\n`;streams.push(text);}
 rows.push({messages,streams,json:[anthropicResponse(collected,'req'),openaiResponse(collected,'req',123),responsesResponse(collected,render)].map(JSON.stringify)});
}
console.log(JSON.stringify(rows));
