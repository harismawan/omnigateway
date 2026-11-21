"""Loopback-only HTTP/1.1 recorder and synthetic Google backend. See README.md."""

import json
import os
from pathlib import Path
import socketserver
import ssl
import sys
import threading
from urllib.parse import urlsplit

PROJECT = "capture-project"
MODEL = "gemini-pro-agent"
LIMIT = 16 * 1024 * 1024


def reply(host, path, body):
    if host == "oauth2.googleapis.com" and path == "/token":
        return {
            "access_token": "capture-access-token",
            "refresh_token": "capture-refresh-token",
            "token_type": "Bearer",
            "expires_in": 3600,
        }
    if "userinfo" in path:
        return {
            "id": "1234567890", "email": "capture@example.invalid", "verified_email": True,
            "name": "Capture User", "given_name": "Capture", "family_name": "User",
        }
    if path.endswith(":loadCodeAssist"):
        tiers = {"allowedTiers": [{"id": "free-tier", "isDefault": True}]}
        if os.getenv("CAPTURE_UNONBOARDED") and b"cloudaicompanionProject" not in body:
            return tiers
        return {**tiers, "cloudaicompanionProject": PROJECT, "currentTier": {"id": "free-tier"}}
    if path.endswith(":onboardUser"):
        return {
            "name": "operations/capture", "done": True,
            "response": {"cloudaicompanionProject": {"id": PROJECT}},
        }
    if path.endswith(":fetchAvailableModels"):
        return {
            "models": {MODEL: {
                "displayName": "Gemini Pro", "maxTokens": 1048576, "maxOutputTokens": 65536,
                "supportsThinking": True, "model": "MODEL_GOOGLE_GEMINI_2_5_PRO",
                "apiProvider": "API_PROVIDER_GOOGLE_GEMINI", "modelProvider": "MODEL_PROVIDER_GOOGLE",
            }},
            "defaultAgentModelId": MODEL,
            "agentModelSorts": [{"displayName": "Capture", "groups": [
                {"displayName": "Google", "modelIds": [MODEL]},
            ]}],
        }
    if path.endswith(":streamGenerateContent"):
        result = {
            "response": {
                "candidates": [{"index": 0, "content": {"role": "model", "parts": [{"text": "hi"}]},
                                "finishReason": "STOP"}],
                "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 1, "totalTokenCount": 11},
            },
            "traceId": "capture-trace",
        }
        return "data: " + json.dumps(result) + "\n\n"
    return {}


def read_body(stream, headers):
    if headers.get("transfer-encoding", "").lower().strip() != "chunked":
        length = int(headers.get("content-length", "0"))
        if not 0 <= length <= LIMIT:
            raise ValueError("body too large")
        data = stream.read(length)
        if len(data) != length:
            raise ValueError("truncated body")
        return data, data
    wire = bytearray()
    data = bytearray()
    while True:
        line = stream.readline(128)
        size = int(line.split(b";", 1)[0], 16)
        if size < 0 or len(wire) + size > LIMIT:
            raise ValueError("body too large")
        wire.extend(line)
        if not size:
            while True:
                line = stream.readline(65536)
                wire.extend(line)
                if line == b"\r\n":
                    return bytes(wire), bytes(data)
                if not line or len(wire) > LIMIT:
                    raise ValueError("invalid trailers")
        part = stream.read(size)
        if len(part) != size or stream.read(2) != b"\r\n":
            raise ValueError("truncated chunk")
        wire.extend(part + b"\r\n")
        data.extend(part)


class Handler(socketserver.StreamRequestHandler):
    timeout = 10

    def handle(self):
        start = self.rfile.readline(65536)
        if not start:
            return
        method, target, _ = start.decode("latin1").split()
        lines = []
        headers = {}
        while len(lines) < 100:
            line = self.rfile.readline(65536)
            if line == b"\r\n":
                break
            name, value = line.decode("latin1").split(":", 1)
            lines.append(line)
            headers[name.lower()] = value.strip()
        else:
            raise ValueError("too many headers")
        wire, body = read_body(self.rfile, headers)
        path = urlsplit(target).path
        host = headers.get("host", "").split(":", 1)[0]
        self.server.record(start + b"".join(lines) + b"\r\n", wire, method, host, path, len(body))
        payload = reply(host, path, body)
        sse = isinstance(payload, str)
        result = (payload if sse else json.dumps(payload)).encode()
        mime = "text/event-stream" if sse else "application/json"
        self.wfile.write((f"HTTP/1.1 200 OK\r\nContent-Type: {mime}\r\n"
                          f"Content-Length: {len(result)}\r\nConnection: close\r\n\r\n").encode() + result)


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, out):
        self.out = out
        self.lock = threading.Lock()
        self.count = 0
        super().__init__(("127.0.0.1", 443), Handler)

    def record(self, head, wire, method, host, path, size):
        with self.lock:
            self.count += 1
            key = f"{self.count:03}"
            (self.out / f"{key}.head.txt").write_bytes(head)
            (self.out / f"{key}.body.bin").write_bytes(wire)
            with (self.out / "index.txt").open("a") as index:
                index.write(f"{key} {method} {host}{path} body={size}\n")


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: capture.py <tls-dir> <new-capture-dir>")
    names = {line.split(":", 1)[0].strip()
             for line in Path("/proc/net/dev").read_text().splitlines()[2:]}
    if names != {"lo"}:
        raise SystemExit("refusing to run outside a loopback-only network namespace")
    os.umask(0o077)
    tls, out = map(Path, sys.argv[1:])
    out.mkdir(mode=0o700)
    with Server(out) as server:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(tls / "srv.pem", tls / "srv.key")
        context.set_alpn_protocols(["http/1.1"])
        server.socket = context.wrap_socket(server.socket, server_side=True)
        (out / "ready").touch()
        server.serve_forever()


if __name__ == "__main__":
    main()
