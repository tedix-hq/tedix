"""Classify exchange failures for host lane brokers; callers bound the lease/retries."""
import re


def transient_session_error(message):
    # Never turn a rejected identity or expired lease into a transport retry.
    if re.search(
        r"session exchange rejected|session exchange failed \(4(?!29)\d\d"
        r"|session_ended|credential_binding_mismatch|immutable_session_conflict"
        r"|already registered with a different|has ended and cannot be reopened"
        r"|enrollment_expired|principal_inactive|principal_not_found|lease expired",
        message, re.I,
    ):
        return False
    return bool(re.search(
        # Older installed CLIs forward the edge's JSON message without status.
        # The edge emits this exact message only for 5xx, never for 401/403.
        r'"error"\s*:\s*"Session exchange failed"'
        r"|session exchange failed \(5\d\d"
        r"|\b429\b|\b503\b|rate limit exceeded|rate_limited"
        r"|Native call deadline elapsed|timeout|timed out|temporarily unavailable"
        r"|backend unavailable|SERVICE_UNAVAILABLE|grant_check_failed|ECONN|fetch failed",
        message, re.I,
    ))
