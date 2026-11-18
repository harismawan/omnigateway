#!/usr/bin/env python3
"""Supplemental A9 lifecycle probe; caller supplies netns, scrubbed env/private HOME.
Args: binary existing-private-root output-json. Responds to pings, revokes the
session after the first heartbeat, then observes the next validation. Separate
connection checks shutdown. Seed root with stream-handshake.ts first.
"""
import base64
import http.client
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import sys
import time

binary, root, output = sys.argv[1:4]
idle = len(sys.argv) > 4 and sys.argv[4] == "idle"
phase = len(sys.argv) > 4 and sys.argv[4] == "phase"
closed = len(sys.argv) > 4 and sys.argv[4] == "closed"
env = dict(os.environ, OMNI_ROOT=root, OMNI_DB_PATH=root + "/omni.db",
           OMNI_ENCRYPTION_KEY="stream-test-encryption-key-0123456789",
           OMNI_HOST="127.0.0.1", OMNI_PORT="18772",
           OMNI_METRICS_TOKEN="stream-metrics-test",
           OMNI_LOG_LEVEL="debug" if closed else "warn")
log = open(output + ".stderr", "wb")
p = subprocess.Popen([binary], cwd=root, env=env, stdout=log, stderr=log)

def api(path, body, cookie=None):
    c = http.client.HTTPConnection("127.0.0.1", 18772, timeout=5)
    h = {"content-type": "application/json"}
    if cookie:
        h["cookie"] = cookie
    c.request("POST", path, json.dumps(body), h)
    r = c.getresponse()
    token = r.getheader("set-cookie")
    r.read()
    assert r.status == 200, (path, r.status)
    c.close()
    return token.split(";")[0] if token else None

def exact(s, n):
    result = b""
    while len(result) < n:
        part = s.recv(n-len(result))
        if not part:
            raise EOFError()
        result += part
    return result

def opened(cookie):
    s = socket.create_connection(("127.0.0.1", 18772), timeout=30)
    s.sendall(("GET /api/stream HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n"
               "Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: "
               + base64.b64encode(b"the sample nonce").decode() + "\r\nCookie: " + cookie + "\r\n\r\n").encode())
    head = b""
    while not head.endswith(b"\r\n\r\n"):
        head += exact(s, 1)
    assert head.startswith(b"HTTP/1.1 101"), head
    return s

def frame(s):
    op, n = exact(s, 2)
    assert n < 126, n
    return op & 15, exact(s, n)

try:
    # Bound readiness retry; no production timings are shortened.
    for _ in range(200):
        if p.poll() is not None:
            raise RuntimeError("gateway exited")
        try:
            cookie = api("/api/login", {"password": "stream-test-password"})
            break
        except ConnectionRefusedError:
            time.sleep(.025)
    else:
        raise RuntimeError("gateway not ready")
    if closed:
        def connections():
            c = http.client.HTTPConnection("127.0.0.1", 18772, timeout=5)
            c.request("GET", "/metrics", headers={"authorization": "Bearer stream-metrics-test"})
            r = c.getresponse()
            assert r.status == 200, r.status
            text = r.read().decode()
            c.close()
            return next(float(line.split()[-1]) for line in text.splitlines()
                        if line.startswith("omni_stream_connections "))

        baseline = connections()
        sockets = [opened(cookie) for _ in range(300)]
        time.sleep(.1)
        while_open = connections()
        assert while_open == baseline + 300, (baseline, while_open)
        for s in sockets:
            # Normal client close: 1000, empty reason, masked.
            s.sendall(b"\x88\x82\0\0\0\0\x03\xe8")
            assert frame(s) == (8, b"\x03\xe8")
            s.close()
        time.sleep(.1)
        after_close = connections()
        assert after_close == baseline, (baseline, while_open, after_close)
        s = opened(cookie)
        s.close()
        time.sleep(.1)
        after_eof = connections()
        assert after_eof == baseline, (baseline, after_eof)
        Path(output).write_text(json.dumps({"baseline": baseline, "whileOpen": while_open,
                                           "afterClose": after_close, "afterEof": after_eof,
                                           "concurrentUpgrades": 300}))
        print("PASS client close / EOF cleanup / no 256-connection cap", output)
        sys.exit(0)
    if phase:
        # A socket opened halfway through a registry tick must share the first
        # socket's ping/validation phase, not wait its own full 20 seconds.
        first = opened(cookie)
        time.sleep(8)
        second = opened(cookie)
        start = time.monotonic()
        assert frame(first)[0] == 9
        first_at = time.monotonic() - start
        assert frame(second)[0] == 9
        second_at = time.monotonic() - start
        assert abs(second_at - first_at) < 1, (first_at, second_at)
        assert 9 <= second_at <= 15, second_at
        api("/api/logout", {}, cookie)
        for s in (first, second):
            op, data = frame(s)
            if op == 9:
                op, data = frame(s)
            assert op == 8 and data == struct.pack(">H", 4401) + b"session expired", (op, data)
            s.close()
        Path(output).write_text(json.dumps({"firstPingSeconds": first_at,
                                           "secondPingSeconds": second_at,
                                           "close": "4401 session expired, shared tick"}))
        print("PASS registry-wide heartbeat phase / revalidation", output)
        sys.exit(0)
    s = opened(cookie)
    start = time.monotonic()
    op, data = frame(s)
    assert op == 9
    ping_at = time.monotonic()-start
    assert 15 <= ping_at <= 25, ping_at
    s.sendall(bytes([0x8a, 0x80 | len(data)]) + b"\0\0\0\0" + data)
    if not idle:
        api("/api/logout", {}, cookie)
    while True:
        op, data = frame(s)
        if op == 8:
            break
        assert op == 9
        s.sendall(bytes([0x8a, 0x80 | len(data)]) + b"\0\0\0\0" + data)
    expected = struct.pack(">H", 1001) + b"pong deadline" if idle else struct.pack(">H", 4401) + b"session expired"
    assert data == expected, data
    revoked_at = time.monotonic()-start
    assert (55 <= revoked_at <= 85 if idle else 30 <= revoked_at <= 45), revoked_at
    s.close()
    cookie = api("/api/login", {"password": "stream-test-password"})
    s = opened(cookie)
    p.terminate()
    op, data = frame(s)
    assert op == 8 and data == struct.pack(">H", 1001) + b"restart", (op, data)
    s.close()
    Path(output).write_text(json.dumps({"pingSeconds": ping_at, "revokedSeconds": revoked_at,
                                       "close": "1001 pong deadline (despite pongs)" if idle else "4401 session expired", "shutdown": "1001 restart"}))
    print("PASS heartbeat / pong / revoke / shutdown", output)
finally:
    if p.poll() is None:
        p.terminate()
    p.wait(timeout=15)
    log.close()
