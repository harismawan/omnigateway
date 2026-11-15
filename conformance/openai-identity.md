# Step 4 item 1: identity checkpoint

`openai/identity.rs` borrows credential JSON and retains only validated strings.
It accepts any UUID-shaped installation id (including uppercase/non-v4), and
only 64 lowercase hex characters for idSalt, matching the frozen reader.
Missing/malformed fields are independently backfilled. Existing values avoid
calling the corresponding generator. Production randomness uses existing rand;
the real-TS comparison injects deterministic generators on both sides.
Credential persistence/connect/refresh wiring is deferred to its roadmap item.

Hash primitives reuse existing `omni_crypto::codex`; no dependency added.
Stable API cache-key behavior remains covered by the prior 247-request corpus;
OAuth salted cache selection and lite history identities await item 2.

| Category | Rows | Compared |
|---|---:|---|
| Hashes/IDs |96|8 seeds ×3 salt choices ×4 instants; keyed/v4/v7/thread/prefix/threadInstant/isUuid|
| Stored secrets |16|read and backfill; absent/partial/complete, scalar/array/object/bad length/case/newline/nested malformed fields|
| Random generator |1 test|UUID version/variant, salt length, successive values differ, stored values preserved without generator calls|

First RED: missing identity module (`s4-identity-red.log`). First executing
comparison failed at hash 0 instant because serde Number float/integer equality
differs; fixed the test to compare f64 instants (same exact integer value).
That intermediate log was overwritten by the successful run. No hash primitive
production correction was needed for these rows.

Mutation: remove installation-id UUID validation; real TS comparison fails at
stored row 9 (empty string retained instead of absent),
`s4-identity-mutation.log`. Restored run: 2 tests pass,
`s4-identity-green.log`. No depth mutation claimed for this item: JSON is
borrowed through two root lookups, never cloned/held/replaced/dropped, and only
strings pass into the owned Secrets. Arbitrary nested values remain owned by
the caller. Item 3's OAuth/lite carriers have not yet been audited.

Three source tripwires pass in `s4-tests.log`. Two justified json_writes entries
are fixed UUID byte-array writes; no public JSON API/reexport was introduced.
Full three-crate test run passed; clippy and fmt passed in s4-clippy.log and
s4-fmt.log. All logs are under `/tmp/opencode/b3/`.

Frozen literal disposition remains 4 ported +66 named differential +51 later;
this checkpoint does not count a fingerprint declaration as fully covered until
its OAuth codec assertions run.
