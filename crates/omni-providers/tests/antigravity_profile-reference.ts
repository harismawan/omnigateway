import { antigravityCodec } from '../../../packages/providers/src/antigravity/codec.ts';
// Mutating after import must not change the captured identity.
process.env.OMNI_UA_ANTIGRAVITY = 'changed-after-import';
process.env.OMNI_ANTIGRAVITY_IDE_VERSION = 'changed-after-import';
process.env.OMNI_ORDER_ANTIGRAVITY = 'Accept';
const result = antigravityCodec.buildRequest({request:{model:'m',stream:false,messages:[]},model:'m',credentials:{accessToken:'token',providerData:{projectId:'project'}},fail:(code,message)=>new Error(`${code}:${message}`)} as any);
console.log(JSON.stringify(result.request.headers));
