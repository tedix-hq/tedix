#!/usr/bin/env python3
"""Opt-in turn-status reporter for local Claude Code and Codex sessions.

Records one line of state per session at turn boundaries, raises a local macOS
notification when a session needs its owner or fails, and, with a configured
CLI profile, reports the change to Tedix through a detached `tedix code` call.
It never prints to stdout, prompts, or blocks the host turn.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

REPORT_CALLABLE = "work.report_work_agent_session_status"
SESSION_KEY = re.compile(r"^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$")
PROFILE = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")
ORGANIZATION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
STATES = {"working", "needs_you", "done", "error", "ended"}
HARNESSES = {"claude-code", "codex"}
TRUTHY = {"1", "true", "yes"}
FALSY = {"0", "false", "no"}
SUMMARY_LIMIT = 160
LABEL_LIMIT = 120
INPUT_LIMIT = 8 * 1024 * 1024
LOG_LIMIT = 1024 * 1024
QUESTION = re.compile(
    r"should i|do you want|would you like|want me to|which option|please (?:confirm|approve|choose)"
    r"|let me know|need your|waiting for you",
    re.IGNORECASE,
)
SUBTITLES = {"needs_you": "Needs you", "error": "Error"}


def base_dir() -> Path:
    configured = os.environ.get("TEDIX_CONFIG_DIR")
    return Path(configured) if configured else Path.home() / ".tedix"


def state_dir() -> Path:
    return base_dir() / "agent-status"


def log(message: str) -> None:
    try:
        directory = state_dir()
        if not directory.is_dir():
            return
        path = directory / "report.log"
        if path.exists() and path.stat().st_size > LOG_LIMIT:
            os.replace(path, directory / "report.log.1")
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {message}\n")
    except OSError:
        pass


def load_config() -> dict:
    try:
        value = json.loads((base_dir() / "agent-status.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def settings():
    """Return (profile, organization, notify) when the owner opted in, else None."""
    config = load_config()
    switch = os.environ.get("TEDIX_AGENT_STATUS", "").strip().lower()
    if switch in FALSY:
        return None
    if switch not in TRUTHY and config.get("enabled") is not True:
        return None
    profile = os.environ.get("TEDIX_AGENT_STATUS_PROFILE") or config.get("profile")
    if not isinstance(profile, str) or not PROFILE.fullmatch(profile):
        profile = None
    # A Connect profile spans organizations; without one it reports to its default.
    organization = os.environ.get("TEDIX_AGENT_STATUS_ORGANIZATION") or config.get("organization")
    if not isinstance(organization, str) or not ORGANIZATION.fullmatch(organization):
        organization = None
    return profile, organization, config.get("notify") is not False


def one_line(text, limit: int) -> str:
    text = re.sub(r"[\x00-\x1f\x7f  ]+", " ", str(text))
    text = re.sub(r"\s+", " ", text).strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def strip_markdown(line: str) -> str:
    line = re.sub(r"^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)", "", line)
    line = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", line)
    line = re.sub(r"(\*\*|__|\*|_|`+|~~)", "", line)
    return line.strip()


def paragraphs(message: str) -> list[str]:
    without_code = re.sub(r"```.*?(?:```|$)|~~~.*?(?:~~~|$)", "\n\n", message, flags=re.DOTALL)
    blocks = []
    for block in re.split(r"\n\s*\n", without_code):
        lines = [strip_markdown(line) for line in block.splitlines()]
        text = " ".join(line for line in lines if line and not re.fullmatch(r"[-*_=|: ]+", line))
        if text.strip():
            blocks.append(text.strip())
    return blocks


def first_meaningful_line(message: str) -> str:
    in_fence = False
    for raw in message.splitlines():
        stripped = raw.strip()
        if stripped.startswith(("```", "~~~")):
            in_fence = not in_fence
            continue
        if in_fence or not stripped or stripped.startswith("#") or re.fullmatch(r"[-*_=|: ]+", stripped):
            continue
        line = strip_markdown(stripped)
        if line:
            return line
    return ""


def classify_stop(message) -> tuple[str, str]:
    if not isinstance(message, str) or not message.strip():
        return "done", "Turn complete"
    blocks = paragraphs(message)
    last = blocks[-1] if blocks else ""
    if last and (last.rstrip().endswith("?") or QUESTION.search(last)):
        return "needs_you", one_line(last, SUMMARY_LIMIT)
    return "done", one_line(first_meaningful_line(message) or last or "Turn complete", SUMMARY_LIMIT)


def describe_tool_input(tool_input) -> str:
    if isinstance(tool_input, dict):
        for key in ("command", "description", "file_path", "path", "url", "pattern", "query", "prompt"):
            value = tool_input.get(key)
            if isinstance(value, str) and value.strip():
                return value
        return json.dumps(tool_input, ensure_ascii=False, sort_keys=True)[:200] if tool_input else ""
    return str(tool_input or "")


def text_of(value) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        for key in ("message", "type", "error"):
            if isinstance(value.get(key), str):
                return value[key]
    return json.dumps(value, ensure_ascii=False, sort_keys=True)[:200]


def transition(event: dict):
    """Map a host event to (state, summary); None means the event is ignored."""
    name = event.get("hook_event_name")
    if name == "UserPromptSubmit":
        return "working", "Working"
    if name == "PostToolUse":
        return "working", "Working"
    if name == "PermissionRequest":
        tool = one_line(event.get("tool_name") or "tool", 60)
        detail = one_line(describe_tool_input(event.get("tool_input")), SUMMARY_LIMIT)
        return "needs_you", one_line(f"Approve {tool}: {detail}" if detail else f"Approve {tool}", SUMMARY_LIMIT)
    if name == "Notification":
        if event.get("notification_type") in {"permission_prompt", "elicitation_dialog"}:
            return "needs_you", one_line(event.get("message") or "Waiting for your input", SUMMARY_LIMIT)
        return None
    if name == "StopFailure":
        error = text_of(event.get("error")) or "Turn failed"
        details = text_of(event.get("error_details") or event.get("details"))
        return "error", one_line(f"{error}: {details}" if details else error, SUMMARY_LIMIT)
    if name == "Stop":
        if event.get("stop_hook_active"):
            return None
        return classify_stop(event.get("last_assistant_message"))
    if name == "SessionEnd":
        return "ended", one_line(f"Session ended ({event['reason']})" if isinstance(event.get("reason"), str) else "Session ended", SUMMARY_LIMIT)
    return None


def harness_of(event: dict) -> str:
    if event.get("turn_id") is not None or os.environ.get("CODEX_THREAD_ID") or os.environ.get("CODEX_SESSION_ID"):
        return "codex"
    return "claude-code"


def label_for(cwd) -> str:
    if not isinstance(cwd, str) or not cwd:
        cwd = os.getcwd()
    folder = os.path.basename(os.path.normpath(cwd)) or cwd
    try:
        result = subprocess.run(["git", "-C", cwd, "rev-parse", "--show-toplevel", "--abbrev-ref", "HEAD"],
                                capture_output=True, text=True, timeout=1, check=False,
                                stdin=subprocess.DEVNULL)
        lines = result.stdout.splitlines()
        if result.returncode == 0 and len(lines) == 2:
            folder = os.path.basename(lines[0]) or folder
            return one_line(f"{folder} · {lines[1]}", LABEL_LIMIT)
    except (OSError, subprocess.SubprocessError):
        pass
    return one_line(folder, LABEL_LIMIT)


def read_state(path: Path):
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def write_state(path: Path, record: dict) -> None:
    temporary = path.with_name(path.name + f".{os.getpid()}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        json.dump(record, handle, ensure_ascii=False)
    os.replace(temporary, path)


def detached(args: list[str]) -> None:
    log_path = state_dir() / "report.log"
    with open(log_path, "a", encoding="utf-8") as output:
        subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=output, stderr=output,
                         start_new_session=True, close_fds=True)


def notify(label: str, state: str, summary: str) -> None:
    if sys.platform != "darwin" or not shutil.which("osascript"):
        return
    # Values travel as argv, never interpolated into AppleScript source.
    detached(["osascript",
              "-e", "on run argv",
              "-e", "display notification (item 1 of argv) with title (item 2 of argv) subtitle (item 3 of argv)",
              "-e", "end run",
              summary or SUBTITLES[state], one_line(f"Tedix · {label}", LABEL_LIMIT + 10), SUBTITLES[state]])


def report_source(payload: dict) -> str:
    if (payload.get("harness") not in HARNESSES or payload.get("state") not in STATES
            or not SESSION_KEY.fullmatch(str(payload.get("sessionKey", "")))):
        raise ValueError("invalid report payload")
    fields = {
        "harness": payload["harness"],
        "sessionKey": payload["sessionKey"],
        "state": payload["state"],
        "summary": one_line(payload.get("summary") or "", SUMMARY_LIMIT),
        "label": one_line(payload.get("label") or "", LABEL_LIMIT),
    }
    return f"async () => await {REPORT_CALLABLE}({json.dumps(fields, ensure_ascii=True)})"


def report(profile: str, organization, payload: dict) -> None:
    if not PROFILE.fullmatch(profile) or not shutil.which("tedix"):
        return
    selected = ["--organization", organization] if organization else []
    detached(["tedix", "-w", profile, *selected, "code", report_source(payload)])


def run(stdin=None) -> None:
    configured = settings()
    if configured is None:
        return
    profile, organization, notifications = configured
    raw = (stdin or sys.stdin).read(INPUT_LIMIT + 1)
    if len(raw) > INPUT_LIMIT or not raw:
        return
    event = json.loads(raw)
    if not isinstance(event, dict):
        return
    session_key = event.get("session_id")
    if not isinstance(session_key, str) or not SESSION_KEY.fullmatch(session_key):
        return
    harness = harness_of(event)
    path = state_dir() / f"{harness}-{session_key}.json"
    previous = read_state(path)
    if event.get("hook_event_name") == "PostToolUse" and (previous or {}).get("state") != "needs_you":
        return
    outcome = transition(event)
    if outcome is None:
        return
    state, summary = outcome
    previous_state = (previous or {}).get("state")
    changed = previous is None or previous_state != state or (
        state in {"done", "needs_you"} and previous.get("summary") != summary)
    if not changed:
        return
    directory = state_dir()
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(directory, 0o700)
    label = label_for(event.get("cwd"))
    record = {"harness": harness, "sessionKey": session_key, "state": state, "summary": summary,
              "label": label, "cwd": event.get("cwd") if isinstance(event.get("cwd"), str) else "",
              "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    if state == "ended":
        try:
            path.unlink()
        except FileNotFoundError:
            pass
    else:
        write_state(path, record)
    if notifications and state in SUBTITLES and previous_state != state:
        try:
            notify(label, state, summary)
        except OSError as error:
            log(f"notify failed: {type(error).__name__}")
    if profile:
        report(profile, organization, record)


def main() -> None:
    try:
        run()
    except Exception as error:  # Never disturb the host turn.
        log(f"agent_status failed: {type(error).__name__}: {one_line(error, 200)}")


if __name__ == "__main__":
    main()
