#!/usr/bin/env python3
"""factory/bin/agent.py's claude-code provider against a fake `claude`:
the flags Claude Code's print mode takes, the prompt on stdin, the JSON
result read back, an error result raised, and the API key withheld from
the child so the subscription is what pays. Run: python3 tests/agent-claude-code.py"""
import json
import os
import stat
import subprocess
import sys
import tempfile
from importlib.machinery import SourceFileLoader

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
agent = SourceFileLoader("agent", os.path.join(ROOT, "factory", "bin", "agent.py")).load_module()

FAKE = r'''#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
user = sys.stdin.read()
record = {"args": args, "stdin": user, "cwd": os.getcwd(), "api_key_seen": "ANTHROPIC_API_KEY" in os.environ, "token": os.environ.get("CLAUDE_CODE_OAUTH_TOKEN")}
open(os.environ["FAKE_RECORD"], "w").write(json.dumps(record))
mode = os.environ.get("FAKE_MODE", "ok")
if mode == "ok":
    print(json.dumps({"type": "result", "subtype": "success", "is_error": False, "result": '{"verdict":"ok","summary":"fine","findings":[]}', "modelUsage": {"claude-haiku-4-5-20251001": {"outputTokens": 12}, "claude-sonnet-5": {"outputTokens": 900}}, "total_cost_usd": 0.01}))
elif mode == "limit":
    print(json.dumps({"type": "result", "subtype": "success", "is_error": True, "result": "You've hit your limit · resets 3pm", "modelUsage": {}}))
    sys.exit(1)
else:
    print("Not logged in · Please run /login", file=sys.stderr); sys.exit(1)
'''

with tempfile.TemporaryDirectory() as tmp:
    fake = os.path.join(tmp, "claude")
    open(fake, "w").write(FAKE)
    os.chmod(fake, os.stat(fake).st_mode | stat.S_IEXEC)
    record = os.path.join(tmp, "record.json")
    os.environ.update({"CLAUDE_CODE_BIN": fake, "CLAUDE_CODE_OAUTH_TOKEN": "sk-ant-oat01-test", "ANTHROPIC_API_KEY": "sk-ant-api-should-not-leak", "FAKE_RECORD": record, "FACTORY_PROVIDER": "claude-code", "FACTORY_REASONING": "low"})
    os.environ.pop("FACTORY_MODEL", None)

    assert agent.provider()[0] == "claude-code"
    text, model = agent.complete("the rules", "the PKGBUILD and the log", max_tokens=32000)
    assert json.loads(text)["verdict"] == "ok" and model == "claude-sonnet-5", (text, model)
    r = json.load(open(record))
    a = r["args"]
    assert a[:2] == ["-p", "--tools"] and a[2] == "" and "--no-session-persistence" in a and "--max-turns" in a, a
    assert a[a.index("--output-format") + 1] == "json" and a[a.index("--model") + 1] == "claude-sonnet-5", a
    assert a[a.index("--system-prompt") + 1] == "the rules" and a[a.index("--effort") + 1] == "low", a
    assert r["stdin"] == "the PKGBUILD and the log" and r["token"] == "sk-ant-oat01-test" and r["api_key_seen"] is False, r
    assert "omarchy-agent-" in r["cwd"] and not r["cwd"].startswith(ROOT), r["cwd"]  # an empty scratch directory, never the checkout
    print("ok: flags, stdin, cwd, token in, API key out, the author is the model that wrote the answer")

    os.environ["FACTORY_MODEL"] = "claude-opus-5"
    agent.complete("s", "u")
    assert json.load(open(record))["args"][a.index("--model") + 1] == "claude-opus-5"
    print("ok: FACTORY_MODEL")
    os.environ["FACTORY_MODEL"] = "gemini-3.6-flash"  # left over from the provider before
    agent.complete("s", "u")
    assert json.load(open(record))["args"][a.index("--model") + 1] == "claude-sonnet-5"
    print("ok: a FACTORY_MODEL of another family is ignored")
    del os.environ["FACTORY_MODEL"]

    for mode, expect in (("limit", "hit your limit"), ("notlogged", "Not logged in")):
        os.environ["FAKE_MODE"] = mode
        try:
            agent.complete("s", "u")
            raise AssertionError(f"{mode}: no error raised")
        except SystemExit as e:
            assert expect in str(e), (mode, str(e))
            print(f"ok: {mode} raises — {str(e)[:60]}")

    del os.environ["CLAUDE_CODE_OAUTH_TOKEN"]
    try:
        agent.provider()
        raise AssertionError("an explicit FACTORY_PROVIDER without its token should be refused")
    except SystemExit as e:
        assert "CLAUDE_CODE_OAUTH_TOKEN is not set" in str(e), str(e)
    del os.environ["FACTORY_PROVIDER"]
    assert agent.provider()[0] == "anthropic", agent.provider()  # the API key, next in line
    print("ok: without the token, the explicit choice is refused and the implicit one moves on")
print("AGENT CLAUDE-CODE OK")
