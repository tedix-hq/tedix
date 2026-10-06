#!/usr/bin/env python3
"""Opt-in decision capture for Claude Code and Codex.

`stop` runs when an agent turn ends: it opens an Interaction addressed to the
signed-in user in the bound project inbox, carrying the turn's final message.
`reply` runs when the user submits the next prompt: it answers that Interaction
with the reply, so the pair becomes one durable decision record.

Recording happens only after `tedix setup agents context enable-decision-capture`
for the bound organization. Text is redacted and bounded before it leaves this
machine and goes only to that organization. Failures are silent: capture never
blocks, delays or changes the session.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

PROFILE = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")
UUID = re.compile(r"^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$")
SCHEMA = "tedix.decision-capture.v1"
MESSAGE_LIMIT = 6000
REPLY_LIMIT = 6000
EXPIRY = timedelta(days=7)

SECRETS = [
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"), "[redacted private key]"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"), "[redacted jwt]"),
    (re.compile(r"\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}"), "[redacted key]"),
    (re.compile(r"\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}"), "[redacted token]"),
    (re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"), "[redacted key]"),
    (re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}"), "[redacted token]"),
    (re.compile(r"(?i)\b(bearer)\s+[A-Za-z0-9._~+/=-]{16,}"), r"\1 [redacted]"),
    (re.compile(r"(?i)\b([A-Z0-9_]*(?:secret|token|password|passwd|api[_-]?key|private[_-]?key)[A-Z0-9_]*)\s*([=:])\s*[\"']?[^\s\"']{6,}"), r"\1\2[redacted]"),
]

# Host re-entries that arrive through the prompt hook but were not typed by the user.
SYSTEM_PROMPT = re.compile(r"^\s*(?:<task-notification>|<system-reminder>|\[SYSTEM NOTIFICATION|<local-command-|<command-name>|<bash-(?:input|stdout)>|<codex_internal_context)")

# Coarse first-pass labels mined from historic replies; the learning pass re-reads the full pair.
CLASSES = [
    ("frustration", re.compile(r"(?i)\b(wtf|babysit|i told you|you keep|i have been repeating|still (?:not|broken|failing|wrong))\b")),
    ("correction", re.compile(r"(?i)^\s*(no[,.! ]|nope|wrong|incorrect|that'?s not|not what i)|\b(is wrong|instead of the real)\b")),
    ("challenge", re.compile(r"(?i)\b(are you sure|really\?|already done, right|why (?:are we|do we|did you|is that not)|are all .* shipped|doubt|not true)\b")),
    ("verify", re.compile(r"(?i)\b(recheck|verify|validate|prove|evidence|logs?|live (?:call|check|test)|in the browser|double.?check)\b")),
    ("plain-english", re.compile(r"(?i)\b(plain english|simple (?:terms|user stories)|user stor(?:y|ies)|explain (?:me|it|in))\b")),
    ("simplify", re.compile(r"(?i)\b(aggressive(?:ly)?|refactor|simplif|clean ?up|legacy|remove (?:dead|unused|it|this|legacy)|delete (?:it|this|dead)|leaner|less is more)\b")),
    ("fan-out", re.compile(r"(?i)\b(sub-?agents?|fan ?out|in parallel|parallel sessions|goal loop|set a (?:codex )?goal|sprint)\b")),
    ("ship", re.compile(r"(?i)\b(commit|push|deploy|ship|release)\b")),
    ("approve", re.compile(r"(?i)^\s*(make it happen|approved?|authori[sz]ed|confirmed|go ahead|ok,? lets? do it|do it|yes\b)")),
    ("status", re.compile(r"(?i)^\s*(status|what'?s next|whats next|how do we proceed|next priorit)")),
    ("continue", re.compile(r"(?i)^\s*(continue|proceed|keep going|carry on|go on|next|retry|ok(?:ay)?|yep|yeah|sure|\d+)\b")),
    ("question", re.compile(r"\?\s*$")),
]


def classify(reply):
    for label, pattern in CLASSES:
        if pattern.search(reply):
            return label
    return "instruction"


def redact(text, limit, keep="head"):
    for pattern, replacement in SECRETS:
        text = pattern.sub(replacement, text)
    text = text.strip()
    if len(text) <= limit:
        return text, True
    if keep == "tail":
        return "…" + text[-(limit - 1):], False
    return text[: limit - 1] + "…", False


def host_event():
    raw = sys.stdin.read(4194305)
    if len(raw) > 4194304:
        raise ValueError("host event too large")
    event = json.loads(raw) if raw else {}
    if not isinstance(event, dict):
        raise ValueError("unexpected host event")
    session = event.get("session_id")
    identities = [value for value in [session, os.environ.get("CODEX_SESSION_ID"), os.environ.get("CODEX_THREAD_ID")] if value is not None]
    if not identities or any(not isinstance(value, str) or not UUID.fullmatch(value) for value in identities) or len({value.lower() for value in identities}) > 1:
        raise ValueError("missing, invalid or conflicting chat identity")
    return event, identities[0].lower()


def host_name():
    codex = os.environ.get("CODEX_SESSION_ID") or os.environ.get("CODEX_THREAD_ID")
    return "codex" if codex else "claude-code"


def cli_env():
    # Interactions are addressed to the signed-in user, who alone may answer them.
    # An exported external-agent identity would create rows the user cannot resolve.
    env = dict(os.environ)
    for key in ("TEDIX_EXTERNAL_AGENT", "TEDIX_AGENT_SESSION", "TEDIX_MCP_BEARER_TOKEN", "TEDIX_MCP_API_KEY"):
        env.pop(key, None)
    return env


def read_json(args, timeout):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=False, env=cli_env())
    if result.returncode != 0:
        raise ValueError("command failed")
    value = json.loads(result.stdout)
    if not isinstance(value, dict):
        raise ValueError("unexpected response")
    return value


def state_dir():
    base = os.environ.get("TEDIX_CONFIG_DIR") or str(Path.home() / ".tedix")
    path = Path(base) / "decision-capture"
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    return path


def binding_for(session):
    binding = read_json(["tedix", "setup", "agents", "context", "show", "--json", "--session", session], 5)
    if binding.get("status") != "bound" or binding.get("decisionCapture") is not True:
        return None
    if binding.get("contextSessionId") and binding["contextSessionId"] != session:
        raise ValueError("resolved chat mismatch")
    if not PROFILE.fullmatch(str(binding.get("workspace", ""))) or not UUID.fullmatch(str(binding.get("projectId", ""))):
        raise ValueError("invalid profile or project")
    if binding.get("workItemId") is not None and not UUID.fullmatch(str(binding["workItemId"])):
        raise ValueError("invalid Work identifier")
    root = os.path.realpath(binding["root"])
    if os.path.commonpath([root, os.path.realpath(os.getcwd())]) != root:
        raise ValueError("wrong checkout")
    command = ["tedix", "-w", binding["workspace"]]
    if binding.get("organization"):
        command.extend(["--organization", binding["organization"]])
    auth = read_json(["tedix", "-w", binding["workspace"], "auth", "status", "--json"], 5)
    login = auth.get("storedLogin") or {}
    if auth.get("wouldUse") != "stored-login" or auth.get("mcpUrl") != binding.get("mcpUrl"):
        raise ValueError("decision capture requires the bound stored login")
    if binding.get("organization") and binding["organization"] not in ((login.get("accessToken") or {}).get("selectedOrganizations") or []):
        raise ValueError("organization no longer selected")
    user = login.get("loginId")
    if not isinstance(user, str) or not user or len(user) > 300:
        raise ValueError("missing signed-in user")
    binding["command"], binding["user"] = command, user
    return binding


def call(binding, verb, payload, path_id=None):
    handle, name = tempfile.mkstemp(prefix="tedix-decision-", suffix=".json", dir=state_dir())
    try:
        with os.fdopen(handle, "w") as file:
            json.dump(payload, file, ensure_ascii=False)
        args = [*binding["command"], "work", verb, *([path_id] if path_id else []), "--input", "@" + name, "--json"]
        return read_json(args, 15)
    finally:
        os.unlink(name)


def request_of(result):
    request = result.get("request", result)
    if not UUID.fullmatch(str(request.get("id", ""))) or not isinstance(request.get("version"), int):
        raise ValueError("unexpected Interaction response")
    return request


def git_branch(cwd):
    result = subprocess.run(["git", "-C", cwd, "branch", "--show-current"], capture_output=True, text=True, timeout=3, check=False)
    return result.stdout.strip()[:200] if result.returncode == 0 else ""


def on_stop(event, session, binding, state):
    message = event.get("last_assistant_message")
    if not isinstance(message, str) or not message.strip():
        return
    if event.get("background_tasks"):
        # The session will resume on its own; it is not waiting on the user yet.
        return
    previous = claim(state)
    kept = claim(early(state)) if previous and previous.get("requestId") else None
    if kept and kept.get("token") == previous.get("token"):
        # A reply whose upload failed earlier: deliver it now instead of closing.
        try:
            on_reply(session, binding, kept["prompt"], previous)
        except (ValueError, OSError, subprocess.TimeoutExpired):
            pass
    elif previous and previous.get("requestId"):
        # The agent continued without a reply (for example after background work).
        # Close the earlier turn as an automatic coordination update, never as an
        # answer: it is not the user's words and must not wake answer listeners.
        try:
            call(binding, "interaction-respond", {
                "expectedRequestVersion": previous["version"],
                "responseKind": "coordination_update",
                "body": "Closed automatically: the agent continued before a reply.",
                "resolvesRequest": True,
                "metadata": {"schema": SCHEMA, "source": "superseded", "host": host_name(), "sessionId": session},
            }, previous["requestId"])
        except (ValueError, OSError, subprocess.TimeoutExpired):
            pass
    # Mark the turn as waiting before any network call, so a reply typed while
    # the question is still being created is kept instead of lost.
    token = uuid.uuid4().hex
    early(state).unlink(missing_ok=True)
    write_state(state, {"pending": token})
    text, complete = redact(message, MESSAGE_LIMIT, keep="tail")
    cwd = event.get("cwd") if isinstance(event.get("cwd"), str) else os.getcwd()
    repository = Path(binding["root"]).name[:80]
    first = next((line.strip(" #*>-") for line in message.strip().splitlines() if line.strip(" #*>-")), "Agent turn ended")
    first, _ = redact(first, 160)
    host = host_name()
    payload = {
        "kind": "question",
        "subject": f"{repository} · {host} waiting: {first}"[:300],
        "prompt": text,
        "requestedFrom": {"type": "user", "id": binding["user"]},
        "expiresAt": (datetime.now(timezone.utc) + EXPIRY).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "metadata": {
            "schema": SCHEMA,
            "source": "agent-turn-end",
            "host": host,
            "sessionId": session,
            "turnId": str(event.get("turn_id") or "")[:100] or None,
            "repository": repository,
            "branch": git_branch(cwd),
            "messageComplete": complete,
        },
    }
    if binding.get("workItemId"):
        payload["workItemId"] = binding["workItemId"]
    else:
        payload["projectId"] = binding["projectId"]
    request = request_of(call(binding, "interaction-create", payload))
    write_state(state, {"requestId": request["id"], "version": request["version"], "token": token})
    answer_early_reply(session, binding, state)


def write_state(path, value):
    handle, name = tempfile.mkstemp(prefix=path.name, suffix=".tmp", dir=path.parent)
    with os.fdopen(handle, "w") as file:
        json.dump(value, file)
    os.replace(name, path)


def claim(path):
    # Atomic rename: exactly one hook process owns whatever the file held.
    claimed = path.with_suffix(f".{uuid.uuid4().hex}.claimed")
    try:
        os.replace(path, claimed)
    except FileNotFoundError:
        return None
    try:
        return json.loads(claimed.read_text())
    except (ValueError, OSError):
        return None
    finally:
        claimed.unlink(missing_ok=True)


def early(state):
    return state.with_suffix(".early")


def answer_early_reply(session, binding, state):
    # A reply that arrived while this turn's question was being created waits in
    # the early file. Whoever claims the finished question answers it, once.
    stored = early(state)
    if not stored.exists():
        return
    current = claim(state)
    if not current:
        return
    reply = claim(stored)
    if not reply or reply.get("token") != current.get("token"):
        write_state(state, current)
        return
    on_reply(session, binding, reply["prompt"], current)


def claim_reply(event, state):
    # Claim the open turn before any network call, so a fast next Stop cannot
    # close the request this reply is about to answer.
    prompt = event.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip() or SYSTEM_PROMPT.match(prompt):
        return None
    current = claim(state)
    if not current:
        return None
    if current.get("pending"):
        # The question is still being created: keep the reply for the turn end.
        write_state(early(state), {"token": current["pending"], "prompt": prompt})
        return "early"
    return prompt, current
def on_reply(session, binding, prompt, previous):
    text, complete = redact(prompt, REPLY_LIMIT)
    call(binding, "interaction-respond", {
        "expectedRequestVersion": previous["version"],
        "responseKind": "answer",
        "body": text,
        "resolvesRequest": True,
        "metadata": {"schema": SCHEMA, "source": "user-reply", "host": host_name(), "sessionId": session, "replyClass": classify(prompt), "replyComplete": complete},
    }, previous["requestId"])


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode not in {"stop", "reply"} or not shutil.which("tedix"):
        return
    try:
        event, session = host_event()
        state = state_dir() / f"{session}.json"
        claimed = claim_reply(event, state) if mode == "reply" else None
        if mode == "reply" and not claimed:
            return
        binding = binding_for(session)
        if not binding:
            return
        if mode == "stop":
            on_stop(event, session, binding, state)
        elif claimed == "early":
            # The turn end may have finished creating the question meanwhile.
            answer_early_reply(session, binding, state)
        else:
            prompt, current = claimed
            try:
                on_reply(session, binding, prompt, current)
            except (ValueError, OSError, subprocess.TimeoutExpired):
                # Keep the reply so the next turn end retries it.
                write_state(early(state), {"token": current.get("token"), "prompt": prompt})
                write_state(state, current)
                raise
    except (ValueError, KeyError, TypeError, AttributeError, OSError, subprocess.TimeoutExpired, json.JSONDecodeError):
        return


if __name__ == "__main__":
    main()
