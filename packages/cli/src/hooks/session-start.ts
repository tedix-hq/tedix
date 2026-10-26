/** Read-only, opt-in Tedix preflight for local Codex and Claude sessions. */
import {
	closeSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	statSync,
} from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { claudeConfigDirectory } from "../claude-lane-thread";
import { unpinnedModelVersion } from "../external-agent";
import { harnessOf } from "./agent-status";
import { clearDelivery } from "./context-delivery";
import { repositoryName } from "./decision-capture";
import {
	gatewayCode,
	openRequestLines,
	workBoundaryCode,
	workBoundaryLine,
} from "./prompt-context";
import { needsYou } from "./needs-you";
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
	const cloud =
		deps.env.CLAUDE_CODE_REMOTE === "true" ||
		deps.env.TEDIX_CLOUD_SESSION === "1";
	if (!cloud) return sessionStart(deps);
	let startup = false;
	try {
		startup = JSON.parse(deps.stdin || "{}").source === "startup";
	} catch {
		/* The normal preflight reports malformed input. */
	}
	if (!startup) return sessionStart(deps);
	let emitted = false;
	const notice =
		"Cloud session: direct pushes to the managed source repository require the Mac supervisor's private pre-push rules. Validate locally, then use tedix commit-handoff submit for the Work-linked, checksummed commit transfer. Do not bypass gates or ask the owner to relay the commit.";
	await sessionStart({
		...deps,
		write: (line) => {
			const output = JSON.parse(line);
			output.hookSpecificOutput.additionalContext = `${notice}\n${output.hookSpecificOutput.additionalContext}`;
			emitted = true;
			deps.write(JSON.stringify(output));
		},
	});
	if (!emitted)
		deps.write(
			JSON.stringify({
				hookSpecificOutput: {
					hookEventName: "SessionStart",
					additionalContext: notice,
				},
			}),
		);
}

async function sessionStart(deps: HookDeps): Promise<void> {
	const { env, read } = deps;
	const now = deps.now ?? (() => new Date());
	// Opened before the Work preflight, so its line survives any early return.
	let agentLine: string | undefined;
	let stopEvent = false;
	const send = (message: string) =>
		deps.write(
			JSON.stringify(
				stopEvent
					? { systemMessage: message }
					: {
							hookSpecificOutput: {
								hookEventName: "SessionStart",
								additionalContext: [agentLine, message]
									.filter(Boolean)
									.join("\n"),
							},
						},
			),
		);

	const optIn = (env.TEDIX_PLUGIN_PREFLIGHT ?? "").toLowerCase();
	if (optIn && !["1", "true", "yes"].includes(optIn)) return;

	let sourceEvent: string;
	let session: string | undefined;
	let event: JsonObject;
	try {
		const parsed = hostEvent(deps.stdin, env, EVENT_LIMIT);
		session = parsed.session;
		event = parsed.event;
		stopEvent = event.hook_event_name === "Stop";
		const source = parsed.event.source;
		sourceEvent =
			typeof source === "string" && SOURCES.has(source) ? source : "unknown";
	} catch {
		send(
			"Tedix preflight: host chat identity unavailable or conflicting; no current Work was read.",
		);
		return;
	}

	if (session && ["startup", "clear", "compact", "fork"].includes(sourceEvent))
		clearDelivery(env, session);

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
	// The model opens the session through its own connector, so the session is
	// verified against the login that makes the audited calls, and this hook
	// makes no slow gateway call for it.
	const tuple = session ? hostTuple(event, env, session, deps.cwd) : undefined;
	if (tuple)
		agentLine = `Tedix Agent-Session: before your first Tedix code call, call ${OWNER_HOST_TOOL} with ${JSON.stringify(tuple)}, then pass the returned session.id as agentSessionId on every Tedix code call; if it fails, continue without it.`;
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
				(!selected.includes(binding.organization) && !binding.scopeRoutingHint)
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
	if (stopEvent && !workId) return;
	const lines = [
		`Tedix read-only preflight: source=${sourceEvent}; observed=${observedAt}; CLI profile ${workspace}; credential kind ${source}; Work read scope ${hasWorkRead ? "present" : "unverified"}. This does not grant Work execution authority.`,
		"Checkpoint: use tedix-session-guide at a material milestone or completion claim; compare Work, commits and the named live result. Guardian: tedix-guardian-session for explicit oversight.",
	];
	if (bound) {
		lines.push(
			`Local opt-in: project=${JSON.stringify(binding.projectId ?? null)}; pointer=${JSON.stringify(binding.contextSource ?? "none")}. Pointers are not authority.`,
			binding.decisionCapture === true
				? "Decision capture: on."
				: "Decision capture: OFF for this organization; no turns or replies are recorded (tedix setup agents context enable-decision-capture turns it on).",
		);
		if (!workId)
			lines.push(
				`No selected Work. Before you change files for a user-authorized repo task, claim its Work Item: find it (tedix work find "<words>" -w ${workspace}) or create it (tedix work create "<title>" --kind coding --project ${binding.projectId ?? "<project>"} -w ${workspace}), then tedix work start <id> -w ${workspace}. Every commit carries Work-Item: <id>; the pre-push gate rejects a commit without it. This hook only reads; do not re-ask permission for that task. Ask only for an ambiguous target or reserved decision.`,
			);
	}

	if (workId) {
		if (!UUID.test(workId)) {
			lines.push("TEDIX_WORK_ITEM_ID is invalid; use a full Work Item UUID.");
		} else {
			let disposition = "unknown";
			try {
				const boundary = await read(
					[...command, "code", workBoundaryCode(workId)],
					6500,
				);
				const item = boundary.item;
				if (!isObject(item)) throw new Error("Unexpected Work boundary shape");
				if (
					bound &&
					(item.projectId !== binding.projectId ||
						(binding.credentialOrganizationId &&
							item.organizationId !== binding.credentialOrganizationId))
				) {
					lines.push(
						"Selected Work does not match the bound project; verify the target before proceeding.",
					);
					send(lines.join("\n"));
					return;
				}
				lines.push(workBoundaryLine(boundary, now()));
				if (stopEvent) {
					send(lines.at(-1)!);
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

	if (
		bound &&
		binding.decisionCapture === true &&
		session &&
		source === "stored-login"
	) {
		try {
			const data = await read(
				[
					...command,
					"code",
					gatewayCode(
						{ ledger: { session, projectId: binding.projectId } },
						undefined,
						[],
						true,
					),
				],
				6500,
			);
			if (isObject(data.requests)) data.requests.hideStale = true;
			lines.push(
				...openRequestLines(
					data,
					{
						session,
						projectId: binding.projectId,
						repository: repositoryName(binding.origin, binding.root).slice(
							0,
							200,
						),
					},
					now(),
				),
			);
		} catch {
			/* Omit unavailable context. */
		}
	}
	const needs = bound
		? await needsYou(deps, binding, auth, command, session)
		: undefined;
	send([needs?.text, ...lines].filter(Boolean).join("\n"));
	needs?.delivered();
}

/** Only an ISO timestamp with an explicit zone can claim a lease state. */
function leaseState(expiry: string, now: Date): string {
	if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(expiry))
		return "unknown";
	const time = Date.parse(expiry);
	if (Number.isNaN(time)) return "unknown";
	return time <= now.getTime() ? "expired" : "unexpired";
}

const OWNER_HOST_TOOL = "start_external_agent_session_for_host";
const OWNER_HOST_HARNESSES = new Set(["claude-code", "codex", "opencode"]);
const TUPLE_TOKEN = /^[A-Za-z0-9][\w.:/@+[\]-]*$/;
const SESSION_RECORD_LIMIT = 65_536;
const SESSION_RECORDS = 512;

export interface OwnerHostTuple {
	harness: string;
	externalSessionKey: string;
	harnessVersion: string;
	modelProvider: string;
	modelId: string;
	modelVersion: string;
}

function token(value: unknown, max: number): string | undefined {
	return typeof value === "string" &&
		value.length <= max &&
		TUPLE_TOKEN.test(value)
		? value
		: undefined;
}

/**
 * This chat's native host/model tuple, read only from the host itself: the
 * event's model, and the harness version and provider the host recorded.
 * Undefined when any part is unknown, so no session is opened on a guess.
 */
export function hostTuple(
	event: JsonObject,
	env: NodeJS.ProcessEnv,
	session: string,
	cwd: string,
): OwnerHostTuple | undefined {
	const harness = harnessOf(event, env);
	const modelId = token(event.model, 200);
	if (!OWNER_HOST_HARNESSES.has(harness) || !modelId) return undefined;
	let harnessVersion: string | undefined;
	let modelProvider: string | undefined;
	if (harness === "opencode") {
		harnessVersion = token(event.harness_version, 120);
		modelProvider = token(event.model_provider, 120);
	} else if (harness === "codex") {
		const meta = codexSessionMeta(event, session);
		harnessVersion = token(env.CODEX_VERSION, 120) ?? meta.cliVersion;
		modelProvider = meta.modelProvider;
	} else {
		harnessVersion = claudeSessionVersion(env, cwd, session);
		// The provider every native Claude Code model is served by (as lanes record).
		modelProvider = "anthropic";
	}
	if (!harnessVersion || !modelProvider) return undefined;
	return {
		harness,
		// Its own key: `<harness>:<chat id>` belongs to this chat's machine
		// credential (`tedix agent start`), which a shared key would lock out.
		externalSessionKey: `${harness}:${session}:owner-host`,
		harnessVersion,
		modelProvider,
		modelId,
		modelVersion: unpinnedModelVersion(harness, harnessVersion, modelId),
	};
}

/** The CLI version and model provider Codex wrote at the top of this chat's rollout. */
function codexSessionMeta(
	event: JsonObject,
	session: string,
): { cliVersion?: string; modelProvider?: string } {
	const transcript = event.transcript_path;
	if (
		typeof transcript !== "string" ||
		!isAbsolute(transcript) ||
		!basename(transcript).startsWith("rollout-") ||
		!basename(transcript).toLowerCase().includes(session)
	)
		return {};
	let head = "";
	try {
		const fd = openSync(transcript, "r");
		try {
			const buffer = Buffer.alloc(16_384);
			head = buffer
				.subarray(0, readSync(fd, buffer, 0, buffer.length, 0))
				.toString("utf8");
		} finally {
			closeSync(fd);
		}
	} catch {
		return {};
	}
	const first = head.split("\n", 1)[0] ?? "";
	if (!first.includes('"type":"session_meta"')) return {};
	// Only the fixed fields before the instructions text; never prompt content.
	const cut = first.indexOf('"base_instructions"');
	const meta = cut >= 0 ? first.slice(0, cut) : first;
	const field = (name: string) =>
		token(new RegExp(`"${name}":"([^"\\\\]{1,120})"`).exec(meta)?.[1], 120);
	return {
		cliVersion: field("cli_version"),
		modelProvider: field("model_provider"),
	};
}

/** The version Claude Code recorded for this session in its own session registry. */
function claudeSessionVersion(
	env: NodeJS.ProcessEnv,
	cwd: string,
	session: string,
): string | undefined {
	const directory = join(claudeConfigDirectory(env, cwd), "sessions");
	const versions = new Set<string>();
	try {
		const files = readdirSync(directory)
			.filter((name) => name.endsWith(".json"))
			.slice(0, SESSION_RECORDS);
		for (const name of files) {
			try {
				const path = join(directory, name);
				if (statSync(path).size > SESSION_RECORD_LIMIT) continue;
				const record: unknown = JSON.parse(readFileSync(path, "utf8"));
				if (
					isObject(record) &&
					typeof record.sessionId === "string" &&
					record.sessionId.toLowerCase() === session
				) {
					const version = token(record.version, 120);
					if (version) versions.add(version);
				}
			} catch {
				/* Skip an unreadable record. */
			}
		}
	} catch {
		return undefined;
	}
	// Two live processes disagreeing on this chat's version name no version.
	return versions.size === 1 ? [...versions][0] : undefined;
}
