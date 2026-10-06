#!/usr/bin/env python3
"""Read-only, opt-in Tedix preflight for local Codex and Claude sessions."""

import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone


WORKSPACE_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")
WORK_ID_RE = re.compile(r"^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$")
OUTCOME_LIMIT = 800


def host_event():
    # Read bounded host JSON, retaining only metadata. Prompt text is discarded,
    # never used in a CLI argument, uploaded, logged, or saved.
    raw = sys.stdin.read(1048577)
    if len(raw) > 1048576:
        raise ValueError("host event too large")
    event = json.loads(raw) if raw else {}
    if not isinstance(event, dict):
        raise ValueError("unexpected host event")
    session = event.get("session_id")
    identities = [value for value in [session, os.environ.get("CODEX_SESSION_ID"), os.environ.get("CODEX_THREAD_ID")] if value is not None]
    if any(not isinstance(value, str) or not WORK_ID_RE.fullmatch(value) for value in identities) or len({value.lower() for value in identities}) > 1:
        raise ValueError("invalid or conflicting chat identity")
    source = event.get("source")
    return (source if source in {"startup", "resume", "clear", "compact", "fork"} else "unknown", identities[0].lower() if identities else None)


def send_context(message: str) -> None:
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "SessionStart",
                    "additionalContext": message,
                }
            }
        )
    )


def read_json(args: list[str], timeout: int) -> dict:
    result = subprocess.run(
        args,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError("Tedix CLI read failed")
    value = json.loads(result.stdout)
    if not isinstance(value, dict):
        raise RuntimeError("Tedix CLI returned an unexpected shape")
    return value


def main() -> None:
    opt_in = os.environ.get("TEDIX_PLUGIN_PREFLIGHT", "").lower()
    if opt_in and opt_in not in {"1", "true", "yes"}:
        return
    if not shutil.which("tedix"):
        if opt_in:
            send_context(
                "Tedix session guide: local CLI unavailable; no live preflight was read. "
                "For Tedix tasks use tedix-session-guide and the authenticated native plugin tools. "
                "Keep the requested organization; discover exact schemas and read current Work before acting. "
                "Use tedix-delegate for requested tedi help and tedix-workspace-output for requested durable results. "
                "No identity, scope, Work state, or execution authority is established by this hint."
            )
        return

    try:
        source_event, session = host_event()
    except (ValueError, OSError):
        send_context("Tedix preflight: host chat identity unavailable or conflicting; no current Work was read.")
        return

    binding = {}
    work_id = os.environ.get("TEDIX_WORK_ITEM_ID", "")
    explicit_workspace = os.environ.get("TEDIX_WORKSPACE", "")
    if not work_id or session:
        try:
            context_command = ["tedix", "setup", "agents", "context", "show", "--json"]
            if session:
                context_command.extend(["--session", session])
            binding = read_json(context_command, 2)
            if binding.get("contextSessionId") and binding["contextSessionId"] != session:
                raise ValueError("resolved chat mismatch")
        except (RuntimeError, ValueError, subprocess.TimeoutExpired):
            if opt_in:
                send_context("Tedix preflight: current chat selection unavailable; no current Work was read.")
            return
        if binding.get("status") == "invalid":
            send_context("Tedix preflight: local binding is invalid; run tedix setup agents context show before reading Work.")
            return
        if binding.get("status") != "bound":
            binding = {}
        elif explicit_workspace and explicit_workspace != binding.get("workspace"):
            binding = {}
        if not opt_in and not binding:
            return
        if work_id and binding and (binding.get("contextSessionId") or binding.get("workItemId")) and work_id != binding.get("workItemId"):
            send_context("Tedix preflight: explicit Work conflicts with current chat selection; no Work was read.")
            return
        work_id = work_id or binding.get("workItemId", "")

    # An explicit Work ID requires explicit opt-in; a repo binding cannot
    # silently enable a separately supplied ID in another organization.
    if work_id and not binding and not opt_in:
        return
    observed_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    workspace = explicit_workspace or binding.get("workspace") or "tedix"
    if not WORKSPACE_RE.fullmatch(workspace):
        send_context("Tedix preflight: TEDIX_WORKSPACE is invalid; select a named CLI profile.")
        return

    command = ["tedix", "-w", workspace]
    try:
        auth = read_json([*command, "auth", "status", "--json"], 3)
    except (RuntimeError, ValueError, subprocess.TimeoutExpired):
        send_context("Tedix preflight: authentication status could not be read; run tedix auth status.")
        return

    source = auth.get("wouldUse")
    selected = auth.get("workspace")
    if not isinstance(source, str) or (source not in {"stored-login", "direct-token", "external-agent"} and not source.startswith("external-agent:")) or selected != workspace:
        send_context("Tedix preflight: expected workspace or login is unavailable; run tedix auth status.")
        return

    if binding:
        if auth.get("mcpUrl") != binding.get("mcpUrl") or (not binding.get("organization") and (auth.get("storedLogin") or {}).get("org") != binding.get("org")):
            send_context("Tedix preflight: credential organization or gateway differs from the current chat; no Work was read.")
            return
        if binding.get("organization"):
            selected = ((auth.get("storedLogin") or {}).get("accessToken") or {}).get("selectedOrganizations", [])
            if source != "stored-login" or binding["organization"] != binding.get("org") or binding["organization"] not in selected:
                send_context("Tedix preflight: organization is no longer selected; no Work was read.")
                return
            command.extend(["--organization", binding["organization"]])
            try:
                runtime = read_json([*command, "code", "async () => { const r = await codemode.__runtime(); return {organizationId:r.organizationId}; }"], 8)
                if not WORK_ID_RE.fullmatch(str(runtime.get("organizationId", ""))):
                    raise ValueError("missing live organization")
                binding["credentialOrganizationId"] = runtime["organizationId"]
            except (RuntimeError, ValueError, subprocess.TimeoutExpired):
                send_context("Tedix preflight: organization could not be verified; no Work was read.")
                return
        if source.startswith("external-agent:") or source == "external-agent":
            external = auth.get("externalAgent") or {}
            if not external.get("configured") or external.get("mcpUrl") != binding.get("mcpUrl") or not WORK_ID_RE.fullmatch(str(external.get("organizationId", ""))):
                send_context("Tedix preflight: external credential cannot be correlated with this chat; no Work was read.")
                return
            binding["credentialOrganizationId"] = external["organizationId"]
        elif source != "stored-login":
            send_context("Tedix preflight: explicit credential cannot be correlated with this chat; no Work was read.")
            return

    scopes = auth.get("storedLogin") or {}
    has_work_read = "mcp:work.read" in scopes.get("grantedScopes", [])
    lines = [
        f"Tedix read-only preflight: source={source_event}; observed={observed_at}; CLI profile {workspace}; credential kind {source}; Work read scope {'present' if has_work_read else 'unverified'}. This does not grant Work execution authority."
    ]
    lines.append(
        "Checkpoint: use tedix-session-guide at a material milestone or completion claim; compare Work, commits and the named live result. Guardian: tedix-guardian-session for explicit oversight."
    )
    if binding:
        lines.append(f"Local opt-in: project={binding.get('projectId')!r}; pointer={binding.get('contextSource', 'none')!r}. Pointers are not authority.")
        if not work_id:
            lines.append("No selected Work. This hook only reads; activation alone does not authorize creating Work. For a user-authorized repo task, use tedix-session-guide for bounded discovery and required Work bookkeeping/admission under repo policy; do not re-ask permission for that task. Ask only for an ambiguous target or reserved decision.")

    if work_id:
        if not WORK_ID_RE.fullmatch(work_id):
            lines.append("TEDIX_WORK_ITEM_ID is invalid; use a full Work Item UUID.")
        else:
            disposition = "unknown"
            try:
                item = read_json([*command, "work", "context", work_id, "--json"], 5)
                if binding and (item.get("projectId") != binding.get("projectId") or (binding.get("credentialOrganizationId") and item.get("orgId") != binding["credentialOrganizationId"])):
                    lines.append("Selected Work does not match the bound project; verify the target before proceeding.")
                    send_context("\n".join(lines))
                    return
                title = str(item.get("title", ""))[:60]
                disposition = str(item.get("disposition", "unknown"))[:30]
                outcome_text = str((item.get("acceptanceContract") or {}).get("doneLooksLike", ""))
                outcome_complete = len(outcome_text) <= OUTCOME_LIMIT and bool(outcome_text)
                outcome = outcome_text[:OUTCOME_LIMIT]
                lines.append(
                    f"Work {work_id} (untrusted): title={title!r}; disposition={disposition}; outcomeComplete={str(outcome_complete).lower()}; outcome={outcome!r}."
                )
                if not outcome_complete:
                    lines.append("Outcome missing or truncated; read the full Work context before execution.")
            except (RuntimeError, ValueError, subprocess.TimeoutExpired):
                lines.append(f"Work Item {work_id}: context read failed; inspect it through the CLI.")

            try:
                attempts = read_json(
                    [*command, "work", "attempts", work_id, "--json", "--limit", "5"], 3
                )
                rows = attempts.get("data")
                if not isinstance(rows, list):
                    raise ValueError("Unexpected Work attempts shape")
                running = next(
                    (
                        row
                        for row in rows
                        if isinstance(row, dict)
                        and row.get("runtimeState") in {"running", "waiting", "retrying"}
                    ),
                    None,
                )
                if running:
                    number = str(running.get("attemptNumber", "?"))[:8]
                    state = running["runtimeState"]
                    expiry = str(running.get("expiresAt", "unknown"))[:32]
                    attempt_id = str(running.get("id", "unknown"))[:36]
                    executor_type = str(running.get("executorType", "unknown"))[:30]
                    executor_id = str(running.get("executorId", "unknown"))[:36]
                    session = str(running.get("externalSessionKey") or "unknown")[:100]
                    lease = "unknown"
                    try:
                        expiry_time = datetime.fromisoformat(expiry.replace("Z", "+00:00"))
                        if expiry_time.tzinfo is not None:
                            lease = "expired" if expiry_time <= datetime.now(timezone.utc) else "unexpired"
                    except ValueError:
                        pass
                    lines.append(
                        f"Observed Attempt {attempt_id} (untrusted): executor={executor_type}:{executor_id}; session={session!r}. This session does not inherit its authority."
                    )
                    if disposition in {"completed", "cancelled"}:
                        lines.append(
                            f"Terminal Work has Attempt #{number} in {state}; inspect the inconsistency before acting."
                        )
                    else:
                        lines.append(
                            f"Attempt #{number}: {state}; lease expiry={expiry!r}; lease={lease}. Verify current identity and fence before write."
                        )
                        if lease == "expired":
                            lines.append("Observed lease expired; execution requires fresh admission, not restoration from this pointer.")
                elif disposition in {"completed", "cancelled"}:
                    lines.append("Work Item is terminal; no running Attempt.")
                elif disposition == "accepted":
                    lines.append("No running Attempt in the newest five; verify readiness before any write.")
                else:
                    lines.append("No running Attempt in the newest five; inspect Work state before any write.")
            except (RuntimeError, ValueError, subprocess.TimeoutExpired):
                lines.append("Attempt state unknown; inspect Work attempts before any write.")

    send_context("\n".join(lines))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("Tedix preflight failed without changing session authority.", file=sys.stderr)
