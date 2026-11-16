import {toAntigravityWire} from '../../../packages/providers/src/antigravity/wire.ts';
const schemas:any[]=[{}, {const:'a'}, {const:1}, {const:'a',enum:['b']}, [1], 'x', [], '', 1, true, [[1]], '🙂', null];
if (process.argv.includes('--depth')) {
  let schema:any={type:'string'};
  for(let i=0;i<40000;i++)schema={items:schema};
  const r=toAntigravityWire({model:'m',stream:true,messages:[],tools:[{kind:'portable',name:'tool',inputSchema:schema}]} as any,'m',{project:'p',requestId:'r'});
  console.log(JSON.stringify({schema:(r.body.request.tools![0]!.functionDeclarations[0] as any).parameters,notes:r.degradations}));
  process.exit(0);
}
const values:any[]=[null,true,false,0,1.5,-1,'','1','1e3',' 1 ','0x10','string','ARRAY','null','bad',[],['string','null'],['string','number'],['x',1],{}, {type:'string'}];
for(const key of ['type','items','properties','anyOf','allOf','additionalProperties','format','title','description','pattern','enum','required','propertyOrdering','minItems','maxItems','minLength','maxLength','minProperties','maxProperties','minimum','maximum','default','example','nullable','$ref','unknown']) for(const value of values) schemas.push({[key]:value});
for(const type of [undefined,'object','array','ARRAY','string']) for(const key of ['properties','items','required','propertyOrdering']) schemas.push({...type===undefined?{}:{type},[key]:key==='properties'?{'':{},a:{type:'string'},bad:false}:key==='items'?{type:'string'}:['a','missing']});
for(const depth of [23,24,25,40]) {let s:any={type:'string'};for(let i=0;i<depth;i++)s={items:s};schemas.push(s);}
for (const key of ['properties','items','anyOf','allOf','additionalProperties']) for (const value of ['x',[[1]]]) schemas.push({[key]:value});
console.log(JSON.stringify(schemas.map(schema=>{const request:any={model:'m',stream:true,messages:[],tools:[{kind:'portable',name:'tool',inputSchema:schema}]};try {const r=toAntigravityWire(request,'m',{project:'p',requestId:'r'});return {schema,expected:JSON.stringify(r.body.request.tools![0]!.functionDeclarations[0]),notes:r.degradations};} catch(e) {if (!(e instanceof TypeError)) throw e; return {schema,error:String(e)};}})));
