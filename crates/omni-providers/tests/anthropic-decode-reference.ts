import { decodeAnthropic } from '../../../packages/providers/src/anthropic/decode.ts';
import { ANTHROPIC_NATIVE_BLOCK_TYPES } from '../../../packages/providers/src/anthropic/tools.ts';
const m = (event: string, data: unknown) => ({event,data:JSON.stringify(data)});
const cases: any[][] = [[], [{event:'ping',data:'broken'}], [m('new_event',{})]];
const start = m('message_start',{message:{id:'id',model:'model',usage:{input_tokens:2,cache_read_input_tokens:3,cache_creation_input_tokens:4,cache_creation:{ephemeral_5m_input_tokens:1,ephemeral_1h_input_tokens:3}}}});
for (const type of ['text','thinking','tool_use',...ANTHROPIC_NATIVE_BLOCK_TYPES,'unknown']) {
 for (const delta of [{type:'text_delta',text:'hi'},{type:'thinking_delta',thinking:'why'},{type:'signature_delta',signature:'sig'},{type:'signature_delta'},{type:'input_json_delta',partial_json:'{}'},{type:'citations_delta',citation:{url:'x'}},{type:'compaction_delta',content:'summary',encrypted_content:'opaque'},{type:'unknown'},{}]) {
  cases.push([start,m('content_block_start',{index:2,content_block:{type,id:'t',name:'Tool',input:{},content:'initial'}}),m('content_block_delta',{index:2,delta}),m('content_block_stop',{index:2}),m('message_delta',{delta:{stop_reason:'end_turn',safeguard_results:null},usage:{input_tokens:5,output_tokens:6}}),m('message_stop',{})]);
 }
}
for (const reason of ['end_turn','max_tokens','stop_sequence','tool_use','refusal','pause_turn','constructor']) cases.push([start,m('message_delta',{delta:{stop_reason:reason}}),m('message_stop',{})]);
for (const type of ['overloaded_error','rate_limit_error','authentication_error','permission_error','invalid_request_error','api_error','constructor']) for (const message of ['bad','Out of extra usage','draw from extra usage']) cases.push([m('error',{error:{type,message}})]);
cases.push([start], [m('content_block_start',{})], [m('message_stop',{safeguard_results:[]})]);
for(const value of [123,false,{},[],[1,null,'x']]) {
 cases.push([m('message_start',{message:{id:value,model:value}}),m('content_block_start',{content_block:{type:'tool_use',id:value,name:value}}),m('error',{error:{message:value}})]);
}
const rows = [];
for(const value of [{toString:null},null]){
 for(const field of ['id','model'])cases.push([m('message_start',{message:{[field]:value}})]);
 for(const field of ['id','name'])cases.push([m('content_block_start',{content_block:{type:'tool_use',[field]:value}})]);
 cases.push([m('content_block_start',{content_block:{type:value}})],[m('content_block_delta',{delta:{type:value}})]);
 for(const field of ['type','message'])cases.push([m('error',{error:{[field]:value}})]);
}
const overflow=process.argv.includes('--overflow');
if(overflow){cases.length=0;cases.push([{event:'message_start',data:'{"message":{"id":1e309}}'}],[{event:'message_start',data:'{"message":{"id":"keep"},"ignored":1e309}'}]);}
for (const messages of cases) {
 const events = []; let throws=false;try{for await (const e of decodeAnthropic((async function*(){yield* messages;})())) events.push(e);}catch(e){if(!(e instanceof TypeError))throw e;throws=true;}
 rows.push({messages,events,throws});
}
console.log(JSON.stringify(rows));
