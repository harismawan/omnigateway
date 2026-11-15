import {antigravityCodec} from '../../../packages/providers/src/antigravity/codec.ts';
const rows:any[]=[];
for(const project of [undefined,1,null,{},[], '', ' \t\ufeff ', ' project ', 'p']) for(const token of [null,'','token']) for(const requestId of [undefined,'','explicit',' ']) {
  const request:any={model:'m',stream:true,messages:[],tools:[{kind:'portable',name:'read file',inputSchema:{}}]};
  const input:any={request,model:'gemini-3.6-flash-high',credentials:{accessToken:token,apiKey:null,providerData:{projectId:project}},requestId,fail:(code:string,message:string)=>({code,message})};
  try { const r=antigravityCodec.buildRequest(input); rows.push({project,token,requestId,request,expected:{request:r.request,degradations:r.degradations,cloakedTools:r.cloakedTools}}); }
  catch(e) {rows.push({project,token,requestId,request,error:e});}
}
console.log(JSON.stringify(rows));
