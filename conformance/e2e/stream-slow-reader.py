#!/usr/bin/env python3
"""Paired stopped-TCP-reader experiment (caller supplies isolated netns/env).

Usage: stream-slow-reader.py frozen rust private-work [mutations=6000]
No TCP reads occur between subscription acknowledgment and burst completion.
Admin resource events are coalesced and unsequenced: this experiment cannot
establish the 1000-frame drop-oldest boundary or identify individual mutations.
It deliberately reports those limits rather than defeating production floors.
"""
import base64
import concurrent.futures
import http.client
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import sys
import time


def exact(sock, size):
    data = b""
    while len(data) < size:
        part = sock.recv(size - len(data))
        if not part:
            raise EOFError()
        data += part
    return data


def frame(sock):
    opcode, size = exact(sock, 2)
    assert not size & 128, "masked server frame"
    size &= 127
    if size == 126:
        size = struct.unpack("!H", exact(sock, 2))[0]
    elif size == 127:
        size = struct.unpack("!Q", exact(sock, 8))[0]
    return opcode & 15, exact(sock, size)


def send(sock, opcode, value):
    payload = value.encode()
    assert len(payload) < 126
    mask = b"s10!"
    sock.sendall(bytes([128 | opcode, 128 | len(payload)]) + mask
                 + bytes(byte ^ mask[i % 4] for i, byte in enumerate(payload)))


def memory(pid):
    fields = {}
    for line in Path(f"/proc/{pid}/status").read_text().splitlines():
        if line.startswith(("VmRSS:", "VmHWM:")):
            key, value, _unit = line.split()
            fields[key[:-1] + "_KiB"] = int(value)
    return fields


def experiment(binary, root, count):
    root.mkdir(parents=True)
    env = dict(os.environ, OMNI_ROOT=str(root), OMNI_DB_PATH=str(root / "omni.db"),
               OMNI_HOST="127.0.0.1", OMNI_PORT="18794", OMNI_LOG_LEVEL="warn",
               OMNI_ENCRYPTION_KEY="stream-test-encryption-key-0123456789")
    with open(root / "gateway.log", "wb") as log:
        child = subprocess.Popen([binary], cwd=root, env=env, stdout=log, stderr=log)
        sock = None
        cookie = ""

        def api(path, body=None, method="POST", connection=None):
            conn = connection or http.client.HTTPConnection("127.0.0.1", 18794, timeout=30)
            conn.request(method, path, None if body is None else json.dumps(body),
                         {"content-type": "application/json", "cookie": cookie})
            response = conn.getresponse()
            data = response.read()
            assert response.status == 200, (path, response.status, data)
            token = response.getheader("set-cookie")
            if connection is None:
                conn.close()
            return token.split(";")[0] if token else None

        try:
            for _ in range(200):
                try:
                    api("/health", method="GET")
                    break
                except OSError:
                    time.sleep(.025)
            else:
                raise AssertionError("gateway did not start")
            api("/api/setup", {"password": "stream-test-password"})
            cookie = api("/api/login", {"password": "stream-test-password"})
            time.sleep(1.2)
            sock = socket.socket()
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1024)
            sock.settimeout(10)
            sock.connect(("127.0.0.1", 18794))
            sock.sendall(("GET /api/stream HTTP/1.1\r\nHost: localhost\r\n"
                          "Upgrade: websocket\r\nConnection: Upgrade\r\n"
                          "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: "
                          + base64.b64encode(b"the sample nonce").decode()
                          + "\r\nCookie: " + cookie + "\r\n\r\n").encode())
            header = b""
            while not header.endswith(b"\r\n\r\n"):
                header += exact(sock, 1)
            assert header.startswith(b"HTTP/1.1 101"), header
            send(sock, 1, json.dumps({"type": "subscribe", "topic": "res:models"}))
            opcode, payload = frame(sock)
            assert opcode == 1 and json.loads(payload)["type"] == "ack", payload
            before = memory(child.pid)
            started = time.monotonic()

            def worker(index):
                conn = http.client.HTTPConnection("127.0.0.1", 18794, timeout=30)
                try:
                    for _ in range(index, count, 20):
                        api("/api/models/slow-reader", {"id": "slow-reader", "strategy": "priority",
                            "isAlias": False, "targets": [{"provider": "openai", "model": "gpt-4o",
                                "tier": 1, "weight": 1, "costPerMTok": {"input": 1, "output": 2},
                                "capabilities": {"tools": True, "images": False, "reasoning": False}}]}, "PUT", conn)
                finally:
                    conn.close()

            # No socket recv, peek, select, WebSocket library, or background
            # reader in this interval. SO_RCVBUF is set before connect.
            with concurrent.futures.ThreadPoolExecutor(max_workers=20) as pool:
                list(pool.map(worker, range(20)))
            time.sleep(2.2)  # include trailing coalesced delivery, still no reads
            blocked_seconds = time.monotonic() - started
            after = memory(child.pid)
            sock.settimeout(2)
            frames = []
            close = None
            while True:
                try:
                    opcode, payload = frame(sock)
                except socket.timeout:
                    break
                except EOFError:
                    close = "EOF"
                    break
                if opcode == 1:
                    frames.append(json.loads(payload))
                elif opcode == 8:
                    close = {"code": int.from_bytes(payload[:2], "big"),
                             "reason": payload[2:].decode(), "observed_seconds": time.monotonic() - started}
                    break
                elif opcode == 9:
                    send(sock, 10, payload.decode())
                else:
                    raise AssertionError((opcode, payload))
            notices = [value for value in frames if value.get("type") != "event"]
            assert not notices, notices
            assert all(value == {"type": "event", "topic": "res:models"} for value in frames), frames
            close_at_drain = close
            # Resume normal reading/pong replies and observe the real deadline.
            # Frozen's raw-socket pong callback does not update its registry.
            while close is None and time.monotonic() - started < 85:
                try:
                    opcode, payload = frame(sock)
                except socket.timeout:
                    continue
                except EOFError:
                    close = "EOF"
                    break
                if opcode == 9:
                    send(sock, 10, payload.decode())
                elif opcode == 8:
                    close = {"code": int.from_bytes(payload[:2], "big"),
                             "reason": payload[2:].decode(), "observed_seconds": time.monotonic() - started}
                else:
                    raise AssertionError((opcode, payload))
            assert isinstance(close, dict) and close["code"] == 1001 and close["reason"] == "pong deadline", close
            return {"mutations": count, "blocked_seconds": blocked_seconds,
                    "receive_buffer_bytes": sock.getsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF),
                    "received_events": len(frames), "frames": frames, "notices": notices,
                    "close_at_drain": close_at_drain, "eventual_close": close, "before": before, "after": after,
                    "limitations": "Unsequenced/coalesced resource frames; no queue saturation claim; memory includes admin work, not socket-only growth."}
        finally:
            if sock is not None:
                sock.close()
            child.terminate()
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()


if __name__ == "__main__":
    frozen, rust, work = sys.argv[1:4]
    count = int(sys.argv[4]) if len(sys.argv) > 4 else 6000
    results = {name: experiment(binary, Path(work) / name, count)
               for name, binary in [("frozen", frozen), ("rust", rust)]}
    Path(work, "results.json").write_text(json.dumps(results, indent=2) + "\n")
    print(json.dumps(results, indent=2))
