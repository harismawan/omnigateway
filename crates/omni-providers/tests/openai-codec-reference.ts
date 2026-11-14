import {openaiCodec} from '../../../packages/providers/src/openai/codec.ts';
const rows=[];
for(const include of [undefined,[],['reasoning.encrypted_content'],'reasoning.encrypted_content'])for(const stream of [false,true]){
 const request:any={model:'pool',stream,messages:[{role:'user',content:[{type:'text',text:'hi'}]}],vendor:{openai:{include}}};
 const built=openaiCodec.buildRequest({request,model:'gpt-5-codex',credentials:{apiKey:'sk',accessToken:null,providerData:{}},fail:(c,m)=>new Error(c+':'+m)});
 const wire=[['response.output_item.added',{item:{type:'reasoning'}}],['response.reasoning_summary_text.delta',{delta:'why'}],['response.output_item.done',{item:{type:'reasoning',encrypted_content:'opaque'}}],['response.completed',{response:{status:'completed'}}]].map(([event,data])=>`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
 const body=new Response(wire).body!;const events=[];
 for await(const e of openaiCodec.decode({body,decodeState:built.decodeState} as any))events.push(e);
 rows.push({request,wire,body:built.request.body,headers:built.request.headers,events});
}
console.log(JSON.stringify(rows));
