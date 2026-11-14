# Lite assembly sub-checkpoint (item 2 incomplete)

Crate-private lite::to_lite mirrors frozen codexLite.ts:103–252. It is not yet
called by an OAuth request builder. Positional turn/provenance vectors replace
WeakMap/WeakSet; wire integration must populate them while assembling items,
including orphan repair and mixed tool-result media. Do not infer them from
final roles alone. codexTurn/header metadata and catalog selection remain pending.

24 real-TS rows = lite/non-lite × salted+explicit time/request vs unsalted+
derived defaults × empty/full/truncated history × prefixes+effort vs none.
Full history contains user text/image, assistant output annotations, function
call/output, native reasoning with untrusted passthrough, file media tagged as
tool provenance, and unknown native item. Prefixes include function schema and
Unicode instructions. Comparisons use exact jsjson strings including key order.
These are helper comparisons, not whole OAuth codec or ingress comparisons.

First RED missing module: s4-lite-red.log. Intermediate build fixed incorrect
js::to_string call; first executing test fixed expected row count 48 to 24.
No production byte mismatch observed for these rows after compilation.
Scratch mutation suppressing lite base-instruction provenance fails row 13
(s4-lite-mutation.log); restored 1 test passes (s4-lite-green.log).

Ownership by inspection: argument owner releases input/tools iteratively;
output is deep::Owned; all intermediate JSON lives in deep::scope; replacement
uses deep::insert; reasoning removes client metadata with iterative drop.
No 40k depth/mutation claim yet; these carriers must enter item 3's audit.
One tripwire exception is Vec::insert shifting elements without replacing or
dropping them inside the deep scope. No public API or IR type changed.

Three-crate tests pass (49 summaries, 222 passed, 4 ignored including child
summaries); clippy all targets, fmt, tripwires and offline gateway build pass.
Logs /tmp/opencode/b3/s4-lite-{tests,clippy,fmt,build}.log. Inventory unchanged:
all 51 later declarations await complete OAuth assertions.
