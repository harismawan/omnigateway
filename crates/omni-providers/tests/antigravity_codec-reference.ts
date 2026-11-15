import {antigravityCodec} from '../../../packages/providers/src/antigravity/codec.ts';
const rows:any[]=[];
for(const project of [undefined,1,null,{},[], '', ' \t\ufeff ', ' project ', 'p']) for(const token of [null,'','token']) for(const requestId of [undefined,'','explicit',' ']) {
  const request:any={model:'m',stream:true,messages:[],tools:[{kind:'portable',name:'read file',inputSchema:{}}]};
  const input:any={request,model:'gemini-3.6-flash-high',credentials:{accessToken:token,apiKey:null,providerData:{projectId:project}},requestId,fail:(code:string,message:string)=>({code,message})};
  try { const r=antigravityCodec.buildRequest(input); rows.push({project,token,requestId,request,expected:{request:r.request,degradations:r.degradations,cloakedTools:r.cloakedTools}}); }
  catch(e) {rows.push({project,token,requestId,request,error:e});}
}
for (const schema of [null, [1], 'x', [], '', 1, true, [[1]], '🙂']) {
  const request:any={model:'m',stream:true,messages:[],tools:[{kind:'portable',name:'read file',inputSchema:schema}]};
  const input:any={request,model:'gemini-3.6-flash-high',credentials:{accessToken:'token',apiKey:null,providerData:{projectId:'p'}},requestId:'r',fail:(code:string,message:string)=>({code,message})};
  try { const r=antigravityCodec.buildRequest(input); rows.push({project:'p',token:'token',requestId:'r',request,expected:{request:r.request,degradations:r.degradations,cloakedTools:r.cloakedTools}}); }
  catch(e) { if (!(e instanceof TypeError)) throw e; rows.push({project:'p',token:'token',requestId:'r',request,rawThrow:String(e),error:{code:'UPSTREAM',message:'antigravity codec buildRequest threw'}}); }
}
console.log(JSON.stringify(rows));
