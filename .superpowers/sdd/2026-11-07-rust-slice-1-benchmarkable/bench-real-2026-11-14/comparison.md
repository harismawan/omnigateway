Largest start-of-run load: base 0.93; head 1
Base SHA256: `f9cc6678a7d2bc2300a71b3aae98caff1aaedbcb2d811baee3dffd4325009d63`
Head SHA256: `988a4b5c099bca7e5b208ece83f4e9047f1570f866b867113f0f18b79db5fb10`
Effective base environment: {"OMNI_BENCH_TLS_KEY":"<set>","OMNI_RUST_BINARY":"/tmp/opencode/bench-gate/bin/main-327f240f","OMNI_BENCH_CERT":"/tmp/opencode/omni-bench-EadaMr/OMNI_BENCH_CERT","OMNI_ENCRYPTION_KEY":"<set>","OMNI_DB_PATH":"/tmp/opencode/omni-bench-EadaMr/omni.db","OMNI_HOST":"127.0.0.1","OMNI_PORT":"18200","OMNI_ROOT":"/tmp/opencode/omni-bench-EadaMr","OMNI_STATIC_DIR":"/tmp/opencode/omni-bench-EadaMr/no-dashboard","OMNI_LOG_LEVEL":"warn","OMNI_BENCH":"1"}
Effective head environment: {"OMNI_BENCH":"1","OMNI_BENCH_TLS_KEY":"<set>","OMNI_STATIC_DIR":"/tmp/opencode/omni-bench-1cvYPD/no-dashboard","OMNI_HOST":"127.0.0.1","OMNI_RUST_BINARY":"/tmp/opencode/bench-gate/bin/main-327f240f","OMNI_ENCRYPTION_KEY":"<set>","OMNI_PORT":"18200","MIMALLOC_PURGE_DELAY":"1","OMNI_BENCH_CERT":"/tmp/opencode/omni-bench-1cvYPD/OMNI_BENCH_CERT","OMNI_ROOT":"/tmp/opencode/omni-bench-1cvYPD","OMNI_LOG_LEVEL":"warn","OMNI_DB_PATH":"/tmp/opencode/omni-bench-1cvYPD/omni.db"}
Rust's production launcher defaults MIMALLOC_PURGE_DELAY=1; this is not an allocator-neutral comparison.
CPU covers the gateway process and its threads only (children excluded). Memory is resident memory sampled every 100 ms.
One process serves all scenarios; later scenarios include earlier process and database history.
The load interval ends at oha's report file, with a 250 ms tolerance.
Verifier requests are extra gateway work, not counted in the request rate.
Measured traffic integrity uses status, usage, per-request size and a sampling full-body verifier; this is not a proof that every response was correct.
All rounds have the same ordered scenario selection.
### environment differences between sides
| variable | base | head |
|---|---|---|
| MIMALLOC_PURGE_DELAY | <unset> | 1 |

Values: successful/total rounds; median [min–max]. Ratios are head/base. Range overlap is descriptive, not a significance test. Directional labels require at least three successful observations per side. RSS is per-scenario peak resident memory.

Verifier counts by round (started/completed/skipped ticks/violations):
base round 1: custom-chat.chat.json=41/41/0/0, custom-chat.chat.stream=41/41/0/0, custom-chat.messages.json=41/41/0/0, custom-chat.messages.stream=41/41/0/0, custom-chat.responses.json=41/41/0/0, custom-chat.responses.stream=41/41/0/0, custom-chat.overhead-c1=41/41/0/0, custom-chat.chunks-2000=41/41/0/0, custom-responses.chat.json=41/41/0/0, custom-responses.chat.stream=41/41/0/0, custom-responses.messages.json=41/41/0/0, custom-responses.messages.stream=41/41/0/0, custom-responses.responses.json=41/41/0/0, custom-responses.responses.stream=41/41/0/0, custom-responses.overhead-c1=40/40/0/0, custom-responses.chunks-2000=41/41/0/0, anthropic-key.chat.json=41/41/0/0, anthropic-key.chat.stream=41/41/0/0, anthropic-key.messages.json=41/41/0/0, anthropic-key.messages.stream=41/41/0/0, anthropic-key.responses.json=41/41/0/0, anthropic-key.responses.stream=41/41/0/0, anthropic-key.overhead-c1=40/40/0/0, anthropic-key.chunks-2000=41/41/0/0, anthropic-oauth.chat.json=41/41/0/0, anthropic-oauth.chat.stream=41/41/0/0, anthropic-oauth.messages.json=41/41/0/0, anthropic-oauth.messages.stream=41/41/0/0, anthropic-oauth.responses.json=41/41/0/0, anthropic-oauth.responses.stream=41/41/0/0, anthropic-oauth.overhead-c1=40/40/0/0, anthropic-oauth.chunks-2000=41/41/0/0
base round 2: custom-chat.chat.json=41/41/0/0, custom-chat.chat.stream=41/41/0/0, custom-chat.messages.json=41/41/0/0, custom-chat.messages.stream=41/41/0/0, custom-chat.responses.json=41/41/0/0, custom-chat.responses.stream=41/41/0/0, custom-chat.overhead-c1=40/40/0/0, custom-chat.chunks-2000=41/41/0/0, custom-responses.chat.json=41/41/0/0, custom-responses.chat.stream=41/41/0/0, custom-responses.messages.json=41/41/0/0, custom-responses.messages.stream=41/41/0/0, custom-responses.responses.json=41/41/0/0, custom-responses.responses.stream=41/41/0/0, custom-responses.overhead-c1=40/40/0/0, custom-responses.chunks-2000=41/41/0/0, anthropic-key.chat.json=41/41/0/0, anthropic-key.chat.stream=41/41/0/0, anthropic-key.messages.json=41/41/0/0, anthropic-key.messages.stream=41/41/0/0, anthropic-key.responses.json=41/41/0/0, anthropic-key.responses.stream=41/41/0/0, anthropic-key.overhead-c1=40/40/0/0, anthropic-key.chunks-2000=41/41/0/0, anthropic-oauth.chat.json=41/41/0/0, anthropic-oauth.chat.stream=41/41/0/0, anthropic-oauth.messages.json=41/41/0/0, anthropic-oauth.messages.stream=41/41/0/0, anthropic-oauth.responses.json=41/41/0/0, anthropic-oauth.responses.stream=41/41/0/0, anthropic-oauth.overhead-c1=21/21/21/0, anthropic-oauth.chunks-2000=41/41/0/0
base round 3: custom-chat.chat.json=41/41/0/0, custom-chat.chat.stream=41/41/0/0, custom-chat.messages.json=29/29/12/0, custom-chat.messages.stream=36/36/5/0, custom-chat.responses.json=41/41/0/0, custom-chat.responses.stream=9/9/33/0, custom-chat.overhead-c1=39/39/2/0, custom-chat.chunks-2000=41/41/0/0, custom-responses.chat.json=32/32/12/0, custom-responses.chat.stream=12/12/30/0, custom-responses.messages.json=38/38/3/0, custom-responses.messages.stream=41/41/0/0, custom-responses.responses.json=41/41/0/0, custom-responses.responses.stream=20/20/25/0, custom-responses.overhead-c1=26/26/15/0, custom-responses.chunks-2000=41/41/0/0, anthropic-key.chat.json=41/41/0/0, anthropic-key.chat.stream=9/9/32/0, anthropic-key.messages.json=33/33/8/0, anthropic-key.messages.stream=40/40/5/0, anthropic-key.responses.json=12/12/29/0, anthropic-key.responses.stream=32/32/9/0, anthropic-key.overhead-c1=40/40/0/0, anthropic-key.chunks-2000=41/41/0/0, anthropic-oauth.chat.json=41/41/0/0, anthropic-oauth.chat.stream=36/36/9/0, anthropic-oauth.messages.json=15/15/28/0, anthropic-oauth.messages.stream=38/38/3/0, anthropic-oauth.responses.json=21/21/22/0, anthropic-oauth.responses.stream=15/15/27/0, anthropic-oauth.overhead-c1=39/39/2/0, anthropic-oauth.chunks-2000=41/41/0/0
head round 1: custom-chat.chat.json=41/41/0/0, custom-chat.chat.stream=41/41/0/0, custom-chat.messages.json=41/41/0/0, custom-chat.messages.stream=41/41/0/0, custom-chat.responses.json=41/41/0/0, custom-chat.responses.stream=41/41/0/0, custom-chat.overhead-c1=41/41/0/0, custom-chat.chunks-2000=40/40/0/0, custom-responses.chat.json=41/41/0/0, custom-responses.chat.stream=41/41/0/0, custom-responses.messages.json=41/41/0/0, custom-responses.messages.stream=41/41/0/0, custom-responses.responses.json=41/41/0/0, custom-responses.responses.stream=41/41/0/0, custom-responses.overhead-c1=40/40/0/0, custom-responses.chunks-2000=40/40/0/0, anthropic-key.chat.json=41/41/0/0, anthropic-key.chat.stream=40/40/1/0, anthropic-key.messages.json=41/41/0/0, anthropic-key.messages.stream=41/41/0/0, anthropic-key.responses.json=41/41/0/0, anthropic-key.responses.stream=41/41/0/0, anthropic-key.overhead-c1=40/40/0/0, anthropic-key.chunks-2000=40/40/0/0, anthropic-oauth.chat.json=41/41/0/0, anthropic-oauth.chat.stream=41/41/0/0, anthropic-oauth.messages.json=41/41/0/0, anthropic-oauth.messages.stream=40/40/1/0, anthropic-oauth.responses.json=40/40/1/0, anthropic-oauth.responses.stream=40/40/1/0, anthropic-oauth.overhead-c1=40/40/0/0, anthropic-oauth.chunks-2000=41/41/0/0
head round 2: custom-chat.chat.json=41/41/0/0, custom-chat.chat.stream=41/41/0/0, custom-chat.messages.json=41/41/0/0, custom-chat.messages.stream=41/41/0/0, custom-chat.responses.json=41/41/0/0, custom-chat.responses.stream=41/41/0/0, custom-chat.overhead-c1=41/41/0/0, custom-chat.chunks-2000=40/40/0/0, custom-responses.chat.json=41/41/0/0, custom-responses.chat.stream=41/41/0/0, custom-responses.messages.json=41/41/0/0, custom-responses.messages.stream=41/41/0/0, custom-responses.responses.json=41/41/0/0, custom-responses.responses.stream=41/41/0/0, custom-responses.overhead-c1=40/40/0/0, custom-responses.chunks-2000=40/40/0/0, anthropic-key.chat.json=41/41/0/0, anthropic-key.chat.stream=41/41/0/0, anthropic-key.messages.json=41/41/0/0, anthropic-key.messages.stream=41/41/0/0, anthropic-key.responses.json=41/41/0/0, anthropic-key.responses.stream=41/41/0/0, anthropic-key.overhead-c1=40/40/0/0, anthropic-key.chunks-2000=40/40/0/0, anthropic-oauth.chat.json=41/41/0/0, anthropic-oauth.chat.stream=41/41/0/0, anthropic-oauth.messages.json=41/41/0/0, anthropic-oauth.messages.stream=41/41/0/0, anthropic-oauth.responses.json=41/41/0/0, anthropic-oauth.responses.stream=40/40/1/0, anthropic-oauth.overhead-c1=41/41/0/0, anthropic-oauth.chunks-2000=40/40/0/0
head round 3: custom-chat.chat.json=41/41/0/0, custom-chat.chat.stream=41/41/0/0, custom-chat.messages.json=41/41/0/0, custom-chat.messages.stream=41/41/0/0, custom-chat.responses.json=41/41/0/0, custom-chat.responses.stream=41/41/0/0, custom-chat.overhead-c1=41/41/0/0, custom-chat.chunks-2000=40/40/0/0, custom-responses.chat.json=41/41/0/0, custom-responses.chat.stream=41/41/0/0, custom-responses.messages.json=41/41/0/0, custom-responses.messages.stream=41/41/0/0, custom-responses.responses.json=41/41/0/0, custom-responses.responses.stream=41/41/0/0, custom-responses.overhead-c1=40/40/0/0, custom-responses.chunks-2000=40/40/0/0, anthropic-key.chat.json=41/41/0/0, anthropic-key.chat.stream=41/41/0/0, anthropic-key.messages.json=41/41/0/0, anthropic-key.messages.stream=41/41/0/0, anthropic-key.responses.json=41/41/0/0, anthropic-key.responses.stream=41/41/0/0, anthropic-key.overhead-c1=40/40/0/0, anthropic-key.chunks-2000=41/41/0/0, anthropic-oauth.chat.json=41/41/0/0, anthropic-oauth.chat.stream=41/41/0/0, anthropic-oauth.messages.json=41/41/0/0, anthropic-oauth.messages.stream=41/41/0/0, anthropic-oauth.responses.json=41/41/0/0, anthropic-oauth.responses.stream=41/41/0/0, anthropic-oauth.overhead-c1=40/40/0/0, anthropic-oauth.chunks-2000=40/40/0/0
| metric | better | worse | inside spread |
|---|---:|---:|---:|
| req/s | 31 | 0 | 0 |
| p50 ms | 29 | 2 | 0 |
| p99 ms | 19 | 3 | 9 |
| CPU ms/req | 31 | 0 | 0 |
| CPU ms/req through row drain | 31 | 0 | 0 |
| RSS peak MiB | 22 | 0 | 9 |

### custom-chat
| scenario | metric | base | head | head/base |
|---|---|---|---|---|
| custom-chat.chat.json | req/s | 3/3; 1570.257 [1554.518–1578.776] | 2/3; failed; 55065.967 [54925.187–55206.747] | n/a |
| custom-chat.chat.json | p50 ms | 3/3; 39.437 [39.167–39.806] | 2/3; failed; 1.059 [1.053–1.065] | n/a |
| custom-chat.chat.json | p99 ms | 3/3; 61.813 [59.747–62.933] | 2/3; failed; 3.125 [3.017–3.234] | n/a |
| custom-chat.chat.json | CPU ms/req | 3/3; 0.507 [0.499–0.512] | 2/3; failed; 0.061 [0.061–0.061] | n/a |
| custom-chat.chat.json | CPU ms/req through row drain | 3/3; 0.507 [0.499–0.512] | 2/3; failed; 0.061 [0.061–0.061] | n/a |
| custom-chat.chat.json | RSS peak MiB | 3/3; 136.586 [133.398–137.805] | 2/3; failed; 49.068 [40.719–57.418] | n/a |
| custom-chat.chat.stream | req/s | 3/3; 1456.643 [1433.280–1474.922] | 3/3; 53821.147 [52906.125–55111.721] | 36.949 — better |
| custom-chat.chat.stream | p50 ms | 3/3; 43.124 [41.189–43.142] | 3/3; 1.078 [1.062–1.085] | 0.025 — better |
| custom-chat.chat.stream | p99 ms | 3/3; 77.149 [64.823–77.739] | 3/3; 3.440 [3.029–3.624] | 0.045 — better |
| custom-chat.chat.stream | CPU ms/req | 3/3; 0.498 [0.477–0.506] | 3/3; 0.061 [0.060–0.062] | 0.122 — better |
| custom-chat.chat.stream | CPU ms/req through row drain | 3/3; 0.498 [0.477–0.506] | 3/3; 0.061 [0.060–0.062] | 0.122 — better |
| custom-chat.chat.stream | RSS peak MiB | 3/3; 125.980 [122.273–126.531] | 3/3; 45.488 [42.613–108.914] | 0.361 — better |
| custom-chat.messages.json | req/s | 3/3; 1548.010 [948.805–1570.831] | 3/3; 55806.028 [54943.727–57300.863] | 36.050 — better |
| custom-chat.messages.json | p50 ms | 3/3; 39.791 [39.638–40.062] | 3/3; 1.041 [1.022–1.050] | 0.026 — better |
| custom-chat.messages.json | p99 ms | 3/3; 70.785 [62.589–820.184] | 3/3; 3.065 [2.994–3.337] | 0.043 — better |
| custom-chat.messages.json | CPU ms/req | 3/3; 0.446 [0.428–0.462] | 3/3; 0.060 [0.059–0.061] | 0.134 — better |
| custom-chat.messages.json | CPU ms/req through row drain | 3/3; 0.446 [0.428–0.462] | 3/3; 0.060 [0.059–0.061] | 0.134 — better |
| custom-chat.messages.json | RSS peak MiB | 3/3; 127.758 [126.047–130.938] | 3/3; 44.215 [43.016–51.871] | 0.346 — better |
| custom-chat.messages.stream | req/s | 3/3; 1403.664 [623.451–1429.794] | 3/3; 53871.253 [53137.153–54448.495] | 38.379 — better |
| custom-chat.messages.stream | p50 ms | 3/3; 44.761 [44.329–76.753] | 3/3; 1.082 [1.072–1.099] | 0.024 — better |
| custom-chat.messages.stream | p99 ms | 3/3; 76.613 [74.418–466.058] | 3/3; 3.172 [3.143–3.308] | 0.041 — better |
| custom-chat.messages.stream | CPU ms/req | 3/3; 0.489 [0.468–0.522] | 3/3; 0.061 [0.060–0.061] | 0.125 — better |
| custom-chat.messages.stream | CPU ms/req through row drain | 3/3; 0.489 [0.468–0.522] | 3/3; 0.061 [0.060–0.061] | 0.125 — better |
| custom-chat.messages.stream | RSS peak MiB | 3/3; 123.391 [118.113–126.531] | 3/3; 44.266 [43.637–45.258] | 0.359 — better |
| custom-chat.responses.json | req/s | 3/3; 1562.047 [1550.945–1578.462] | 3/3; 55893.863 [52822.546–56043.389] | 35.782 — better |
| custom-chat.responses.json | p50 ms | 3/3; 38.965 [38.936–40.756] | 3/3; 1.058 [1.043–1.103] | 0.027 — better |
| custom-chat.responses.json | p99 ms | 3/3; 64.999 [63.259–68.622] | 3/3; 3.001 [2.908–3.337] | 0.046 — better |
| custom-chat.responses.json | CPU ms/req | 3/3; 0.443 [0.421–0.460] | 3/3; 0.061 [0.061–0.064] | 0.139 — better |
| custom-chat.responses.json | CPU ms/req through row drain | 3/3; 0.443 [0.421–0.460] | 3/3; 0.061 [0.061–0.064] | 0.139 — better |
| custom-chat.responses.json | RSS peak MiB | 3/3; 125.039 [120.371–128.340] | 3/3; 44.219 [43.523–46.090] | 0.354 — better |
| custom-chat.responses.stream | req/s | 3/3; 1340.102 [74.236–1367.133] | 3/3; 50820.164 [50806.077–51232.569] | 37.923 — better |
| custom-chat.responses.stream | p50 ms | 3/3; 46.821 [45.281–835.735] | 3/3; 1.148 [1.139–1.148] | 0.025 — better |
| custom-chat.responses.stream | p99 ms | 3/3; 78.572 [77.601–1712.137] | 3/3; 3.324 [3.289–3.391] | 0.042 — better |
| custom-chat.responses.stream | CPU ms/req | 3/3; 0.551 [0.523–0.659] | 3/3; 0.065 [0.065–0.066] | 0.119 — better |
| custom-chat.responses.stream | CPU ms/req through row drain | 3/3; 0.551 [0.523–0.659] | 3/3; 0.065 [0.065–0.066] | 0.119 — better |
| custom-chat.responses.stream | RSS peak MiB | 3/3; 123.898 [122.547–127.402] | 3/3; 44.668 [44.160–44.879] | 0.361 — better |
| custom-chat.overhead-c1 | req/s | 3/3; 996.884 [214.529–1013.271] | 3/3; 10301.100 [10257.615–10477.106] | 10.333 — better |
| custom-chat.overhead-c1 | p50 ms | 3/3; 0.705 [0.692–0.739] | 3/3; 0.084 [0.083–0.085] | 0.120 — better |
| custom-chat.overhead-c1 | p99 ms | 3/3; 11.288 [11.149–180.783] | 3/3; 0.222 [0.221–0.226] | 0.020 — better |
| custom-chat.overhead-c1 | CPU ms/req | 3/3; 0.676 [0.653–0.786] | 3/3; 0.066 [0.064–0.067] | 0.098 — better |
| custom-chat.overhead-c1 | CPU ms/req through row drain | 3/3; 0.676 [0.653–0.786] | 3/3; 0.066 [0.065–0.067] | 0.098 — better |
| custom-chat.overhead-c1 | RSS peak MiB | 3/3; 112.254 [111.469–112.758] | 3/3; 40.555 [38.438–49.082] | 0.361 — better |
| custom-chat.chunks-2000 | req/s | 3/3; 146.042 [141.947–150.922] | 3/3; 2580.260 [2573.989–2596.680] | 17.668 — better |
| custom-chat.chunks-2000 | p50 ms | 3/3; 106.688 [105.385–109.134] | 3/3; 6.076 [6.071–6.090] | 0.057 — better |
| custom-chat.chunks-2000 | p99 ms | 3/3; 140.399 [136.822–224.139] | 3/3; 10.052 [9.842–10.174] | 0.072 — better |
| custom-chat.chunks-2000 | CPU ms/req | 3/3; 6.743 [6.732–6.875] | 3/3; 1.516 [1.509–1.517] | 0.225 — better |
| custom-chat.chunks-2000 | CPU ms/req through row drain | 3/3; 6.743 [6.732–6.875] | 3/3; 1.517 [1.509–1.517] | 0.225 — better |
| custom-chat.chunks-2000 | RSS peak MiB | 3/3; 159.531 [155.383–160.434] | 3/3; 33.855 [33.371–34.086] | 0.212 — better |

### custom-responses
| scenario | metric | base | head | head/base |
|---|---|---|---|---|
| custom-responses.chat.json | req/s | 3/3; 1482.540 [1012.649–1501.691] | 3/3; 16983.877 [16353.202–17518.325] | 11.456 — better |
| custom-responses.chat.json | p50 ms | 3/3; 42.291 [40.888–42.455] | 3/3; 1.774 [1.735–1.800] | 0.042 — better |
| custom-responses.chat.json | p99 ms | 3/3; 68.357 [62.527–943.201] | 3/3; 23.597 [23.402–24.545] | 0.345 — better |
| custom-responses.chat.json | CPU ms/req | 3/3; 0.469 [0.466–0.489] | 3/3; 0.218 [0.210–0.227] | 0.463 — better |
| custom-responses.chat.json | CPU ms/req through row drain | 3/3; 0.469 [0.466–0.489] | 3/3; 0.218 [0.210–0.227] | 0.463 — better |
| custom-responses.chat.json | RSS peak MiB | 3/3; 127.641 [123.070–130.203] | 3/3; 43.531 [42.980–43.871] | 0.341 — better |
| custom-responses.chat.stream | req/s | 3/3; 1370.551 [89.414–1392.518] | 3/3; 17245.417 [16205.784–17379.929] | 12.583 — better |
| custom-responses.chat.stream | p50 ms | 3/3; 45.900 [44.818–589.030] | 3/3; 1.903 [1.899–1.906] | 0.041 — better |
| custom-responses.chat.stream | p99 ms | 3/3; 80.039 [74.288–1330.383] | 3/3; 26.495 [24.011–26.594] | 0.331 — better |
| custom-responses.chat.stream | CPU ms/req | 3/3; 0.509 [0.500–0.603] | 3/3; 0.210 [0.209–0.225] | 0.412 — better |
| custom-responses.chat.stream | CPU ms/req through row drain | 3/3; 0.509 [0.500–0.603] | 3/3; 0.210 [0.209–0.225] | 0.413 — better |
| custom-responses.chat.stream | RSS peak MiB | 3/3; 125.375 [111.098–128.152] | 3/3; 42.594 [42.539–42.629] | 0.340 — better |
| custom-responses.messages.json | req/s | 3/3; 1491.816 [899.787–1506.558] | 3/3; 16420.288 [16380.213–17493.406] | 11.007 — better |
| custom-responses.messages.json | p50 ms | 3/3; 41.532 [41.328–50.992] | 3/3; 1.787 [1.758–1.792] | 0.043 — better |
| custom-responses.messages.json | p99 ms | 3/3; 73.016 [63.780–234.544] | 3/3; 24.369 [23.716–25.071] | 0.334 — better |
| custom-responses.messages.json | CPU ms/req | 3/3; 0.455 [0.454–0.500] | 3/3; 0.224 [0.210–0.227] | 0.493 — better |
| custom-responses.messages.json | CPU ms/req through row drain | 3/3; 0.455 [0.454–0.500] | 3/3; 0.224 [0.210–0.227] | 0.493 — better |
| custom-responses.messages.json | RSS peak MiB | 3/3; 123.301 [123.242–125.352] | 3/3; 42.078 [41.992–42.395] | 0.341 — better |
| custom-responses.messages.stream | req/s | 3/3; 1371.410 [1340.974–1376.834] | 3/3; 17283.624 [16340.032–17385.224] | 12.603 — better |
| custom-responses.messages.stream | p50 ms | 3/3; 45.729 [45.388–46.886] | 3/3; 1.875 [1.856–1.933] | 0.041 — better |
| custom-responses.messages.stream | p99 ms | 3/3; 78.985 [75.011–84.040] | 3/3; 24.964 [23.988–25.749] | 0.316 — better |
| custom-responses.messages.stream | CPU ms/req | 3/3; 0.500 [0.497–0.529] | 3/3; 0.211 [0.208–0.223] | 0.421 — better |
| custom-responses.messages.stream | CPU ms/req through row drain | 3/3; 0.500 [0.497–0.529] | 3/3; 0.211 [0.208–0.224] | 0.421 — better |
| custom-responses.messages.stream | RSS peak MiB | 3/3; 123.590 [122.973–128.930] | 3/3; 42.594 [41.477–42.668] | 0.345 — better |
| custom-responses.responses.json | req/s | 3/3; 1528.295 [1493.187–1539.523] | 3/3; 16524.862 [16087.867–17307.165] | 10.813 — better |
| custom-responses.responses.json | p50 ms | 3/3; 40.906 [40.170–42.233] | 3/3; 1.834 [1.786–1.851] | 0.045 — better |
| custom-responses.responses.json | p99 ms | 3/3; 66.689 [62.837–67.268] | 3/3; 24.493 [24.261–26.042] | 0.367 — better |
| custom-responses.responses.json | CPU ms/req | 3/3; 0.441 [0.435–0.463] | 3/3; 0.225 [0.212–0.230] | 0.509 — better |
| custom-responses.responses.json | CPU ms/req through row drain | 3/3; 0.441 [0.435–0.463] | 3/3; 0.225 [0.212–0.230] | 0.510 — better |
| custom-responses.responses.json | RSS peak MiB | 3/3; 128.469 [123.836–129.570] | 3/3; 41.570 [41.242–42.785] | 0.324 — better |
| custom-responses.responses.stream | req/s | 3/3; 1307.196 [490.761–1319.136] | 3/3; 17072.121 [16946.128–17231.124] | 13.060 — better |
| custom-responses.responses.stream | p50 ms | 3/3; 47.573 [47.564–48.742] | 3/3; 1.945 [1.928–1.955] | 0.041 — better |
| custom-responses.responses.stream | p99 ms | 3/3; 85.988 [81.666–1696.102] | 3/3; 26.643 [25.118–27.978] | 0.310 — better |
| custom-responses.responses.stream | CPU ms/req | 3/3; 0.548 [0.541–0.560] | 3/3; 0.212 [0.210–0.215] | 0.387 — better |
| custom-responses.responses.stream | CPU ms/req through row drain | 3/3; 0.548 [0.541–0.560] | 3/3; 0.212 [0.210–0.215] | 0.387 — better |
| custom-responses.responses.stream | RSS peak MiB | 3/3; 129.801 [125.605–130.035] | 3/3; 41.867 [41.680–42.203] | 0.323 — better |
| custom-responses.overhead-c1 | req/s | 3/3; 946.782 [92.143–966.769] | 3/3; 4794.695 [4771.640–4910.512] | 5.064 — better |
| custom-responses.overhead-c1 | p50 ms | 3/3; 0.746 [0.743–0.783] | 3/3; 0.188 [0.185–0.188] | 0.252 — better |
| custom-responses.overhead-c1 | p99 ms | 3/3; 11.302 [11.224–351.770] | 3/3; 0.401 [0.394–0.408] | 0.035 — better |
| custom-responses.overhead-c1 | CPU ms/req | 3/3; 0.709 [0.706–0.826] | 3/3; 0.134 [0.133–0.134] | 0.189 — better |
| custom-responses.overhead-c1 | CPU ms/req through row drain | 3/3; 0.709 [0.706–0.826] | 3/3; 0.134 [0.133–0.134] | 0.189 — better |
| custom-responses.overhead-c1 | RSS peak MiB | 3/3; 113.809 [109.023–118.586] | 3/3; 33.715 [33.016–34.730] | 0.296 — better |
| custom-responses.chunks-2000 | req/s | 3/3; 132.472 [129.570–137.659] | 3/3; 1270.332 [1266.339–1281.857] | 9.589 — better |
| custom-responses.chunks-2000 | p50 ms | 3/3; 117.599 [115.746–121.375] | 3/3; 12.374 [12.253–12.418] | 0.105 — better |
| custom-responses.chunks-2000 | p99 ms | 3/3; 218.761 [140.634–227.703] | 3/3; 19.659 [19.527–20.058] | 0.090 — better |
| custom-responses.chunks-2000 | CPU ms/req | 3/3; 7.433 [7.425–7.481] | 3/3; 3.036 [3.008–3.045] | 0.408 — better |
| custom-responses.chunks-2000 | CPU ms/req through row drain | 3/3; 7.433 [7.425–7.481] | 3/3; 3.036 [3.009–3.045] | 0.408 — better |
| custom-responses.chunks-2000 | RSS peak MiB | 3/3; 167.094 [158.270–177.484] | 3/3; 38.781 [38.453–39.680] | 0.232 — better |

### anthropic-key
| scenario | metric | base | head | head/base |
|---|---|---|---|---|
| anthropic-key.chat.json | req/s | 3/3; 1368.380 [1355.911–1413.423] | 3/3; 4498.364 [4491.765–4522.725] | 3.287 — better |
| anthropic-key.chat.json | p50 ms | 3/3; 45.018 [44.375–46.347] | 3/3; 5.616 [5.550–5.745] | 0.125 — better |
| anthropic-key.chat.json | p99 ms | 3/3; 69.259 [64.899–83.092] | 3/3; 185.960 [172.093–189.431] | 2.685 — worse |
| anthropic-key.chat.json | CPU ms/req | 3/3; 0.532 [0.522–0.550] | 3/3; 0.351 [0.351–0.366] | 0.659 — better |
| anthropic-key.chat.json | CPU ms/req through row drain | 3/3; 0.532 [0.522–0.550] | 3/3; 0.351 [0.351–0.366] | 0.659 — better |
| anthropic-key.chat.json | RSS peak MiB | 3/3; 137.980 [133.102–138.520] | 3/3; 95.199 [85.102–97.289] | 0.690 — better |
| anthropic-key.chat.stream | req/s | 3/3; 1291.221 [90.180–1331.574] | 3/3; 4421.758 [4276.923–4449.521] | 3.424 — better |
| anthropic-key.chat.stream | p50 ms | 3/3; 46.794 [46.636–630.015] | 3/3; 5.825 [5.730–5.878] | 0.124 — better |
| anthropic-key.chat.stream | p99 ms | 3/3; 100.264 [68.296–1133.830] | 3/3; 182.120 [181.791–192.811] | 1.816 — inside spread |
| anthropic-key.chat.stream | CPU ms/req | 3/3; 0.560 [0.543–0.626] | 3/3; 0.382 [0.381–0.392] | 0.682 — better |
| anthropic-key.chat.stream | CPU ms/req through row drain | 3/3; 0.560 [0.543–0.626] | 3/3; 0.382 [0.382–0.393] | 0.683 — better |
| anthropic-key.chat.stream | RSS peak MiB | 3/3; 136.730 [116.422–137.828] | 3/3; 107.891 [96.371–113.465] | 0.789 — better |
| anthropic-key.messages.json | req/s | 3/3; 1345.352 [315.513–1409.907] | 3/3; 4536.502 [4508.396–4579.088] | 3.372 — better |
| anthropic-key.messages.json | p50 ms | 3/3; 45.936 [44.267–166.873] | 3/3; 5.715 [5.514–5.792] | 0.124 — better |
| anthropic-key.messages.json | p99 ms | 3/3; 92.594 [69.411–547.782] | 3/3; 180.663 [163.926–184.965] | 1.951 — inside spread |
| anthropic-key.messages.json | CPU ms/req | 3/3; 0.513 [0.500–0.560] | 3/3; 0.359 [0.353–0.366] | 0.699 — better |
| anthropic-key.messages.json | CPU ms/req through row drain | 3/3; 0.514 [0.500–0.560] | 3/3; 0.359 [0.353–0.366] | 0.699 — better |
| anthropic-key.messages.json | RSS peak MiB | 3/3; 130.480 [126.156–133.617] | 3/3; 117.168 [108.680–122.809] | 0.898 — better |
| anthropic-key.messages.stream | req/s | 3/3; 1306.867 [1089.173–1320.603] | 3/3; 4448.694 [4416.114–4497.769] | 3.404 — better |
| anthropic-key.messages.stream | p50 ms | 3/3; 47.491 [46.760–49.988] | 3/3; 5.672 [5.610–5.817] | 0.119 — better |
| anthropic-key.messages.stream | p99 ms | 3/3; 72.563 [70.306–92.922] | 3/3; 191.166 [178.211–195.728] | 2.634 — worse |
| anthropic-key.messages.stream | CPU ms/req | 3/3; 0.562 [0.548–0.570] | 3/3; 0.370 [0.362–0.379] | 0.658 — better |
| anthropic-key.messages.stream | CPU ms/req through row drain | 3/3; 0.562 [0.548–0.571] | 3/3; 0.370 [0.362–0.379] | 0.659 — better |
| anthropic-key.messages.stream | RSS peak MiB | 3/3; 135.957 [134.227–136.172] | 3/3; 121.844 [110.469–127.262] | 0.896 — better |
| anthropic-key.responses.json | req/s | 3/3; 1368.691 [92.237–1431.085] | 3/3; 4508.389 [4440.419–4521.132] | 3.294 — better |
| anthropic-key.responses.json | p50 ms | 3/3; 44.931 [43.936–620.240] | 3/3; 5.685 [5.670–5.760] | 0.127 — better |
| anthropic-key.responses.json | p99 ms | 3/3; 96.506 [63.807–1126.591] | 3/3; 178.338 [172.296–180.227] | 1.848 — inside spread |
| anthropic-key.responses.json | CPU ms/req | 3/3; 0.498 [0.487–0.687] | 3/3; 0.365 [0.348–0.372] | 0.733 — better |
| anthropic-key.responses.json | CPU ms/req through row drain | 3/3; 0.498 [0.487–0.687] | 3/3; 0.365 [0.348–0.372] | 0.733 — better |
| anthropic-key.responses.json | RSS peak MiB | 3/3; 131.500 [119.473–132.590] | 3/3; 130.195 [118.238–131.438] | 0.990 — inside spread |
| anthropic-key.responses.stream | req/s | 3/3; 1269.795 [454.360–1279.560] | 3/3; 4456.018 [4379.983–4491.251] | 3.509 — better |
| anthropic-key.responses.stream | p50 ms | 3/3; 48.728 [48.495–112.276] | 3/3; 5.756 [5.648–5.774] | 0.118 — better |
| anthropic-key.responses.stream | p99 ms | 3/3; 71.107 [65.569–516.405] | 3/3; 186.410 [169.394–187.680] | 2.622 — inside spread |
| anthropic-key.responses.stream | CPU ms/req | 3/3; 0.594 [0.584–0.661] | 3/3; 0.368 [0.363–0.378] | 0.619 — better |
| anthropic-key.responses.stream | CPU ms/req through row drain | 3/3; 0.594 [0.584–0.661] | 3/3; 0.368 [0.364–0.379] | 0.620 — better |
| anthropic-key.responses.stream | RSS peak MiB | 3/3; 132.328 [130.426–133.035] | 3/3; 131.746 [128.746–142.418] | 0.996 — inside spread |
| anthropic-key.overhead-c1 | req/s | 3/3; 917.462 [842.257–918.781] | 3/3; 1162.052 [1087.222–1184.297] | 1.267 — better |
| anthropic-key.overhead-c1 | p50 ms | 3/3; 0.798 [0.783–0.837] | 3/3; 0.997 [0.974–1.010] | 1.250 — worse |
| anthropic-key.overhead-c1 | p99 ms | 3/3; 11.516 [11.266–11.568] | 3/3; 1.982 [1.779–2.479] | 0.172 — better |
| anthropic-key.overhead-c1 | CPU ms/req | 3/3; 0.765 [0.748–0.817] | 3/3; 0.346 [0.344–0.388] | 0.452 — better |
| anthropic-key.overhead-c1 | CPU ms/req through row drain | 3/3; 0.766 [0.748–0.817] | 3/3; 0.346 [0.344–0.388] | 0.452 — better |
| anthropic-key.overhead-c1 | RSS peak MiB | 3/3; 128.734 [124.438–134.563] | 3/3; 107.504 [102.367–119.418] | 0.835 — better |
| anthropic-key.chunks-2000 | req/s | 3/3; 148.175 [141.256–152.772] | 3/3; 1493.742 [1476.837–1504.698] | 10.081 — better |
| anthropic-key.chunks-2000 | p50 ms | 3/3; 103.330 [102.768–106.013] | 3/3; 10.017 [9.858–10.095] | 0.097 — better |
| anthropic-key.chunks-2000 | p99 ms | 3/3; 223.817 [160.388–244.578] | 3/3; 25.604 [24.292–26.187] | 0.114 — better |
| anthropic-key.chunks-2000 | CPU ms/req | 3/3; 6.370 [6.319–6.480] | 3/3; 2.360 [2.319–2.369] | 0.371 — better |
| anthropic-key.chunks-2000 | CPU ms/req through row drain | 3/3; 6.370 [6.319–6.480] | 3/3; 2.361 [2.319–2.371] | 0.371 — better |
| anthropic-key.chunks-2000 | RSS peak MiB | 3/3; 169.754 [167.098–170.672] | 3/3; 98.199 [96.914–106.852] | 0.578 — better |

### anthropic-oauth
| scenario | metric | base | head | head/base |
|---|---|---|---|---|
| anthropic-oauth.chat.json | req/s | 3/3; 1349.183 [1306.415–1377.314] | 3/3; 4447.413 [4413.450–4488.295] | 3.296 — better |
| anthropic-oauth.chat.json | p50 ms | 3/3; 46.163 [45.530–47.881] | 3/3; 5.737 [5.622–5.890] | 0.124 — better |
| anthropic-oauth.chat.json | p99 ms | 3/3; 78.019 [63.848–80.947] | 3/3; 178.219 [172.346–189.030] | 2.284 — worse |
| anthropic-oauth.chat.json | CPU ms/req | 3/3; 0.532 [0.516–0.549] | 3/3; 0.382 [0.361–0.388] | 0.718 — better |
| anthropic-oauth.chat.json | CPU ms/req through row drain | 3/3; 0.532 [0.516–0.549] | 3/3; 0.382 [0.361–0.389] | 0.718 — better |
| anthropic-oauth.chat.json | RSS peak MiB | 3/3; 136.387 [133.367–138.078] | 3/3; 130.133 [117.859–139.957] | 0.954 — inside spread |
| anthropic-oauth.chat.stream | req/s | 3/3; 1269.809 [938.340–1290.676] | 3/3; 4420.516 [4314.772–4484.209] | 3.481 — better |
| anthropic-oauth.chat.stream | p50 ms | 3/3; 48.707 [48.471–50.812] | 3/3; 5.844 [5.643–5.944] | 0.120 — better |
| anthropic-oauth.chat.stream | p99 ms | 3/3; 82.552 [69.050–585.519] | 3/3; 184.349 [179.135–188.929] | 2.233 — inside spread |
| anthropic-oauth.chat.stream | CPU ms/req | 3/3; 0.575 [0.559–0.586] | 3/3; 0.387 [0.366–0.391] | 0.672 — better |
| anthropic-oauth.chat.stream | CPU ms/req through row drain | 3/3; 0.575 [0.559–0.587] | 3/3; 0.387 [0.366–0.391] | 0.673 — better |
| anthropic-oauth.chat.stream | RSS peak MiB | 3/3; 136.887 [136.879–137.688] | 3/3; 140.613 [123.652–146.813] | 1.027 — inside spread |
| anthropic-oauth.messages.json | req/s | 3/3; 1262.098 [109.206–1372.547] | 3/3; 4509.060 [4497.390–4517.520] | 3.573 — better |
| anthropic-oauth.messages.json | p50 ms | 3/3; 46.509 [45.842–554.872] | 3/3; 5.728 [5.610–5.753] | 0.123 — better |
| anthropic-oauth.messages.json | p99 ms | 3/3; 208.406 [72.487–1047.282] | 3/3; 187.156 [164.710–188.003] | 0.898 — inside spread |
| anthropic-oauth.messages.json | CPU ms/req | 3/3; 0.524 [0.509–0.644] | 3/3; 0.364 [0.362–0.367] | 0.695 — better |
| anthropic-oauth.messages.json | CPU ms/req through row drain | 3/3; 0.524 [0.509–0.644] | 3/3; 0.365 [0.362–0.367] | 0.696 — better |
| anthropic-oauth.messages.json | RSS peak MiB | 3/3; 133.559 [117.793–134.512] | 3/3; 139.906 [127.125–149.949] | 1.048 — inside spread |
| anthropic-oauth.messages.stream | req/s | 3/3; 1252.618 [938.786–1293.397] | 3/3; 4454.783 [4399.917–4481.583] | 3.556 — better |
| anthropic-oauth.messages.stream | p50 ms | 3/3; 50.545 [47.121–52.892] | 3/3; 5.742 [5.697–5.778] | 0.114 — better |
| anthropic-oauth.messages.stream | p99 ms | 3/3; 74.671 [73.131–255.669] | 3/3; 184.642 [173.025–197.129] | 2.473 — inside spread |
| anthropic-oauth.messages.stream | CPU ms/req | 3/3; 0.574 [0.555–0.593] | 3/3; 0.371 [0.359–0.383] | 0.646 — better |
| anthropic-oauth.messages.stream | CPU ms/req through row drain | 3/3; 0.574 [0.555–0.593] | 3/3; 0.371 [0.359–0.383] | 0.646 — better |
| anthropic-oauth.messages.stream | RSS peak MiB | 3/3; 132.730 [132.406–136.352] | 3/3; 137.098 [132.352–150.559] | 1.033 — inside spread |
| anthropic-oauth.responses.json | req/s | 3/3; 1331.417 [485.737–1336.638] | 3/3; 4495.265 [4445.077–4506.304] | 3.376 — better |
| anthropic-oauth.responses.json | p50 ms | 3/3; 46.622 [46.339–49.337] | 3/3; 5.744 [5.717–5.806] | 0.123 — better |
| anthropic-oauth.responses.json | p99 ms | 3/3; 101.492 [85.885–1324.777] | 3/3; 178.253 [177.708–184.545] | 1.756 — inside spread |
| anthropic-oauth.responses.json | CPU ms/req | 3/3; 0.537 [0.508–0.545] | 3/3; 0.375 [0.365–0.393] | 0.699 — better |
| anthropic-oauth.responses.json | CPU ms/req through row drain | 3/3; 0.537 [0.508–0.545] | 3/3; 0.375 [0.365–0.393] | 0.700 — better |
| anthropic-oauth.responses.json | RSS peak MiB | 3/3; 136.707 [133.105–138.242] | 3/3; 137.945 [129.293–155.477] | 1.009 — inside spread |
| anthropic-oauth.responses.stream | req/s | 3/3; 1174.824 [126.000–1202.562] | 3/3; 4388.996 [4385.808–4524.353] | 3.736 — better |
| anthropic-oauth.responses.stream | p50 ms | 3/3; 52.547 [52.354–457.676] | 3/3; 5.777 [5.742–5.811] | 0.110 — better |
| anthropic-oauth.responses.stream | p99 ms | 3/3; 114.858 [90.646–1092.217] | 3/3; 184.161 [183.628–185.087] | 1.603 — inside spread |
| anthropic-oauth.responses.stream | CPU ms/req | 3/3; 0.633 [0.607–0.760] | 3/3; 0.380 [0.367–0.383] | 0.600 — better |
| anthropic-oauth.responses.stream | CPU ms/req through row drain | 3/3; 0.633 [0.607–0.760] | 3/3; 0.380 [0.367–0.383] | 0.600 — better |
| anthropic-oauth.responses.stream | RSS peak MiB | 3/3; 134.504 [125.340–139.695] | 3/3; 139.270 [131.000–153.344] | 1.035 — inside spread |
| anthropic-oauth.overhead-c1 | req/s | 3/3; 621.798 [75.995–863.371] | 3/3; 1103.517 [1095.124–1132.562] | 1.775 — better |
| anthropic-oauth.overhead-c1 | p50 ms | 3/3; 0.827 [0.827–0.848] | 3/3; 1.003 [1.001–1.005] | 1.213 — worse |
| anthropic-oauth.overhead-c1 | p99 ms | 3/3; 11.950 [11.640–580.597] | 3/3; 2.452 [2.420–2.456] | 0.205 — better |
| anthropic-oauth.overhead-c1 | CPU ms/req | 3/3; 0.800 [0.798–1.000] | 3/3; 0.383 [0.364–0.393] | 0.479 — better |
| anthropic-oauth.overhead-c1 | CPU ms/req through row drain | 3/3; 0.800 [0.798–1.000] | 3/3; 0.384 [0.364–0.393] | 0.480 — better |
| anthropic-oauth.overhead-c1 | RSS peak MiB | 3/3; 121.379 [120.617–126.047] | 3/3; 110.531 [107.465–130.215] | 0.911 — inside spread |
| anthropic-oauth.chunks-2000 | req/s | 3/3; 150.262 [148.438–156.883] | 3/3; 1498.736 [1489.181–1523.607] | 9.974 — better |
| anthropic-oauth.chunks-2000 | p50 ms | 3/3; 103.273 [102.818–106.342] | 3/3; 9.986 [9.920–10.002] | 0.097 — better |
| anthropic-oauth.chunks-2000 | p99 ms | 3/3; 154.677 [141.621–242.360] | 3/3; 24.751 [22.923–25.793] | 0.160 — better |
| anthropic-oauth.chunks-2000 | CPU ms/req | 3/3; 6.313 [6.239–6.473] | 3/3; 2.356 [2.352–2.357] | 0.373 — better |
| anthropic-oauth.chunks-2000 | CPU ms/req through row drain | 3/3; 6.313 [6.239–6.473] | 3/3; 2.356 [2.353–2.357] | 0.373 — better |
| anthropic-oauth.chunks-2000 | RSS peak MiB | 3/3; 170.996 [170.133–176.828] | 3/3; 104.313 [99.664–113.355] | 0.610 — better |

