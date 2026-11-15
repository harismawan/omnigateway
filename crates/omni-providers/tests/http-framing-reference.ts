// Execute the frozen private predicate without editing or duplicating it.
const source = await Bun.file(new URL('../../../packages/providers/src/codecAdapter.ts', import.meta.url)).text();
const start = source.indexOf('function framingAgrees(');
const end = source.indexOf('\nfunction boundedDegradations', start);
if (start < 0 || end < 0) throw new Error('frozen predicate boundaries changed');
const js = new Bun.Transpiler({loader:'ts'}).transformSync(source.slice(start,end));
const check = new Function(`${js}; return framingAgrees;`)();
console.log(JSON.stringify(['\u0085','\ufeff','\u00a0','\u2028','\t',' '].map(space => {
 const value = `${space}zstd${space}`;
 return {value,accepted:check([['content-encoding',value]],'x','zstd')};
})));
