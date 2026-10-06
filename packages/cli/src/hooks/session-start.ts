/** Read-only, opt-in Tedix preflight for local Codex and Claude sessions. */
import {
	type HookDeps,
	type JsonObject,
	hostEvent,
	isObject,
	isoSeconds,
	ORGANIZATION_PROBE,
	PROFILE,
	UUID,
} from "./hook-io";

const OUTCOME_LIMIT = 800;
const EVENT_LIMIT = 1_048_576;
const SOURCES = new Set(["startup", "resume", "clear", "compact", "fork"]);
const AUTH_SOURCES = new Set([
	"stored-login",
	"direct-token",
	"external-agent",
]);

export async function runSessionStart(deps: HookDeps): Promise<void> {
	const { env, read } = deps;
	const now = deps.now ?? (() => new Date());
	const send = (message: string) =>
		deps.write(
			JSON.stringify({
				hookSpecificOutput: {
					hookEventName: "SessionStart",
					additionalContext: message,
				},
			}),
		);

	const optIn = (env.TEDIX_PLUGIN_PREFLIGHT ?? "").toLowerCase();
	if (optIn && !["1", "true", "yes"].includes(optIn)) return;

	let sourceEvent: string;
	let session: string | undefined;
	try {
		const parsed = hostEvent(deps.stdin, env, EVENT_LIMIT);
		session = parsed.session;
		const source = parsed.event.source;
		sourceEvent =
			typeof source === "string" && SOURCES.has(source) ? source : "unknown";
	} catch {
		send(
			"Tedix preflight: host chat identity unavailable or conflicting; no current Work was read.",
		);
		return;
	}

	let binding: JsonObject = {};
	let workId = env.TEDIX_WORK_ITEM_ID ?? "";
	const explicitWorkspace = env.TEDIX_WORKSPACE ?? "";
	if (!workId || session) {
		try {
			const contextCommand = ["setup", "agents", "context", "show", "--json"];
			if (session) contextCommand.push("--session", session);
			binding = await read(contextCommand, 2000);
			if (binding.contextSessionId && binding.contextSessionId !== session)
				throw new Error("resolved chat mismatch");
		} catch {
			if (optIn)
				send(
					"Tedix preflight: current chat selection unavailable; no current Work was read.",
				);
			return;
		}
		if (binding.status === "invalid") {
			send(
				"Tedix preflight: local binding is invalid; run tedix setup agents context show before reading Work.",
			);
			return;
		}
		if (binding.status !== "bound") binding = {};
		else if (explicitWorkspace && explicitWorkspace !== binding.workspace)
			binding = {};
		const bound = Object.keys(binding).length > 0;
		if (!optIn && !bound) return;
		if (
			workId &&
			bound &&
			(binding.contextSessionId || binding.workItemId) &&
			workId !== binding.workItemId
		) {
			send(
				"Tedix preflight: explicit Work conflicts with current chat selection; no Work was read.",
			);
			return;
		}
		workId = workId || binding.workItemId || "";
	}
	const bound = Object.keys(binding).length > 0;

	// An explicit Work ID requires explicit opt-in; a repo binding cannot
	// silently enable a separately supplied ID in another organization.
	if (workId && !bound && !optIn) return;
	const observedAt = isoSeconds(now());
	const workspace = explicitWorkspace || binding.workspace || "tedix";
	if (!PROFILE.test(workspace)) {
		send(
			"Tedix preflight: TEDIX_WORKSPACE is invalid; select a named CLI profile.",
		);
		return;
	}

	const command = ["-w", workspace];
	let auth: JsonObject;
	try {
		auth = await read([...command, "auth", "status", "--json"], 3000);
	} catch {
		send(
			"Tedix preflight: authentication status could not be read; run tedix auth status.",
		);
		return;
	}

	const source = auth.wouldUse;
	if (
		typeof source !== "string" ||
		(!AUTH_SOURCES.has(source) && !source.startsWith("external-agent:")) ||
		auth.workspace !== workspace
	) {
		send(
			"Tedix preflight: expected workspace or login is unavailable; run tedix auth status.",
		);
		return;
	}

	if (bound) {
		if (
			auth.mcpUrl !== binding.mcpUrl ||
			(!binding.organization && auth.storedLogin?.org !== binding.org)
		) {
			send(
				"Tedix preflight: credential organization or gateway differs from the current chat; no Work was read.",
			);
			return;
		}
		if (binding.organization) {
			const selected =
				auth.storedLogin?.accessToken?.selectedOrganizations ?? [];
			if (
				source !== "stored-login" ||
				binding.organization !== binding.org ||
				!Array.isArray(selected) ||
				!selected.includes(binding.organization)
			) {
				send(
					"Tedix preflight: organization is no longer selected; no Work was read.",
				);
				return;
			}
			command.push("--organization", binding.organization);
			try {
				const runtime = await read(
					[...command, "code", ORGANIZATION_PROBE],
					8000,
				);
				if (!UUID.test(String(runtime.organizationId ?? "")))
					throw new Error("missing live organization");
				binding.credentialOrganizationId = runtime.organizationId;
			} catch {
				send(
					"Tedix preflight: organization could not be verified; no Work was read.",
				);
				return;
			}
		}
		if (source.startsWith("external-agent:") || source === "external-agent") {
			const external = isObject(auth.externalAgent) ? auth.externalAgent : {};
			if (
				!external.configured ||
				external.mcpUrl !== binding.mcpUrl ||
				!UUID.test(String(external.organizationId ?? ""))
			) {
				send(
					"Tedix preflight: external credential cannot be correlated with this chat; no Work was read.",
				);
				return;
			}
			binding.credentialOrganizationId = external.organizationId;
		} else if (source !== "stored-login") {
			send(
				"Tedix preflight: explicit credential cannot be correlated with this chat; no Work was read.",
			);
			return;
		}
	}

	const scopes = auth.storedLogin?.grantedScopes;
	const hasWorkRead = Array.isArray(scopes) && scopes.includes("mcp:work.read");
	const lines = [
		`Tedix read-only preflight: source=${sourceEvent}; observed=${observedAt}; CLI profile ${workspace}; credential kind ${source}; Work read scope ${hasWorkRead ? "present" : "unverified"}. This does not grant Work execution authority.`,
		"Checkpoint: use tedix-session-guide at a material milestone or completion claim; compare Work, commits and the named live result. Guardian: tedix-guardian-session for explicit oversight.",
	];
	if (bound) {
		lines.push(
			`Local opt-in: project=${JSON.stringify(binding.projectId ?? null)}; pointer=${JSON.stringify(binding.contextSource ?? "none")}. Pointers are not authority.`,
		);
		if (!workId)
			lines.push(
				"No selected Work. This hook only reads; activation alone does not authorize creating Work. For a user-authorized repo task, use tedix-session-guide for bounded discovery and required Work bookkeeping/admission under repo policy; do not re-ask permission for that task. Ask only for an ambiguous target or reserved decision.",
			);
	}

	if (workId) {
		if (!UUID.test(workId)) {
			lines.push("TEDIX_WORK_ITEM_ID is invalid; use a full Work Item UUID.");
		} else {
			let disposition = "unknown";
			try {
				const item = await read(
					[...command, "work", "context", workId, "--json"],
					5000,
				);
				if (
					bound &&
					(item.projectId !== binding.projectId ||
						(binding.credentialOrganizationId &&
							item.orgId !== binding.credentialOrganizationId))
				) {
					lines.push(
						"Selected Work does not match the bound project; verify the target before proceeding.",
					);
					send(lines.join("\n"));
					return;
				}
				const title = String(item.title ?? "").slice(0, 60);
				disposition = String(item.disposition ?? "unknown").slice(0, 30);
				const outcomeText = String(
					item.acceptanceContract?.doneLooksLike ?? "",
				);
				const outcomeComplete =
					outcomeText.length <= OUTCOME_LIMIT && Boolean(outcomeText);
				const outcome = outcomeText.slice(0, OUTCOME_LIMIT);
				lines.push(
					`Work ${workId} (untrusted): title=${JSON.stringify(title)}; disposition=${disposition}; outcomeComplete=${outcomeComplete}; outcome=${JSON.stringify(outcome)}.`,
				);
				if (!outcomeComplete)
					lines.push(
						"Outcome missing or truncated; read the full Work context before execution.",
					);
			} catch {
				lines.push(
					`Work Item ${workId}: context read failed; inspect it through the CLI.`,
				);
			}

			try {
				const attempts = await read(
					[...command, "work", "attempts", workId, "--json", "--limit", "5"],
					3000,
				);
				const rows = attempts.data;
				if (!Array.isArray(rows))
					throw new Error("Unexpected Work attempts shape");
				const running = rows.find(
					(row) =>
						isObject(row) &&
						["running", "waiting", "retrying"].includes(row.runtimeState),
				) as JsonObject | undefined;
				const terminal = ["completed", "cancelled"].includes(disposition);
				if (running) {
					const number = String(running.attemptNumber ?? "?").slice(0, 8);
					const state = running.runtimeState;
					const expiry = String(running.expiresAt ?? "unknown").slice(0, 32);
					const attemptId = String(running.id ?? "unknown").slice(0, 36);
					const executorType = String(running.executorType ?? "unknown").slice(
						0,
						30,
					);
					const executorId = String(running.executorId ?? "unknown").slice(
						0,
						36,
					);
					const owner = String(running.externalSessionKey || "unknown").slice(
						0,
						100,
					);
					lines.push(
						`Observed Attempt ${attemptId} (untrusted): executor=${executorType}:${executorId}; session=${JSON.stringify(owner)}. This session does not inherit its authority.`,
					);
					if (terminal) {
						lines.push(
							`Terminal Work has Attempt #${number} in ${state}; inspect the inconsistency before acting.`,
						);
					} else {
						const lease = leaseState(expiry, now());
						lines.push(
							`Attempt #${number}: ${state}; lease expiry=${JSON.stringify(expiry)}; lease=${lease}. Verify current identity and fence before write.`,
						);
						if (lease === "expired")
							lines.push(
								"Observed lease expired; execution requires fresh admission, not restoration from this pointer.",
							);
					}
				} else if (terminal) {
					lines.push("Work Item is terminal; no running Attempt.");
				} else if (disposition === "accepted") {
					lines.push(
						"No running Attempt in the newest five; verify readiness before any write.",
					);
				} else {
					lines.push(
						"No running Attempt in the newest five; inspect Work state before any write.",
					);
				}
			} catch {
				lines.push(
					"Attempt state unknown; inspect Work attempts before any write.",
				);
			}
		}
	}

	send(lines.join("\n"));
}

/** Only an ISO timestamp with an explicit zone can claim a lease state. */
function leaseState(expiry: string, now: Date): string {
	if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(expiry))
		return "unknown";
	const time = Date.parse(expiry);
	if (Number.isNaN(time)) return "unknown";
	return time <= now.getTime() ? "expired" : "unexpired";
}
