import {applyAnthropicSystem,signAnthropicBody} from '../../../packages/providers/src/body.ts';
import {buildToolCloak} from '../../../packages/providers/src/anthropic/cloak.ts';
const rows=[];
for(const names of [[],['read_file','ReadFile','read-file','mcp__server__tool'],['!!!','a'.repeat(140),'delegate_task','é'],['foo_bar','foo-bar','FooBar']]) {
 for(const text of ['hello','You are OpenCode\n\nkeep me\n\nif OpenCode honestly','github.com/cline/cline\n\nHere is some useful information about the environment you are running in:','😀😀😀😀😀😀😀😀😀😀😀']) {
 const request={model:'m',stream:true,messages:[{role:'assistant',content:names.map(name=>({type:'toolUse',id:'t',name,input:{}}))}],tools:names.map(name=>({kind:'portable',name,inputSchema:{}})),toolChoice:{type:'tool',name:'history_only'}} as any;
 const cloak=buildToolCloak(request);
 const system=[{type:'text',text,cache_control:{type:'ephemeral',ttl:'1h'}}] as any;
 const applied=applyAnthropicSystem(system,text);
 const body=signAnthropicBody(JSON.stringify({messages:[{text:'cch=00000;'}],system:applied}));
 rows.push({request,system,text,cloak:cloak?[...cloak.toWire]:[],applied,body});
 }
}
console.log(JSON.stringify(rows));
