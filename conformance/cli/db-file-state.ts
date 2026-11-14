import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";

// lstat avoids following candidate/body symlinks, including self-links.
function tree(path: string): unknown {
 try {
  const stat=lstatSync(path);
  if(stat.isSymbolicLink())return {link:readlinkSync(path)};
  if(stat.isDirectory())return readdirSync(path).sort().map(name=>[name,tree(join(path,name))]);
  return readFileSync(path);
 } catch(error:any) {if(error.code==="ENOENT")return null;throw error;}
}
export function fileState(root: string, bodies=false) {
 return {live:["","-wal","-shm"].map(s=>tree(join(root,"db"+s))),snapshots:tree(join(root,"snapshots")),...(bodies?{bodies:tree(join(root,"request_bodies"))}:{})};
}
// Only SQLite's writer-version field in the live database header is masked.
export function frozenPostState(root: string, bodies=false) {
 const state=fileState(root,bodies);
 const db=state.live[0];
 if(Buffer.isBuffer(db)&&db.length>=100)db.fill(0,96,100);
 return state;
}
