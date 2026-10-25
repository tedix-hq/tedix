import {
	externalAgentProfileSlot,
	readExternalAgentProfile,
} from "./external-agent-store";
import { nearestHostHarness } from "./host-ancestry";
import type { WorkAttemptKey } from "./work-attempt-store";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import type { WorkContext } from "./work";

// Any non-zero exit signals "the board operation did not succeed" — matching the
// CLI's failed/canceled → 2 convention so automation can branch on it.
export const WORK_EXIT_FAIL = 2;

export const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface BoardError {
	/** Server-provided retry delay, in seconds. */
	retryAfter?: number;
	code?: string;
	status?: number;
	message: string;
}

export interface BoardResult {
	value: unknown;
	error?: BoardError;
}

export function isUuid(value: string): boolean {
	return UUID_RE.test(value.trim());
}

/** Aggregate native catalog namespaces sanitize slug → `[^a-zA-Z0-9_]` = `_`. */
export function tediNamespace(slug: string): string {
	return slug.trim().replace(/[^a-zA-Z0-9_]/g, "_");
}

export function identityBoundCallable(
	as: string | undefined,
	nativeCallable: string,
	tediTool: string,
): string {
	if (!as) return nativeCallable;
	if (isUuid(as)) {
		throw new Error("--as requires a hydrated tedi slug, not a UUID");
	}
	return `${tediNamespace(as)}.${tediTool}`;
}

export function mutationCallable(
	as: string | undefined,
	nativeCallable: string,
): string {
	if (as?.trim()) {
		throw new Error(
			"--as selects a read-only tedi namespace and cannot authorize work mutations; authenticate as that tedi or use an explicit delegated credential",
		);
	}
	return nativeCallable;
}

export function workAttemptKey(
	ctx: WorkContext,
	workItemId: string,
	serverAgentSession?: string,
): WorkAttemptKey {
	assertUnambiguousSession(resolveAgentSession(ctx.work.session));
	const agentSession =
		serverAgentSession?.trim() ||
		resolveAgentSession(ctx.work.session)?.session;
	return {
		workspace: ctx.workspace,
		actor: ctx.work.as?.trim() || "credential",
		agentSession: agentSession ?? "unidentified-session",
		workItemId,
	};
}

export function cachedAttemptId(
	ctx: WorkContext,
	workItemId: string,
): string | null {
	return ctx.attemptStore.get(workAttemptKey(ctx, workItemId));
}

export function missingAttemptResult(workItemId: string): BoardResult {
	return {
		value: undefined,
		error: {
			code: "STALE_ATTEMPT",
			status: 409,
			message: `No active attempt is cached for ${workItemId}. Start an attempt in this workspace before heartbeating, settling, or submitting evidence.`,
		},
	};
}

function envTrim(name: string): string | undefined {
	const v = process.env[name];
	return v?.trim() ? v.trim() : undefined;
}

interface AgentSession {
	/** `<harness>:<id>` — the traceable session key stored on board writes. */
	session: string;
	/** Harness family: claude-code, codex, cursor, or cli. */
	harness: string;
	/** True when the id is a best-effort shell fallback, not a durable session id. */
	derived: boolean;
	ambiguousNative?: string[];
}

const KNOWN_AGENT_HARNESSES = new Set([
	"claude-code",
	"codex",
	"devin",
	"cursor",
	"opencode",
	"cli",
]);

/** Shape-only pre-push boundary; the server certifies the opaque exact value. */
export const GATE_SESSION_KEY =
	/^(?=.{3,300}$)[a-z0-9-]+:[^\t\r\n:][^\t\r\n]*$/i;

function harnessFromSessionPrefix(session: string): string | undefined {
	const separator = session.indexOf(":");
	if (separator <= 0) return undefined;
	const prefix = session.slice(0, separator);
	return KNOWN_AGENT_HARNESSES.has(prefix) ? prefix : undefined;
}

/**
 * Resolve the calling agent SESSION identity so every board write traces to one
 * of the parallel harness runs, not merely to a role+model. This is the fix for
 * the session-identity blind spot: the board previously captured *who* (tedi
 * role) and the commit captured *what model*, but not *which of the ~10 live
 * Codex/Claude sessions* did the work. Resolution order:
 *   1. `--session <id>`            explicit flag (wins)
 *   2. `TEDIX_AGENT_SESSION`       documented per-session env override (any harness)
 *   3. harness-native session env  CLAUDE_CODE_SESSION_ID / CODEX_* / CURSOR_*
 *   4. best-effort shell fallback  harness=cli, id from PPID — flagged `derived`
 *      so a consumer never mistakes an auto-grouped shell id for a durable one.
 */
export function resolveAgentSession(
	explicit?: string,
): AgentSession | undefined {
	const claudeSession = envTrim("CLAUDE_CODE_SESSION_ID");
	const devinSession = envTrim("DEVIN_SESSION_ID");
	const codexSession =
		envTrim("CODEX_SESSION_ID") ?? envTrim("CODEX_THREAD_ID");
	const cursorSession = envTrim("CURSOR_TRACE_ID");
	// A native session ID names its own harness. Codex launched from a Claude
	// Code shell inherits CLAUDECODE but carries its own CODEX_THREAD_ID; the
	// marker-only checks must not relabel that thread as a claude-code session
	// (agent start keyed it codex:<id>, so status and finish then missed it).
	const harness = devinSession
		? "devin"
		: claudeSession
			? "claude-code"
			: codexSession
				? "codex"
				: cursorSession
					? "cursor"
					: envTrim("CLAUDECODE")
						? "claude-code"
						: envTrim("CODEX_SANDBOX") || envTrim("CODEX_HOME")
							? "codex"
							: envTrim("CURSOR_AGENT")
								? "cursor"
								: "cli";

	const explicitId = explicit?.trim();
	if (explicitId) {
		const session = explicitId.includes(":")
			? explicitId
			: `${harness}:${explicitId}`;
		return {
			session,
			harness: harnessFromSessionPrefix(session) ?? harness,
			derived: false,
		};
	}

	const environmentId = envTrim("TEDIX_AGENT_SESSION");
	if (environmentId) {
		const session = environmentId.includes(":")
			? environmentId
			: `${harness}:${environmentId}`;
		return {
			session,
			harness: harnessFromSessionPrefix(session) ?? harness,
			derived: false,
		};
	}

	const candidates = [
		["devin", devinSession],
		["claude-code", claudeSession],
		["codex", codexSession],
		["cursor", cursorSession],
	]
		.filter(([, id]) => Boolean(id))
		.map(([name, id]) => `${name}:${id}`);
	if (candidates.length > 1) {
		// A launched child inherits its launcher's id; the nearer host owns us.
		const host = nearestHostHarness();
		const own = host
			? candidates.filter((candidate) => candidate.startsWith(`${host}:`))
			: [];
		if (host && own.length === 1)
			return { session: own[0]!, harness: host, derived: false };
		return {
			session: `cli:sh${process.ppid}`,
			harness: "cli",
			derived: true,
			ambiguousNative: candidates,
		};
	}

	const native = devinSession ?? claudeSession ?? codexSession ?? cursorSession;
	if (native)
		return { session: `${harness}:${native}`, harness, derived: false };

	const ppid = typeof process.ppid === "number" ? process.ppid : 0;
	if (ppid) return { session: `${harness}:sh${ppid}`, harness, derived: true };
	return undefined;
}

export function assertUnambiguousSession(
	session: AgentSession | undefined,
): void {
	if (session?.ambiguousNative?.length) {
		throw new Error(
			`Ambiguous native Agent-Session: ${session.ambiguousNative.join(", ")}. Set TEDIX_AGENT_SESSION=<harness>:<id> or use --session to select the current session.`,
		);
	}
}

/**
 * The `metadata` object to stamp onto a board write so the session is queryable.
 * Undefined only when no session can be derived at all (then writes stay clean).
 */
function sessionMetadata(
	ctx: WorkContext,
): Record<string, unknown> | undefined {
	const s = resolveAgentSession(ctx.work.session);
	assertUnambiguousSession(s);
	if (!s) return undefined;
	return {
		agentSession: s.session,
		agentHarness: s.harness,
		...(s.derived ? { agentSessionDerived: true } : {}),
	};
}

export function isDetectedExternalHarness(
	session: AgentSession | undefined,
): boolean {
	return Boolean(session && session.harness !== "cli");
}

export function oauthHarnessGuard(ctx: WorkContext): BoardError | undefined {
	const session = resolveAgentSession(ctx.work.session);
	if (
		ctx.authSource?.startsWith("stored-login:") &&
		isDetectedExternalHarness(session) &&
		!ctx.work.operatorOverride
	) {
		return {
			code: "EXTERNAL_AGENT_IDENTITY_REQUIRED",
			status: 409,
			message:
				"A coding harness cannot exercise owner-only Work Item authority with the owner's OAuth identity. Run `tedix agent start`, export TEDIX_EXTERNAL_AGENT, and start the attempt with that verified credential. An operator may deliberately bypass this boundary with --operator-override; the override is written to the Work Item thread.",
		};
	}
	return undefined;
}

/**
 * Accept and complete are owner actions. A harness that exported
 * TEDIX_EXTERNAL_AGENT for its Attempt calls them as that agent and gets a bare
 * FORBIDDEN; name the owner login as the next step.
 */
export function ownerActionHint(ctx: WorkContext, error: BoardError): string {
	// Native transport surfaces the gateway refusal as text ("MCP tool error:
	// FORBIDDEN: …"), not as a typed code.
	const forbidden =
		error.code === "FORBIDDEN" || /\bFORBIDDEN\b/.test(error.message);
	if (!forbidden || !ctx.authSource?.startsWith("external-agent:")) return "";
	return "\nThis call ran as the external agent. An agent may complete only an accepted item whose latest Attempt is its own, settled succeeded with --commit, and not credentials, payment or messaging work; anything else is an owner action. Rerun with the owner login: prefix it with `env -u TEDIX_EXTERNAL_AGENT`.";
}

/** Next step when the server refuses an Attempt for a caller with no executor identity. */
export function executorIdentityHint(
	ctx: WorkContext,
	id: string,
	error: BoardError,
): string {
	if (!/verified external-agent session/i.test(error.message)) return "";
	let key: string | undefined;
	try {
		key = readExternalAgentProfile(
			externalAgentProfileSlot(
				ctx.workspace,
				resolveAgentSession(ctx.work.session)?.session,
			),
		)?.key;
	} catch {
		// The hint degrades to a placeholder when the local store is unreadable.
	}
	return `\nThis call ran with the owner login. Start a verified session if this harness has none (\`tedix agent start --agent-harness-version <version> --model-provider <provider> --model-id <id> [--model-version <snapshot>]\`), then rerun as it: \`TEDIX_EXTERNAL_AGENT=${key ?? "<principal-key>"} tedix work start ${id}\`.`;
}

/** Merge session provenance into a board-write arg object under `metadata`. */
export function withSession(
	ctx: WorkContext,
	args: Record<string, unknown>,
): Record<string, unknown> {
	const meta = sessionMetadata(ctx);
	if (!meta) return args;
	const existing = isRecord(args.metadata) ? args.metadata : undefined;
	return { ...args, metadata: { ...existing, ...meta } };
}
