/**
 * `tedix work` — board verbs for external coding agents (Codex, Claude Code).
 *
 * The #1 adoption lever: agents will not hand-write `tedix code '<js>'` gateway
 * snippets against the work_items board. These verbs expose the canonical
 * attempt and evidence lifecycle while wrapping the org's board MCP tools
 * behind clean verbs with human-readable output (and `--json` for machines).
 *
 * Transport: native calls use the selected gateway credential. Authenticated
 * bootstrap and configured catalog descriptors determine the exact wire names;
 * absent, denied or stale routes fail closed.
 *
 * Acting identity: writes are always bound to the authenticated credential.
 * `--as <tediSlug>` is a read-only namespace selector; it never grants that
 * tedi's authority. Mutation verbs therefore reject `--as` and use the native
 * work namespace, where the gateway/API derive the actor from authentication.
 *
 * Board errors: oRPC contract errors (CONFLICT, NOT_FOUND, BAD_REQUEST, …) cross
 * native transport as a structured value `{ defined, code, status, message }`
 * (not a thrown exception), so `boardErrorFromValue` inspects the normalized
 * value. Claim conflicts and rejected transitions exit non-zero so agents and
 * scripts can branch.
 */

import type { AgentContextResult } from "./agent-context";
import type { ColorMode } from "./terminal";
import type { TedixHomeClient } from "./home-client";
import type { NativeBootstrapCache } from "./native-bootstrap-cache";
import type { WorkAttemptStore } from "./work-attempt-store";
import type {
	cleanupAttemptWorktrees,
	WorktreeRequest,
} from "./worktree-adapter";
import { WORK_EXIT_FAIL } from "./work-identity";
import { nativeCommands } from "./work-native";
import {
	workFind,
	workList,
	workCreate,
	workReadiness,
	workContext,
	workEvidence,
	workAttempts,
	workEvents,
	workCheckpoint,
} from "./work-queries";
import {
	workStart,
	workHeartbeat,
	workAccept,
	workSettle,
	workSubmitEvidence,
	workComplete,
	workTrailers,
	workCancel,
} from "./work-lifecycle";
import {
	workComment,
	workAuthorizeBlog,
	workRevokeBlog,
	workConfirm,
	workHandoff,
	workDelegate,
} from "./work-collaboration";
import {
	STRUCTURED_FACTORY_VERBS,
	workStructuredFactory,
	workClaimFiles,
} from "./work-factory";

export interface WorkOptions {
	/** `claim-files`: stable repository namespace and repeatable literal paths. */
	repoKey?: string;
	paths?: string[];
	/** `heartbeat`: renew the original Attempt for a bounded number of seconds. */
	watch?: number;
	lane?: boolean;
	/** Structured factory procedure input: inline JSON or @path. */
	input?: string;
	as?: string;
	project?: string;
	disposition?: string;
	mine?: boolean;
	reason?: string;
	note?: string;
	event?: string;
	campaign?: string;
	contentIds?: string;
	validUntil?: string;
	limit?: number;
	/** `create`: --desc description body. */
	desc?: string;
	/** `create`: adapter-neutral work kind. */
	kind?: string;
	/** `create`: --priority critical|high|medium|low. */
	priority?: string;
	/** `create`: --objective <objectiveId> — the normal purpose path. */
	objective?: string;
	/** `create`: --class maintenance|incident|hygiene — time-bounded exception. */
	workClass?: string;
	/** `create`: --expires <duration|iso> paired with --class (72h, 7d, ISO). */
	expires?: string;
	/** `clusters`: explicit active tedi executor selected by an operator. */
	executorTedi?: string;
	/** `accept`: plain-language done-looks-like, written into the contract. */
	doneWhen?: string;
	/** `settle`: succeeded|failed|cancelled|expired. */
	outcome?: string;
	needsUser?: string;
	requestId?: string;
	/** `settle`: repeatable `--commit <sha>`; each is resolved locally. */
	commit?: string[];
	/** `submit-evidence`: acceptance claim key. */
	claimKey?: string;
	/** `submit-evidence`: typed adapter key. */
	evidenceKind?: string;
	/** `submit-evidence`: optional media type. */
	evidenceMediaType?: string;
	/** `submit-evidence`: optional human-readable label. */
	evidenceLabel?: string;
	/** `submit-evidence`: inline JSON or @path metadata object. */
	evidenceMetadata?: string;
	/**
	 * `interaction-respond --no-deliver`: the answer closes a status update,
	 * so it is never delivered to the asking session or handed off.
	 */
	noDeliver?: boolean;
	/** Agent SESSION id (`--session`); traces a board write to one harness run. */
	session?: string;
	/** `delegate`: subagent|session — how the brief reaches its executor. */
	via?: string;
	/** `delegate`: name of the delegated session or subagent. */
	to?: string;
	/** `delegate --done <id>`: settle that delegation. */
	done?: string;
	/** `handoff`: local coding host receiving one Work Item. */
	host?: string;
	/** `handoff`: launch the host after reading the accepted item. */
	launch?: boolean;
	/**
	 * `--contradicts`: this principal asserts the settled claim is FALSE, rather
	 * than independently reproducing it. The ledger began as duplicate
	 * suppression and could only agree; contradiction is what lets it carry the
	 * after-the-fact correction AGENTS.md delegates to it.
	 */
	contradicts?: boolean;
	/** Evidence ref (`--evidence`) attached to a `confirm` corroboration. */
	evidence?: string;
	/** Stable key for retry-safe mutations that require one. */
	idempotencyKey?: string;
	/** Explicit human/operator bypass when a coding harness is using OAuth. */
	operatorOverride?: boolean;
	/** `start`: provision an isolated Git worktree after admission. */
	worktree?: boolean;
	/** Optional parent directory for the provisioned worktree. */
	worktreeRoot?: string;
}

export interface WorkContext {
	recordScope?: (scope: {
		projectId?: string;
		workItemId: string;
		heldUntil?: number;
	}) => void;
	/** Effective authenticated gateway/tenant, supplied by CLI routing. */
	mcpUrl?: string;
	organizationId?: string;
	/** Profile, selected organization and credential source fence for discovery. */
	nativeCacheScope?: string;
	/** Local resolver injection for checkpoint isolation tests. */
	resolveContext?: (sessionId?: string) => AgentContextResult;
	/** Clock injection for deterministic heartbeat-loop tests. */
	heartbeatClock?: { now: () => number; wait: (ms: number) => Promise<void> };
	client: Pick<
		TedixHomeClient,
		"callTool" | "callToolWithDestructiveApproval" | "getTimeoutMs"
	>;
	/** Reuses the gateway's native bootstrap and tool names across commands. */
	bootstrapCache?: NativeBootstrapCache;
	/** Optional cancellation from the invoking host. */
	signal?: AbortSignal;
	color: ColorMode;
	json: boolean;
	workspace: string;
	/** Resolved credential source (`stored-login:*`, `external-agent:*`, ...). */
	authSource?: string;
	attemptStore: WorkAttemptStore;
	cleanupWorktrees?: typeof cleanupAttemptWorktrees;
	provisionWorktree?: (request: WorktreeRequest) => {
		path: string;
		branch: string;
		reused: boolean;
	};
	launchHost?: (
		host: "codex" | "claude",
		args: string[],
		env: NodeJS.ProcessEnv,
	) => number;
	work: WorkOptions;
}
export type NativeToolContext = Pick<
	WorkContext,
	| "client"
	| "workspace"
	| "mcpUrl"
	| "organizationId"
	| "nativeCacheScope"
	| "bootstrapCache"
	| "signal"
>;

// ─── Dispatch + help ──────────────────────────────────────────────────────────

function firstToken(text: string): [string, string] {
	const trimmed = text.trim();
	const match = trimmed.match(/^(\S+)\s*([\s\S]*)$/);
	return match ? [match[1] ?? "", (match[2] ?? "").trim()] : ["", ""];
}

export function workUsage(): string {
	return `tedix work — artifact-neutral factory work

Usage: tedix work <verb> [args] [options]

Lifecycle:
  create "<title>" --kind <kind> (--project <id> | --objective <id> | --class <class> --expires <duration>)
              [--project <id>] [--desc <text>]
  accept <id> --done-when "<what done looks like>"
  readiness <id>
  start <id> [--lane] [--worktree [--worktree-root <path>]]
  handoff <id> --host codex|claude [--to codex:<chat-id>] [--launch]
  heartbeat <id> [--watch [seconds]]
  settle <id> --outcome succeeded|failed|cancelled|expired [--note <summary>]
              [--commit <sha> ...] [--needs-user "<next click>"] [--request-id <ledger-id>]
  complete <id>
  cancel <id> [--reason <summary>]

Delegation (a lead session's hand-offs; open ones appear in its prompt context):
  delegate "<title>" --done-when "<what done looks like>" --via subagent|session
           [--to <session or subagent name>] [--project <id>] [--session <lead id>]
  delegate --done <id> --note "<outcome and evidence>" [--commit <sha> ...]

Ledger (historical rows on in-flight items stay readable; nothing reviews them):
  submit-evidence <id> --claim-key <key> --evidence-kind <kind> --evidence <uri>
                    [--evidence-media-type <type>] [--evidence-label <label>]
                    [--evidence-metadata <json|@path>]
  evidence <id> [--claim-key <key>] [--limit <n>]

Discovery: list [--disposition <value>] · find <query> · readiness <id> · context <id>
Ledgers: evidence <id> · attempts <id> · events <id>  (one bounded page; --limit 1–100, default 25)
Checkpoint: checkpoint (read selected chat Work and bounded directed open Interactions; no writes)
Collaboration: comment <id> [text] [--body|--message|--text <text>]
               confirm <id> --evidence <ref> [--contradicts]

Choose the parent before creating. --project files the item under a portfolio
project and inherits its objective. For example:
  tedix work create "<title>" --kind coding --project <project-id>
Inherited objectives override --class and --expires defaults.
A Work Item joins a case afterwards with case-attach, not at creation.

Accept states the outcome in plain language: --done-when writes the whole contract.

Settle is the completion for coding work. --commit repeats, and every value is
resolved against this checkout first: a short sha expands, a fabricated one is
refused here rather than recorded as a pointer to nothing.

The evidence verb reads the ledger, which is optional execution telemetry that
nothing reviews. Its --claim-key filter is applied CLIENT-SIDE to the fetched
page — the board exposes no server-side evidence filter — so raise --limit before
trusting a filtered page as a whole-ledger answer.

Factory controls (--input accepts inline JSON or @path):
  agent-turn-triage|agent-reply-label|agent-reply-draft-request|agent-session-report
  case-list|get|create|stage|close|attach|dependency-add
  milestone-list|create|update|attach|dependency-add · health-list|record
  approval-list|approval-audit-list|approval-propose|approval-decide (admission authority)
  interaction-list|interaction-outbox-list|interaction-audit-list|interaction-get|interaction-create|interaction-respond|interaction-cancel
  interaction-respond <id> --input '{…}' [--no-deliver] (closing a status update, not answering an ask:
    sets response metadata.delivery="none"; never delivered to the asking session nor handed off)
  interaction-undelivered|interaction-ack (your answers not yet delivered to the asking session; record delivery)
  interaction-draft-delivered <id> --input '{"draftId":…,"via":"hook"}' (an auto draft reached the session: answer in the tedi's name)
  claim-files <id> --repo-key <stable-repo-key> --path <relative-file> [--path ...]
    Declare file requirements with existing owner/admin authority; reservation occurs at start.
  admission-get|replace · resource-list|put · budget-list|put · fleet · scheduler · clusters --executor-tedi <uuid>

Scheduler receipts distinguish factsTruncated + truncatedFacts (dependency, capability,
approval, resource, budget, or case facts; affected candidates are withheld as
evaluation_required) from graphTruncated (ranking only).
Cluster receipts group ranked ready Work into sequential, resource-compatible waves;
they remain advisory and every start re-evaluates admission.

An attempt id is a local capability fence scoped to workspace, actor, session, and Work Item.
Settled means done: complete carries no evidence count and no review requirement, and a wrong
claim is corrected with the confirm verb when noticed rather than prevented by pre-proof
(decisions/minimal-gates-over-pre-proof.md).

Heartbeat --watch [seconds] keeps renewing only the original Attempt, about
every 30 s, for a horizon of 900 seconds by default (maximum 3600); the number
is the total run time, not the interval. Rate limits, timeouts and 5xx errors
retry while the confirmed lease lasts. It stops, printing why, on any other
error, cache replacement, process exit, or the horizon. It does not settle,
complete, or restart work. JSON output is NDJSON.

Exit codes: 0 success · 2 conflict, stale attempt, rejected evidence, or board error.
`;
}

type VerbHandler = (
	ctx: WorkContext,
	id: string,
	text: string,
) => Promise<number>;

const VERBS: Record<string, VerbHandler> = {
	checkpoint: (ctx, id, text) => workCheckpoint(ctx, id, text),
	"claim-files": (ctx, id, text) => workClaimFiles(ctx, id, text),
	list: (ctx, id) => workList(ctx, id),
	find: (ctx, id, text) => workFind(ctx, text ? `${id} ${text}` : id),
	create: (ctx, id, text) => workCreate(ctx, text ? `${id} ${text}` : id),
	accept: (ctx, id) => workAccept(ctx, id),
	readiness: (ctx, id) => workReadiness(ctx, id),
	start: (ctx, id) => workStart(ctx, id),
	handoff: (ctx, id, text) => workHandoff(ctx, id, text),
	comment: (ctx, id, text) => workComment(ctx, id, text),
	"authorize-blog": (ctx, id) => workAuthorizeBlog(ctx, id),
	"revoke-blog": (ctx, id) => workRevokeBlog(ctx, id),
	heartbeat: (ctx, id) => workHeartbeat(ctx, id),
	confirm: (ctx, id) => workConfirm(ctx, id),
	settle: (ctx, id) => workSettle(ctx, id),
	"submit-evidence": (ctx, id) => workSubmitEvidence(ctx, id),
	complete: (ctx, id) => workComplete(ctx, id),
	cancel: (ctx, id) => workCancel(ctx, id),
	delegate: (ctx, id, text) => workDelegate(ctx, text ? `${id} ${text}` : id),
	context: (ctx, id) => workContext(ctx, id),
	evidence: (ctx, id) => workEvidence(ctx, id),
	attempts: (ctx, id) => workAttempts(ctx, id),
	events: (ctx, id) => workEvents(ctx, id),
	trailers: (ctx, id) => workTrailers(ctx, id),
	...Object.fromEntries(
		Object.keys(STRUCTURED_FACTORY_VERBS).map((verb) => [
			verb,
			(ctx: WorkContext, id: string) => workStructuredFactory(ctx, verb, id),
		]),
	),
};

export function workVerbNames(): string[] {
	return Object.keys(VERBS);
}

/** Bounded Levenshtein distance — verbs are short, so the O(n·m) table is fine. */
function editDistance(a: string, b: string): number {
	const rows = a.length + 1;
	const cols = b.length + 1;
	const dist = Array.from({ length: rows }, (_, i) =>
		Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
	);
	for (let i = 1; i < rows; i++) {
		for (let j = 1; j < cols; j++) {
			dist[i]![j] = Math.min(
				dist[i - 1]![j]! + 1,
				dist[i]![j - 1]! + 1,
				dist[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
		}
	}
	return dist[rows - 1]![cols - 1]!;
}

/** Closest known verbs to a typo, nearest first. Empty when nothing is close. */
export function nearestWorkVerbs(input: string, max = 3): string[] {
	const lowered = input.toLowerCase();
	return (
		workVerbNames()
			.map((verb) => ({ verb, d: editDistance(lowered, verb) }))
			// Within 2 edits, or a prefix/substring guess like `stat` → nothing vs
			// `comm` → comment. The threshold keeps "xyz" from matching anything.
			.filter(
				({ verb, d }) =>
					d <= 2 || (lowered.length >= 3 && verb.startsWith(lowered)),
			)
			.sort((a, b) => a.d - b.d)
			.slice(0, max)
			.map(({ verb }) => verb)
	);
}

/**
 * Dispatch `tedix work <verb> ...`. `args` is the verb plus its positional tail
 * (flags are already parsed into `ctx.work`). Returns a process exit code.
 */
export async function runWork(args: string, ctx: WorkContext): Promise<number> {
	ctx = {
		...ctx,
		work: JSON.parse(JSON.stringify(ctx.work)) as WorkOptions,
		client: {
			callTool: ctx.client.callTool.bind(ctx.client),
			callToolWithDestructiveApproval:
				ctx.client.callToolWithDestructiveApproval.bind(ctx.client),
			getTimeoutMs: ctx.client.getTimeoutMs.bind(ctx.client),
		},
	};
	nativeCommands.set(ctx, {
		protocolSequence: {},
		// The last renewal at the watch horizon still gets a full call timeout.
		deadlineAt:
			Date.now() + ctx.client.getTimeoutMs() + (ctx.work.watch ?? 0) * 1000,
	});
	const [verb, rest] = firstToken(args ?? "");
	if (!verb || verb === "help") {
		console.log(workUsage());
		return verb ? 0 : WORK_EXIT_FAIL;
	}
	const handler = VERBS[verb];
	if (!handler) {
		// Nearest-verb guidance instead of the full verb dump: an agent that
		// typed `hearbeat` needs "did you mean heartbeat", not another --help
		// page in its context window.
		const nearest = nearestWorkVerbs(verb);
		const hint =
			nearest.length > 0
				? `Did you mean: ${nearest.join(", ")}?`
				: `Verbs: ${workVerbNames().join(", ")}`;
		throw new Error(
			`Unknown work verb "${verb}". ${hint} (\`tedix work --help\` for details)`,
		);
	}
	if (
		(ctx.work.repoKey !== undefined || ctx.work.paths !== undefined) &&
		verb !== "claim-files"
	) {
		throw new Error(
			"--repo-key and --path are only valid with work claim-files",
		);
	}
	if (ctx.work.lane && verb !== "start")
		throw new Error("--lane is only valid with work start");
	if (ctx.work.watch !== undefined) {
		if (verb !== "heartbeat")
			throw new Error("--watch is only valid with work heartbeat");
		if (
			!Number.isInteger(ctx.work.watch) ||
			ctx.work.watch < 1 ||
			ctx.work.watch > 3600
		) {
			throw new Error("work heartbeat --watch requires 1–3600 seconds");
		}
	}
	if ((ctx.work.worktree || ctx.work.worktreeRoot) && verb !== "start") {
		throw new Error(
			"--worktree and --worktree-root are only valid with work start",
		);
	}
	if ((ctx.work.host || ctx.work.launch) && verb !== "handoff")
		throw new Error("--host and --launch are only valid with work handoff");
	if (ctx.work.worktreeRoot && !ctx.work.worktree) {
		throw new Error("--worktree-root requires --worktree");
	}
	const [id, text] = firstToken(rest);
	return handler(ctx, id, text);
}
