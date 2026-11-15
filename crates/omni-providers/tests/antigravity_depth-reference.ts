import {toAntigravityWire} from '../../../packages/providers/src/antigravity/wire.ts';
let nested:any=null;
for(let i=0;i<40000;i++) nested={items:nested};
const rows=[];
for(const kind of ['input','schema','vendor']) {
  const request:any={model:'m',messages:[],stream:true};
  if(kind==='input') request.messages=[{role:'assistant',content:[{type:'toolUse',id:'i',name:'tool',input:nested}]}];
  if(kind==='schema') request.vendor={openai:{response_format:{type:'json_schema',json_schema:{schema:nested}}}};
  if(kind==='vendor') request.vendor={antigravity:{extra:nested}};
  try { const r=toAntigravityWire(request,'m',{project:'p',requestId:'r'}); rows.push({kind,body:JSON.stringify(r.body),notes:r.degradations}); }
  catch(e) { rows.push({kind,error:String(e)}); }
}
console.log(JSON.stringify(rows));
