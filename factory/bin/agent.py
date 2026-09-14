"""The worker owner's agent, whichever provider they use.

One function, `complete(system, user, max_tokens)`, over the provider the
environment names. The key is the worker owner's, in the container's
environment; the pool and GitHub hold none (SECURITY.md).

    provider   key                model (FACTORY_MODEL overrides)   endpoint (…_BASE_URL overrides)
    anthropic  ANTHROPIC_API_KEY  claude-sonnet-5                   https://api.anthropic.com  (Messages API)
    openai     OPENAI_API_KEY     gpt-5                             https://api.openai.com/v1  (chat completions)
    gemini     GEMINI_API_KEY     gemini-3.6-flash                  https://generativelanguage.googleapis.com/v1beta/openai  (OpenAI-compatible)
    xai        XAI_API_KEY        grok-4                            https://api.x.ai/v1  (OpenAI-compatible)

FACTORY_PROVIDER picks one explicitly; otherwise the first key found, in
that order. Gemini and xAI speak the OpenAI chat-completions format, so
there are two code paths for four providers.
"""
import json
import os
import urllib.request

PROVIDERS = {
    "anthropic": {"key": "ANTHROPIC_API_KEY", "model": "claude-sonnet-5", "base": "https://api.anthropic.com", "base_env": "ANTHROPIC_BASE_URL", "api": "anthropic"},
    "openai": {"key": "OPENAI_API_KEY", "model": "gpt-5", "base": "https://api.openai.com/v1", "base_env": "OPENAI_BASE_URL", "api": "openai"},
    "gemini": {"key": "GEMINI_API_KEY", "model": "gemini-3.6-flash", "base": "https://generativelanguage.googleapis.com/v1beta/openai", "base_env": "GEMINI_BASE_URL", "api": "openai"},
    "xai": {"key": "XAI_API_KEY", "model": "grok-4", "base": "https://api.x.ai/v1", "base_env": "XAI_BASE_URL", "api": "openai"},
}
KEYS = [p["key"] for p in PROVIDERS.values()]


def provider():
    """The provider name and its settings, or None when no key is set."""
    name = os.environ.get("FACTORY_PROVIDER", "").strip().lower()
    if name:
        if name not in PROVIDERS:
            raise SystemExit(f"FACTORY_PROVIDER must be one of {', '.join(PROVIDERS)}")
        if not os.environ.get(PROVIDERS[name]["key"]):
            raise SystemExit(f"FACTORY_PROVIDER={name} but {PROVIDERS[name]['key']} is not set")
        return name, PROVIDERS[name]
    for name, p in PROVIDERS.items():
        if os.environ.get(p["key"]):
            return name, p
    return None


def available():
    return provider() is not None


def complete(system, user, max_tokens=4000, timeout=180):
    """One completion: (text, model) — the model as the provider reports it."""
    found = provider()
    if not found:
        raise SystemExit("no agent key: set one of " + ", ".join(KEYS) + " on the worker (the worker owner's key, never the pool's)")
    name, p = found
    key = os.environ[p["key"]]
    model = os.environ.get("FACTORY_MODEL") or p["model"]
    base = os.environ.get(p["base_env"], p["base"]).rstrip("/")
    if p["api"] == "anthropic":
        body = {"model": model, "max_tokens": max_tokens, "system": system, "messages": [{"role": "user", "content": user}]}
        req = urllib.request.Request(base + "/v1/messages", data=json.dumps(body).encode(), method="POST",
                                     headers={"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            out = json.load(r)
        return "".join(c.get("text", "") for c in out.get("content", [])), out.get("model", model)
    body = {"model": model, "max_completion_tokens": max_tokens,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}
    req = urllib.request.Request(base + "/chat/completions", data=json.dumps(body).encode(), method="POST",
                                 headers={"authorization": "Bearer " + key, "content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        out = json.load(r)
    choices = out.get("choices") or []
    text = (choices[0].get("message") or {}).get("content") if choices else None
    return (text or ""), out.get("model", model)
