# C3: accepted fixture-specific physical encoding boundary

Controller accepted the measured Bun SQLite 3.53.4 / bundled SQLite 3.54.1
difference for the valid-log restore fixture. Both expose cost `0.0`, type
`real`. Only the physical final zero in the one-cell `usage_rollup` record
differs: serial type 8 (compact integer zero) versus 7 (eight-byte REAL zero),
payload length 12 versus 20, and the resulting eight-byte movement of the cell
and its content-start/cell pointer. This is not permission for other byte
differences, different SQL values/types, or a product SQL change.

Run outside the pinned matrix:

```sh
python3 conformance/cli/db-restore-zero-evidence.py /tmp/opencode/db-review/r5
```

The preserved reviewer fixture is reproduced by `ONLY=valid-log python3
columns.py` in that evidence directory. It contains the original inputs,
whole-root captures taken before inspection, and final database copies.
The assertion checks ordinary stream parity (existing timestamp substitution),
candidate/undo/other-file equality, all SQL values/types, both runtimes opening
both results with integrity checks, no read-induced mutation, and the complete
23-byte structural difference support. Page number, page size, leaf header,
cell counts, cell pointers and exact records are asserted, not unexplained
offset masks. SQLite header bytes 96–99 retain the existing writer-version
exception only. A changed fixture/runtime must fail and be reviewed afresh.
No general database normalization or pinned capture mask was added.

Round-4 evidence: `/tmp/opencode/e1-e5/db20-c3.log`. Retained reviewer inputs
are intentionally external evidence, not a portable or automatically generated
pinned matrix fixture.
