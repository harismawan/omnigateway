import {anthropicOAuthFlow} from '../../../packages/providers/src/anthropic/oauth.ts';
const payloads=['{"access_token":"a\\ud800","refresh_token":123,"account":{"email_address":false}}','{"access_token":"a","refresh_token":"\\udfff","account":{"email_address":"x\\ud800"}}','{"access_token":"a","extra":"\\ud800","refresh_token":null}'];
const out=[];
for(const body of payloads){const step=anthropicOAuthFlow.refresh({refreshToken:'old',providerData:{},now:()=>1000,fail:(c,m)=>{throw Error(c+':'+m)}} as any);await step.next();const result=(await step.next({status:200,headers:new Headers(),body})).value as any;out.push({body,access:[...result.secrets.accessToken].flatMap(c=>Array.from({length:c.length},(_,i)=>c.charCodeAt(i))),refresh:JSON.stringify(result.secrets.refreshToken),email:JSON.stringify(result.accountEmail)});}
console.log(JSON.stringify(out));
