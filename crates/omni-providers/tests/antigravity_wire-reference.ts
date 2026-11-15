import { toAntigravityWire } from '../../../packages/providers/src/antigravity/wire.ts';
import { buildToolCloak } from '../../../packages/providers/src/antigravity/cloak.ts';
import { AGENT_PREAMBLE, BILLING_PREFIX } from '../../../packages/providers/src/body.ts';

// Whole-envelope neighbours of antigravityWire.test.ts's message, fingerprint,
// generation, tool and vendor fixtures. Numeric overrides survive JSON transport.
const rows: any[] = [];
function add(label: string, patch: any = {}, numbers?: any) {
  const request = { model: 'gemini-3.6-flash-high', stream: true, messages: [], ...patch };
  const actual = structuredClone(request);
  for (const [key, value] of Object.entries(numbers ?? {})) {
    const n = value === 'NaN' ? NaN : value === 'Infinity' ? Infinity : value === '-Infinity' ? -Infinity : -0;
    if (key === 'budget') actual.reasoning = { mode: 'budget', budgetTokens: n };
    else actual[key] = n;
  }
  const r = toAntigravityWire(actual, request.model, { project: 'projects/p-1', requestId: 'req-1', cloak: buildToolCloak(actual) });
  rows.push({ label, request, numbers, expected: JSON.stringify(r.body), notes: r.degradations });
}
const text = { type: 'text', text: 'hello' };
const call = { type: 'toolUse', id: 'id', name: 'read file', input: { '10': 1e21, '2': 1e-7, z: -0, a: [null, true, '😀'] } };
const result = { type: 'toolResult', toolUseId: 'id', content: 'ok' };
const native = { type: 'providerNative', provider: 'anthropic', blockType: 'x', data: {} };
const image = { type: 'image', mediaType: 'image/png', data: 'AAA' };
add('empty');
for (const role of ['user', 'assistant', 'system']) {
  for (const content of [[], [text], [call], [result], [text, result], [result, text], [call, result], [image], [{type:'thinking',text:'hmm'}], [native], [text, native, image]]) {
    add(`blocks:${role}:${JSON.stringify(content)}`, { messages: [{role,content}] });
  }
  for (const block of [text,call,result,image,native]) add(`cache:${role}:${block.type}`, {messages:[{role,content:[{...block,cacheControl:{type:'ephemeral'}}]}]});
}
for (const roles of [['user','system','user'],['assistant','assistant','user'],['user','user','assistant','assistant'],['assistant','system','assistant'],['user','assistant','user']]) add(`roles:${roles}`, {messages:roles.map(role=>({role,content:[text]}))});
for (const matched of [false,true]) for (const isError of [undefined,false,true]) for (const content of ['', 'ok']) {
  add(`result:${matched}:${isError}:${content}`, {messages:[...(matched?[{role:'assistant',content:[call]}]:[]),{role:'assistant',content:[{...result,content,isError,native:[],images:[image]}]}]});
}
for (const mediaType of ['text/plain',' text/markdown; charset=utf-8','application/json','application/x-ndjson','application/xml','application/yaml','application/toml','application/javascript','application/typescript','application/sql','application/x-sh','message/rfc822','application/problem+json','application/x+xml','image/png','application/pdf','application/octet-stream','unknown']) for (const data of ['', 'aGVsbG8=', '/w==', '%%%']) add(`file:${mediaType}:${data}`, {messages:[{role:'user',content:[{...result,files:[{type:'file',mediaType,data,filename:'x'}]}]}]});
for (const input of [null,true,0,1.5,'x',[],{}, {'__proto__':null,constructor:'x',toString:5}, Array(80).fill(0).reduce(v=>({n:v}),{})]) add(`input:${JSON.stringify(input)}`,{messages:[{role:'assistant',content:[{...call,input}]}]});
for (const system of [[], [text], [image,native], [{...text,cacheControl:{type:'ephemeral'}}], [text,text]]) add(`system-blocks:${JSON.stringify(system)}`,{system});
for (const value of ['', ' \t\ufeff ', AGENT_PREAMBLE, BILLING_PREFIX+' cc_version=x', `a\n\n${AGENT_PREAMBLE}\n\nb`, `a\r\n\r\n${AGENT_PREAMBLE}\r\n\r\nb`, ` ${BILLING_PREFIX} x \n\n${AGENT_PREAMBLE}`, `quote ${BILLING_PREFIX}`, `${AGENT_PREAMBLE}!`, 'a\n\n\n\nb', `a\n\n${BILLING_PREFIX}x\n\n${BILLING_PREFIX}y`]) add(`system:${value}`,{system:[{type:'text',text:value}]});
for (const maxTokens of [0,-1,1,1.5,65535,65536,65537,1e21]) for (const model of ['gemini-3.6-flash-high','gemini-3.1-pro-high']) add(`max:${model}:${maxTokens}`,{model,maxTokens});
for (const temperature of [-1,0,1e-7,1.5,2,2.0000001]) add(`temperature:${temperature}`,{temperature});
for (const key of ['maxTokens','temperature','budget']) for (const number of ['-0','NaN','Infinity','-Infinity']) add(`number:${key}:${number}`,{}, {[key]:number});
for (const n of [0,1,5,6,8]) add(`stops:${n}`,{stopSequences:Array.from({length:n},(_,i)=>`${i}`)});
for (const budgetTokens of [-2,-1,0,1,1.5,65534,65535,65536]) for (const maxTokens of [undefined,0,1,65535,65536,1e21]) add(`budget:${budgetTokens}:${maxTokens}`,{temperature:0.2,reasoning:{mode:'budget',budgetTokens},maxTokens});
for (const mode of ['off','betweenTools']) add(`reasoning:${mode}`,{reasoning:{mode}});
for (const display of [undefined,'summarized','omitted','updates']) for (const effort of [undefined,'none','minimal','low','medium','high','xhigh','max']) add(`adaptive:${display}:${effort}`,{reasoning:{mode:'adaptive',display,effort}});
const tool = {kind:'portable',name:'read file',inputSchema:{type:'object',properties:{x:{type:'string'}},required:['x']}};
for (const tools of [[],[tool],[{...tool,description:''}],[tool,tool],[tool,{...tool,name:'read_file'}],[{kind:'provider',provider:'anthropic',type:'bash',name:'bash',wire:{}}],[tool,{...tool,name:'other',inputSchema:{const:'a',unknown:1}}]]) add(`tools:${JSON.stringify(tools)}`,{tools});
for (const type of ['auto','any','none','tool']) for (const tools of [undefined,[],[tool]]) add(`choice:${type}:${JSON.stringify(tools)}`,{toolChoice:{type,...type==='tool'?{name:'read file'}:{}},tools});
for (const schema of [{},{type:'object',properties:{x:{type:'string'}}},{const:'a'},false,null,[],Array(64).fill(0).reduce(v=>({items:v}),{})]) {
  for (const vendor of [{openai:{response_format:{type:'json_schema',json_schema:{name:'x',schema}}}},{openai:{text:{format:{type:'json_schema',schema}}}},{anthropic:{output_config:{format:{type:'json_schema',schema}}}}]) add(`format:${JSON.stringify(vendor)}`,{vendor});
}
for (const response_format of [null,{},false,{type:'json_object'},{type:'json_schema',json_schema:[]},{type:'json_schema',json_schema:{schema:{},name:{toString:null}}}]) add(`malformed:${JSON.stringify(response_format)}`,{vendor:{openai:{response_format}}});
for (const antigravity of [{contents:[],tools:null,generationConfig:{topP:0.5},extra:1},{'10':'ten','2':'two',newKey:1},'abc',['x',{'n':1}],1,true,null,JSON.parse('{"__proto__":{"x":1},"constructor":2}')]) add(`vendor:${JSON.stringify(antigravity)}`,{temperature:1,tools:[tool],vendor:{antigravity}});
add('description:nonempty', {tools:[{...tool,description:'d'}]});
add('description:mixed', {tools:[{...tool,description:'d'}, {...tool,name:'absent'}, {...tool,name:'empty',description:''}]});
add('duplicate-call-id:last-wins', {messages:[{role:'assistant',content:[{...call,id:'i',name:'a'},{...call,id:'i',name:'b'}]},{role:'user',content:[{...result,toolUseId:'i'}]}]});
add('file:application/x-yaml', {messages:[{role:'user',content:[{...result,files:[{type:'file',mediaType:'application/x-yaml',data:'aGVsbG8='}]}]}]});
console.log(JSON.stringify(rows));
