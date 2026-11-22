# Antigravity capture harness

The inference profile is based on a Linux x86_64 **Antigravity App** 2.34.0
Hub agent turn, recorded 2026-11-21. See the [sanitized fixture][fixture] and
the [provider design][design]. Record the App and CLI separately: the CLI is
not evidence for the App's identity.

1. Use a fresh private scratch directory (`W`, absolute). Fetch the App from
   the official [download page](https://antigravity.google/download/). For the
   CLI, read `https://antigravity.google/cli/install.sh` to find the platform
   manifest and fetch its payload without running the installer. Record URL,
   bytes and SHA-256; verify the GCS CRC32C for the App and manifest SHA-512 for
   the CLI. Unpack into scratch, not the live install.
2. Make a throwaway CA and server certificate as in the [Codex procedure][codex],
   extending the SAN list with the DNS names from the hosts file below. Trust
   it only in the test processes. Use a fresh synthetic login per run:

   ```bash
   S=$PWD/scripts/antigravity-capture
   mkdir -m 700 "$W/tmp"
   python3 "$S/mkauth.py" "$W/home" app # or cli
   printf '127.0.0.1 localhost daily-cloudcode-pa.googleapis.com cloudcode-pa.googleapis.com oauth2.googleapis.com www.googleapis.com accounts.google.com antigravity.google\n' > "$W/hosts"
   ```

3. Enter a private network, mount and PID namespace. The identity mapping
   permits Xvfb to run under the original non-root UID; `--keep-caps` permits
   setting up loopback and binding port 443. Stop if setup fails.

   ```bash
   unshare --user --map-users="$(id -u),$(id -u),1" \
     --map-groups="$(id -g),$(id -g),1" --keep-caps --net --mount --pid \
     --fork --kill-child --mount-proc bash -ec '
       ip link set lo up
       mount --bind "$1/hosts" /etc/hosts
       test "$(ip -o link | wc -l)" -eq 1
       test -z "$(ip route show table main)"
       cd "$1/home"
       exec env -i PATH=/usr/bin:/bin LANG=C.UTF-8 HOME="$1/home" TMPDIR="$1/tmp" \
         SSL_CERT_FILE="$1/tls/ca.pem" W="$1" S="$2" bash --noprofile --norc -i
     ' bash "$W" "$S"
   ```

4. In that shell, start the recorder and arrange cleanup:

   ```bash
   python3 "$S/capture.py" "$W/tls" "$W/cap" &
   recorder=$!
   trap 'kill "$recorder" 2>/dev/null; wait "$recorder" 2>/dev/null' EXIT
   ```

   Wait for `cap/ready`, then run the real client (set its absolute path):

   - **App:** launch `xvfb-run -a "$APP" --no-sandbox --disable-gpu`. Use the
     virtual display or add `--remote-debugging-port=9222` and drive it from
     inside the namespace. Continue past the welcome card, leave **Gemini Pro**
     selected, and send `Say hi`. The App also sends a `checkpoint` request;
     take the subsequent `agent` turn as the inference fingerprint.
   - **CLI:** run `"$CLI" --print-timeout 20s -p 'Say hi'`. To record token exchange,
     use an empty scratch home instead of seeding it, run in a PTY, and paste
     `synthetic-auth-code` at the authorization prompt. Do not visit the Google URL.
   - **Onboarding:** set `CAPTURE_UNONBOARDED=1` on a fresh recorder run to
     return a tier but no project from the initial bootstrap RPC.

5. Find `streamGenerateContent`, `loadCodeAssist`, `onboardUser` and
   `retrieveUserQuotaSummary` in `cap/index.txt`. Inspect an entry with
   `python3 -B "$S/show.py" "$W/cap" 016`, replacing `016` with its number.
   `.head.txt` and `.body.bin` retain raw HTTP/1.1 header and body bytes,
   including chunk delimiters. **Do not commit raw traces:** they include
   prompts, tool definitions, IDs, local paths and OAuth form data. Save only
   sanitized fields in the fixture. Exit the PID namespace to stop its
   processes, and discard the scratch CA and login when finished.

The recorder never forwards requests. The capture does not establish HTTP/2
behavior or live backend acceptance.

[fixture]: ../../crates/omni-providers/tests/fixtures/antigravity-2.34.0.json
[design]: ../../docs/superpowers/specs/2026-09-05-antigravity-provider-design.md#current-inference-fingerprint
[codex]: ../codex-capture/README.md
