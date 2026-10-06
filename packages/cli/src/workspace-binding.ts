/**
 * Binds an Agent-Session to the workspace it was started in.
 *
 * `resolveWorkspaceName` falls back to `getCurrentWorkspace()` — a single
 * mutable selection in `~/.tedix/credentials.json` that EVERY concurrent
 * session shares. One session running `tedix login` or switching workspaces
 * rewrites it for all the others, so a second session's next bare command
 * silently resolves to a workspace nobody asked it to touch. When those two
 * workspaces belong to different organizations, that is a cross-tenant write.
 *
 * The external-agent path already fails closed when the session key is absent
 * from the drifted workspace (`currentSessionContext` throws). Two gaps remain,
 * and this module closes both:
 *
 *   1. The same session key recorded under two workspaces — resolution simply
 *      picks whichever the shared selection currently names.
 *   2. Stored-OAuth mode, where `TEDIX_AGENT_SESSION` is carried only for board
 *      traceability. There is no binding at all: step 3 of `resolveAuth` uses
 *      the selected workspace unconditionally.
 *
 * An EXPLICIT `--workspace`/`TEDIX_WORKSPACE` deliberately bypasses the check.
 * The hazard is silent redirection; naming a workspace on the command line is
 * an operator's stated intent, and pinning `-w` is the documented mitigation.
 */

export interface SessionWorkspaceBinding {
	/** Resolved Agent-Session key, or undefined when none is in play. */
	externalSessionKey: string | undefined;
	/** Workspace this invocation resolved to. */
	resolvedWorkspace: string;
	/** True when --workspace or TEDIX_WORKSPACE named it explicitly. */
	workspaceWasExplicit: boolean;
	/** Workspaces whose stored profile records this session key. */
	sessionWorkspaces: readonly string[];
}

/**
 * Returns an operator-facing refusal message, or `null` when the invocation is
 * safe. Pure, so the decision is testable without touching the credential store.
 *
 * Silent by design when nothing is recorded: a session that never ran
 * `tedix agent start` has no binding to violate, and refusing there would break
 * ordinary interactive use that happens to export a session id.
 */
export function sessionWorkspaceDrift(
	binding: SessionWorkspaceBinding,
): string | null {
	const sessionKey = binding.externalSessionKey?.trim();
	if (!sessionKey) return null;
	if (binding.workspaceWasExplicit) return null;
	if (binding.sessionWorkspaces.length === 0) return null;
	if (binding.sessionWorkspaces.includes(binding.resolvedWorkspace)) {
		return null;
	}

	const bound = [...binding.sessionWorkspaces].sort();
	const boundList = bound.map((name) => `"${name}"`).join(", ");
	return [
		`Agent-Session "${sessionKey}" was started in ${boundList}, but this command resolved to workspace "${binding.resolvedWorkspace}".`,
		"The selected workspace is shared state in ~/.tedix/credentials.json, so another session switching workspaces redirects this one — across organizations when they differ.",
		`Refusing rather than writing to "${binding.resolvedWorkspace}". Pin the target explicitly:`,
		`  tedix -w ${bound[0]} <command>`,
	].join("\n");
}
