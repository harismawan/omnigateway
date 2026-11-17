import { openDb } from "../../packages/store/src/sqlite/db.ts";
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createBodyRepo } from "../../packages/store/src/sqlite/bodies.ts";
import { deriveKey } from "../../packages/store/src/encryption.ts";
const input = JSON.parse(await Bun.stdin.text());
const root = mkdtempSync("/tmp/opencode/a3/s2-sqlite-");
const dir = join(root,"request_bodies");
const db = openDb(join(root,"omni.db"));
const key = await deriveKey("s2-sqlite");
const repo = createBodyRepo(db,key,dir);
const out: unknown[] = [];
for (const op of input) {
  if(op.op === "put") { try { await repo.put(JSON.parse(op.json)); out.push("ok"); } catch { out.push("error"); } }
  else if(op.op === "get") {
    const read = await repo.get(op.id);
    out.push(read === null ? null : {state:read.row.detailState,truncated:read.row.truncated,artifact:read.artifact === null ? null : JSON.stringify(read.artifact)});
  } else if(op.op === "rows") {
    const rows = db.query("SELECT *,typeof(request_id) ti,typeof(at) ta,typeof(rel_path) tp,typeof(size_bytes) tb,typeof(sha256) th,typeof(detail_state) td,typeof(truncated) tt FROM request_bodies ORDER BY request_id").all() as any[];
    out.push(await Promise.all(rows.map(async r => {
      const bytes=readFileSync(join(dir,r.rel_path));
      const plaintext=Buffer.from(await crypto.subtle.decrypt({name:"AES-GCM",iv:bytes.subarray(10,22),additionalData:bytes.subarray(0,10),tagLength:128},key,bytes.subarray(22))).toString("utf8");
      const digest=Buffer.from(await crypto.subtle.digest("SHA-256",bytes)).toString("hex");
      return {...r,sha256:digest===r.sha256,plaintext};
    })));
  } else if(op.op === "missing" || op.op === "corrupt" || op.op === "restore") {
    const row = db.query("SELECT rel_path FROM request_bodies WHERE request_id=?").get(op.id) as any;
    const path=join(dir,row.rel_path);
    if(op.op === "missing") { writeFileSync(path+".backup",readFileSync(path)); unlinkSync(path); }
    else if(op.op === "corrupt") { writeFileSync(path+".backup",readFileSync(path)); writeFileSync(path,"bad"); }
    else { writeFileSync(path,readFileSync(path+".backup")); unlinkSync(path+".backup"); }
  } else if(op.op === "prune") out.push(await repo.prune(op.at));
  else if(op.op === "cap") out.push(await repo.pruneToCap(op.cap));
  else if(op.op === "sweep") out.push(await repo.sweepOrphans());
  else if(op.op === "none") db.run("UPDATE request_bodies SET detail_state='alien' WHERE request_id=?",[op.id]);
}
db.close();
console.log(JSON.stringify(out));
