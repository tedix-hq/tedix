/**
 * Shared CLI primitives used by options.ts and index.ts (parsing / dispatch) and the
 * per-verb modules (auth-resolve, turn, tedi, interactive, interactive-ink).
 * Extracted verbatim from index.ts; import direction is
 * index → verb modules → shared.
 */

import { readFileSync } from "node:fs";
import type { OAuthClientProvider } from "@modelcontextprotocol/client";
import type { InspectViewOptions } from "./format";
import type { InteractiveOAuthScopeProfile } from "./oauth-provider";

declare const __TEDIX_CLI_VERSION__: string | undefined;

/** True only for the self-contained binary produced by build:standalone. */
export const IS_STANDALONE_BUILD = typeof __TEDIX_CLI_VERSION__ !== "undefined";

/** CLI version, injected into standalone builds or read from package.json in source. */
export const CLI_VERSION = ((): string => {
	if (typeof __TEDIX_CLI_VERSION__ !== "undefined") {
		return __TEDIX_CLI_VERSION__;
	}
	try {
		return JSON.parse(
			readFileSync(new URL("../package.json", import.meta.url), "utf8"),
		).version as string;
	} catch {
		return "0.0.0";
	}
})();

export interface AuthResolution {
	cleanup?: () => Promise<void>;
	headers: Record<string, string>;
	mcpUrl?: string;
	oauthProvider?: OAuthClientProvider;
	source: string;
}

export interface CliOptions {
	artifactLimit?: number;
	channel?: string;
	conversationId: string;
	cursor?: string;
	offset?: string;
	thread?: string;
	delegateToTediId?: string;
	delegationWorkItemId?: string;
	/** `--verify <cmd>`: the delegated tedi must run it and quote its output before reporting. */
	verifyCommand?: string;
	follow: boolean;
	goalBudgetUsd?: number;
	goalCondition?: string;
	goalEvaluator?: import("./commands").GoalLoopEvaluator;
	goalMaxTurns?: number;
	goalObjectiveId?: string;
	harnessVersionId?: string;
	idempotencyKey?: string;
	includeArchived: boolean;
	updateCheck?: boolean;
	updateForce?: boolean;
	inspectView?: InspectViewOptions;
	help?: boolean;
	/** True when argv named a command instead of defaulting to interactive chat. */
	commandExplicit?: boolean;
	/** `tedix help --map`; human alias of `tedix help --all`. */
	helpMap?: boolean;
	json: boolean;
	/** `tedix code --meta`: include the gateway execution envelope. */
	codeMetadata?: boolean;
	/** Explicit call-local operator approval for a destructive Code Mode call. */
	codeDestructiveApprovalReason?: string;
	limit?: number;
	noColor: boolean;
	poll: boolean;
	pollIntervalMs: number;
	pollTimeoutMs: number;
	prompt?: string;
	repoContext: boolean;
	requireCodeProof: boolean;
	requireWorkstation: boolean;
	search?: string;
	url: string;
	urlExplicit?: boolean;
	version?: boolean;
	workspace?: string;
	organization?: string;
	oauthScopeProfile?: InteractiveOAuthScopeProfile;
	all?: boolean;
	// `tedix work` verb-group flags (parsed in work-options.ts, consumed by runWork).
	workAs?: string;
	workRepoKey?: string;
	workPaths?: string[];
	workProject?: string;
	workDisposition?: string;
	workMine?: boolean;
	workReason?: string;
	workNote?: string;
	workEvent?: string;
	workCampaign?: string;
	workContentIds?: string;
	workValidUntil?: string;
	workSession?: string;
	/** `work delegate`: subagent|session, the target name, and --done <id>. */
	workVia?: string;
	workTo?: string;
	workDone?: string;
	/** `work handoff`: target coding host. */
	workHost?: string;
	/** `work handoff`: explicitly launch the host after a read-only preview. */
	workLaunch?: boolean;
	workEvidence?: string;
	/** `work accept`: plain-language --done-when text. */
	workDoneWhen?: string;
	/** Structured Work factory procedure input: inline JSON or @path. */
	workInput?: string;
	workOutcome?: string;
	/** `work settle`: repeatable --commit values, in the order given. */
	workCommits?: string[];
	workClaimKey?: string;
	workEvidenceKind?: string;
	workEvidenceMediaType?: string;
	workEvidenceLabel?: string;
	workEvidenceMetadata?: string;
	// `tedix work create` guided-creation flags.
	workDesc?: string;
	workKind?: string;
	workPriority?: string;
	workObjective?: string;
	workClass?: string;
	workExpires?: string;
	/** `work clusters`: explicit tedi executor for an operator credential. */
	workExecutorTedi?: string;
	/** `work start`: provision an isolated local Git worktree after admission. */
	workWorktree?: boolean;
	/** Optional parent directory for `work start --worktree`. */
	workWorktreeRoot?: string;
	/** Explicitly let a human OAuth operator terminally transition from a harness. */
	workOperatorOverride?: boolean;
	/** `work confirm --contradicts`: assert the settled claim is false. */
	workContradicts?: boolean;
	/** `tedix who --paths a,b`: limit the check to these paths. */
	whoPaths?: string;
	/** `tedix who --hours N`: how far back to look. Defaults to 24. */
	whoHours?: string;
	// `tedix flow` verb-group flags (parsed in flow-options.ts, consumed by runFlowCommand).
	/** `flow run --file <plan.ts>`: source + `/* tedix *\/` manifest in one file. */
	flowFile?: string;
	/** `flow run|status --watch[=seconds]`: poll to terminal instead of returning. */
	flowWatch?: number;
	/** Repeatable `flow run --param k=v`. */
	flowParam?: string[];
	/** `flow run --params '<json>'`: whole params object at once. */
	flowParams?: string;
	/** `flow run --title <text>`: override the manifest-derived skill title. */
	flowTitle?: string;
	/** `flow run --skill <uuid>`: run an existing executable skill. */
	flowSkill?: string;
	// `tedix agent start` immutable executor/session provenance.
	agentKey?: string;
	agentDisplayName?: string;
	agentHarness?: string;
	agentHarnessVersion?: string;
	agentModelProvider?: string;
	agentModelId?: string;
	agentModelVersion?: string;
	agentScopes?: string[];
	agentNoHandoffReason?: string;
	agentZeroWorkReason?: string;
	agentStaleBefore?: string;
	agentArtifactRef?: string;
}

export function defaultConversationId(): string {
	const cwd = process
		.cwd()
		.replace(/[^a-zA-Z0-9_.:-]+/g, "-")
		.slice(-96);
	return `home:cli:${cwd || "main"}`;
}

export function looksLikeUuid(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
		value,
	);
}

/**
 * Race a promise against a timeout that rejects with `label`. Swallows a late
 * rejection from the loser so it never surfaces as an unhandled rejection.
 */
export function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	label: string,
	onTimeout?: () => void,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			try {
				onTimeout?.();
			} finally {
				reject(new Error(label));
			}
		}, ms);
	});
	promise.catch(() => {});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
