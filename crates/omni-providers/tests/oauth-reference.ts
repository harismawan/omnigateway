import { anthropicOAuthFlow as flow } from '../../../packages/providers/src/anthropic/oauth.ts';
import { GatewayError } from '../../../packages/ir/src/index.ts';
const helpers = { fail: (code: any, message: string) => new GatewayError(code, message), keepPolling: () => new GatewayError('AUTH','pending'), now: () => 1000, pkce: () => ({verifier:'v',challenge:'c'}), randomState: () => 's' };
const pending = {verifier:'v',challenge:'c',state:'s',redirectUri:'r'};
const rows = [];
for (const code of [' auth-code #s', 'a"\\\n#s', '😀#s', '#s', 'c#s#ignored']) {
  const step = flow.exchange({...helpers,code,pending});
  rows.push({code, request: (await step.next()).value});
}
const refresh = (await flow.refresh({...helpers, refreshToken:'old', providerData:{}}).next()).value;
const start = (await flow.start({...helpers,redirectUri:'ignored'}).next()).value;
console.log(JSON.stringify({rows,refresh,start}));
