import {antigravityCodec} from '../../../packages/providers/src/antigravity/codec.ts';
const base:any={model:'m',stream:true,messages:[]};
const cases:any[]=[
 ['vendor',{...base,vendor:{antigravity:'🙂'}},'p','r'],
 ['name',{...base,tools:[{kind:'portable',name:'\ud800',inputSchema:{}}]},'p','r'],
 ['id',{...base,messages:[{role:'assistant',content:[{type:'toolUse',id:'\ud800',name:'t',input:{}}]}]},'p','r'],
 ['value',{...base,messages:[{role:'assistant',content:[{type:'toolUse',id:'i',name:'t',input:{x:'\ud800'}}]}]},'p','r'],
 ['key',{...base,messages:[{role:'assistant',content:[{type:'toolUse',id:'i',name:'t',input:{'\ud800':1}}]}]},'p','r'],
 ['system',{...base,system:[{type:'text',text:'\ud800'}]},'p','r'],
 ['project',base,'\ud800',undefined],
 ['request_id',base,'p','\ud800'],
];
console.log(JSON.stringify(cases.map(([label,request,project,requestId])=>({label,input:JSON.stringify({request,project,requestId}),expected:antigravityCodec.buildRequest({request,model:'m',credentials:{accessToken:'t',apiKey:null,providerData:{projectId:project}},requestId,fail:(code:any,message:any)=>({code,message})} as any).request.body}))));
