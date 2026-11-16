# Status quota JSON regression corpus

Seven affinity-free quota columns × 13 values × JSON/human status = 182 pairs.
Values cover empty/two-byte/non-UTF8 BLOB, INTEGER, REAL (including negative
zero, 1.5, 1e308 and both infinities), numeric/empty/non-ASCII TEXT, and NULL.
No output/state normalization or masks are applied. The 45 accepted human-quota
differences are pinned by exact column/value identity; the other 46 human rows
must match. All 91 JSON rows must match, and all rows require unchanged typed DB
state, exact streams/exit, histogram agreement, and decoded-stderr panic checks.

Red at 54d73636 (binary SHA256
3d6a26560244dcefa892165e2b885608e69048e0bc7825a427442fe5098102ea):
116 equal, 45 accepted human-quota, 21 JSON BLOB failures; exit 1.
Corpus committed as 1f762a80 before implementation.

Green after a3b7c153: 137 equal, 45 accepted human-quota, zero failures; exit 0.
The implementation adds a CLI JSON-only Cell projection; the existing human
projection and shared typed sql_value are unchanged. Full execution evidence
and final gates are recorded outside the repository in /tmp/opencode/cli-fix6/.

## R6 identity join regression

Added seven identity fixtures × JSON/human status (14 pairs): identical BLOB
X'71'/X''/X'0102', INTEGER 1 versus TEXT '1', REAL 1.0 versus INTEGER 1,
NULL/NULL, TEXT 'q'/'q'. Credentials are affinity-free too. Total 196 pairs,
all frozen exit0. The seven human rows must match; no new accepted identities.
Red against eabedf83: 148 equal, 45 human-quota, 3 JSON identity failures.
The separate SQLite BLOB reads are distinct Uint8Array Map keys, not structural
indexed-object keys. Scalar Map keys retain SameValueZero semantics.
