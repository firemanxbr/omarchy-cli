#!/usr/bin/env python3
"""factory/bin/agent-proxy against a fake agent: the Anthropic Messages
shape in, the agent's answer out; the probe on /health; an agent failure
as a 502 the client (agent.py's anthropic path) understands; and agent.py
itself talking to the proxy end to end with FACTORY_PROVIDER=anthropic.
Run: python3 tests/agent-proxy.py"""
import json
import os
import sys
import threading
import urllib.request
from http.server import ThreadingHTTPServer
from importlib.machinery import SourceFileLoader

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "factory", "bin"))
agent = SourceFileLoader("agent", os.path.join(ROOT, "factory", "bin", "agent.py")).load_module()
proxy = SourceFileLoader("agent_proxy", os.path.join(ROOT, "factory", "bin", "agent-proxy")).load_module()

seen = []


def fake_complete(system, user, max_tokens=4000, timeout=300):
    seen.append({"system": system, "user": user, "max_tokens": max_tokens})
    if user == "boom":
        raise SystemExit("claude-code: You've hit your limit")
    return "OK from the fake", "claude-sonnet-5"


proxy.agent.complete = fake_complete
proxy.agent.probe = lambda timeout=90: (True, {"provider": "claude-code", "model": "claude-sonnet-5", "ms": 3})
srv = ThreadingHTTPServer(("127.0.0.1", 0), proxy.Handler)
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
base = f"http://127.0.0.1:{port}"

# 1. The Messages shape, as agent.py's anthropic path sends it.
body = {"model": "claude-sonnet-5", "max_tokens": 32000, "system": "You audit.", "messages": [{"role": "user", "content": "the PKGBUILD"}]}
req = urllib.request.Request(base + "/v1/messages", data=json.dumps(body).encode(), method="POST", headers={"x-api-key": "via-agent-proxy", "content-type": "application/json"})
with urllib.request.urlopen(req) as r:
    out = json.load(r)
assert out["content"][0]["text"] == "OK from the fake" and out["model"] == "claude-sonnet-5", out
assert seen[-1] == {"system": "You audit.", "user": "the PKGBUILD", "max_tokens": 32000}, seen[-1]

# 2. The probe.
with urllib.request.urlopen(base + "/health") as r:
    assert json.load(r)["ok"] is True

# 3. A failing agent is a 502 with the reason.
body["messages"][0]["content"] = "boom"
req = urllib.request.Request(base + "/v1/messages", data=json.dumps(body).encode(), method="POST", headers={"content-type": "application/json"})
try:
    urllib.request.urlopen(req)
    raise AssertionError("a failing agent must be a 502")
except urllib.error.HTTPError as e:
    assert e.code == 502 and "hit your limit" in json.load(e)["error"]["message"]

# 4. agent.py end to end, the way the emulated worker is configured.
os.environ.update({"FACTORY_PROVIDER": "anthropic", "ANTHROPIC_API_KEY": "via-agent-proxy", "ANTHROPIC_BASE_URL": base})
text, model = agent.complete("You draft.", "a PKGBUILD please", max_tokens=100)
assert (text, model) == ("OK from the fake", "claude-sonnet-5"), (text, model)
assert seen[-1]["user"] == "a PKGBUILD please"
print("agent-proxy: ok")
