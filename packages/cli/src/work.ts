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

import { spawnSync } from "node:child_process";
import { recordLocalSession } from "./hooks/decision-capture";
import { resolveAgentContext, type AgentContextResult } from "./agent-context";
import { claimFiles, fileResourceKeys } from "./work-claim-files";
import {
	delegationKey,
	forgetDelegations,
	readDelegations,
	recordDelegation,
} from "./delegation-ledger";
import { setTimeout as sleep } from "node:timers/promises";
import { resolveCommitFlag } from "./local-context";
import { dim, errorText, green, yellow } from "./format";
import type { ColorMode } from "./terminal";
import {
	type TedixHomeClient,
	isRateLimitError,
	rateLimitRetryAfterMs,
} from "./home-client";
import { type NativeBootstrapCache } from "./native-bootstrap-cache";
import type { WorkAttemptStore } from "./work-attempt-store";
import {
	cleanupAttemptWorktrees,
	provisionAttemptWorktree,
	type WorktreeRequest,
} from "./worktree-adapter";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import {
	WORK_EXIT_FAIL,
	UUID_RE,
	type BoardResult,
	isUuid,
	mutationCallable,
	workAttemptKey,
	cachedAttemptId,
	missingAttemptResult,
	GATE_SESSION_KEY,
	resolveAgentSession,
	assertUnambiguousSession,
	isDetectedExternalHarness,
	oauthHarnessGuard,
	ownerActionHint,
	executorIdentityHint,
	withSession,
} from "./work-identity";
import { nativeCommands, boardCall } from "./work-native";
import { fail, ok, truncate, itemsFromList } from "./work-render";
import {
	listWorkItems,
	getWorkItem,
	projectArg,
	resolveWorkItemId,
	workFind,
	workList,
	CREATE_EXCEPTION_CLASSES,
	expiresToIso,
	workCreate,
	parseObjectArgument,
	workReadiness,
	workContext,
	workEvidence,
	workAttempts,
	workEvents,
	workCheckpoint,
} from "./work-queries";

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

function workMetadataInput(ctx: WorkContext): Record<string, unknown> {
	if (!ctx.work.input) return {};
	const input = parseObjectArgument(ctx.work.input, "--input");
	if (
		Object.keys(input).some((key) => key !== "metadata") ||
		!isRecord(input.metadata)
	)
		throw new Error(
			"start/settle --input accepts only an object containing metadata",
		);
	return input.metadata;
}

async function workStart(ctx: WorkContext, id: string): Promise<number> {
	if (!id) throw new Error("work start requires a work item id");
	const { as } = ctx.work;
	id = await resolveWorkItemId(ctx, id);
	const call = await boardCall(
		ctx,
		mutationCallable(as, "work.start_work_item_attempt"),
		withSession(ctx, {
			id,
			...(ctx.work.input || ctx.work.lane
				? {
						metadata: {
							...workMetadataInput(ctx),
							...(ctx.work.lane ? { lane: true } : {}),
						},
					}
				: {}),
		}),
	);

	if (call.error) {
		if (call.error.code === "CONFLICT") {
			// Admission returns CONFLICT for every reason it refuses, not only a
			// live attempt: a reserved resource key, a stale specification
			// revision, and an exhausted budget all land here. Asserting one of
			// them printed the wrong reason for the others — a budget refusal read
			// as "already has a live attempt" — so the server's own message leads
			// and the hint follows it.
			return fail(
				ctx,
				call.error,
				`Could not start attempt for ${id}: ${call.error.message}\nInspect the failed gate with \`tedix work readiness ${id}\` or the item with \`tedix work context ${id}\`.`,
			);
		}
		return fail(
			ctx,
			call.error,
			`Could not start attempt for ${id}: ${call.error.message}${executorIdentityHint(ctx, id, call.error)}`,
		);
	}
	const attempt = isRecord(call.value) ? call.value.attempt : undefined;
	const attemptId = isRecord(attempt) ? attempt.id : undefined;
	const serverAgentSession =
		isRecord(attempt) && typeof attempt.externalSessionKey === "string"
			? attempt.externalSessionKey.trim()
			: undefined;
	const resumed = isRecord(call.value) && call.value.resumed === true;
	if (typeof attemptId !== "string" || !attemptId.trim()) {
		return fail(
			ctx,
			{ code: "INVALID_RESULT", message: "Start returned no attempt fence" },
			`Could not retain attempt ${id}: the board returned no attempt id.`,
		);
	}
	try {
		ctx.attemptStore.set(
			workAttemptKey(ctx, id, serverAgentSession),
			attemptId,
		);
	} catch (error) {
		const detail = errorText(error);
		return fail(
			ctx,
			{
				code: "LOCAL_ATTEMPT_STORE_FAILED",
				message: `${detail}; attempt ${attemptId} remains live and must be settled explicitly`,
			},
			`Attempt ${attemptId} started for ${id}, but its fence could not be stored locally. Settle it explicitly before retrying.`,
		);
	}
	const item =
		isRecord(call.value) && isRecord(call.value.workItem)
			? call.value.workItem
			: undefined;
	if (item && typeof item.projectId === "string")
		ctx.recordScope?.({
			projectId: item.projectId,
			workItemId: id,
			heldUntil:
				isRecord(attempt) && typeof attempt.expiresAt === "string"
					? Date.parse(attempt.expiresAt)
					: undefined,
		});
	let worktree: { path: string; branch: string; reused: boolean } | undefined;
	if (ctx.work.worktree) {
		if (!serverAgentSession) {
			return fail(
				ctx,
				{
					code: "WORKTREE_REQUIRES_EXTERNAL_SESSION",
					message: `attempt ${attemptId} remains live and must be settled explicitly`,
				},
				"Attempt started, but worktree provisioning requires a server-certified external Agent-Session.",
			);
		}
		try {
			worktree = (ctx.provisionWorktree ?? provisionAttemptWorktree)({
				workItemId: id,
				attemptId,
				agentSession: serverAgentSession,
				...(ctx.work.worktreeRoot ? { root: ctx.work.worktreeRoot } : {}),
			});
		} catch (error) {
			return fail(
				ctx,
				{
					code: "LOCAL_WORKTREE_FAILED",
					message: `${errorText(error)}; attempt ${attemptId} remains live and must be settled explicitly`,
				},
				`Attempt ${attemptId} started for ${id}, but its isolated worktree could not be provisioned.`,
			);
		}
	}
	const output =
		worktree && isRecord(call.value)
			? { ...call.value, localWorktree: worktree }
			: call.value;
	return ok(ctx, output, () => {
		const expiresAt =
			isRecord(attempt) && typeof attempt.expiresAt === "string"
				? attempt.expiresAt
				: undefined;
		console.log(
			`${green(resumed ? "Resumed" : "Started", ctx.color)} ${id} as ${as ?? "verified external credential"}${
				attemptId ? ` — attempt ${attemptId}` : ""
			}${expiresAt ? ` (attempt expires ${expiresAt})` : ""}`,
		);
		if (worktree) {
			console.log(
				`${green(worktree.reused ? "Reused" : "Provisioned", ctx.color)} ${worktree.path} — ${worktree.branch}`,
			);
		}
		console.log(
			dim(
				`  keep it alive: tedix work heartbeat ${id}${as ? ` --as ${as}` : ""}`,
				ctx.color,
			),
		);
	});
}

/**
 * Post a comment as the acting identity implied by `--as` (or the operator).
 * Discussion is deliberately separate from lifecycle events and attempt state.
 */
async function postComment(
	ctx: WorkContext,
	id: string,
	body: string,
	extraMeta?: Record<string, unknown>,
): Promise<BoardResult> {
	const { as } = ctx.work;
	const meta =
		extraMeta && Object.keys(extraMeta).length > 0
			? { metadata: extraMeta }
			: {};
	if (as) {
		return boardCall(
			ctx,
			mutationCallable(as, "work.add_comment"),
			withSession(ctx, {
				id,
				body,
				...meta,
			}),
		);
	}
	return boardCall(
		ctx,
		"work.add_comment",
		withSession(ctx, {
			id,
			body,
			...meta,
		}),
	);
}

async function workComment(
	ctx: WorkContext,
	id: string,
	text: string,
): Promise<number> {
	if (!id || !text.trim()) {
		throw new Error("work comment requires a work item id and comment text");
	}
	id = await resolveWorkItemId(ctx, id);
	const call = await postComment(ctx, id, text.trim());
	if (call.error) {
		return fail(
			ctx,
			call.error,
			`Could not comment on ${id}: ${call.error.message}`,
		);
	}
	return ok(ctx, call.value, () =>
		console.log(`${green("Commented", ctx.color)} on ${id}.`),
	);
}

async function workAuthorizeBlog(
	ctx: WorkContext,
	id: string,
): Promise<number> {
	if (!id) throw new Error("work authorize-blog requires a work item id");
	if (ctx.work.as) {
		throw new Error(
			"work authorize-blog requires an owner/admin user principal; remove --as and use an authenticated user login",
		);
	}
	const identityError = oauthHarnessGuard(ctx);
	if (identityError) {
		return fail(
			ctx,
			identityError,
			`Could not authorize blog publishing on ${id}: ${identityError.message}`,
		);
	}
	const campaignKey = ctx.work.campaign?.trim();
	const validUntil = ctx.work.validUntil?.trim();
	const contentIds = [
		...new Set(
			(ctx.work.contentIds ?? "")
				.split(",")
				.map((contentId) => contentId.trim())
				.filter(Boolean),
		),
	];
	if (!campaignKey || contentIds.length === 0 || !validUntil) {
		throw new Error(
			"work authorize-blog requires --campaign, --content-ids, and --valid-until",
		);
	}
	id = await resolveWorkItemId(ctx, id);
	if (ctx.work.operatorOverride) {
		const session = resolveAgentSession(ctx.work.session);
		const override = await postComment(
			ctx,
			id,
			`Owner/admin credential override: blog authorization from ${session?.session ?? "an unidentified harness session"} using ${ctx.authSource ?? "an unknown credential source"}.`,
		);
		if (override.error) {
			return fail(
				ctx,
				override.error,
				`Could not audit the operator override for ${id}: ${override.error.message}`,
			);
		}
	}
	const call = await boardCall(
		ctx,
		"work.authorize_owned_channel",
		{
			id,
			campaignKey,
			contentIds,
			validUntil,
		},
		`Authorize bounded blog publishing for campaign ${campaignKey} on ${id}`,
	);
	if (call.error) {
		return fail(
			ctx,
			call.error,
			`Could not authorize blog campaign on ${id}: ${call.error.message}`,
		);
	}
	return ok(ctx, call.value, () =>
		console.log(
			`${green("Authorized", ctx.color)} ${contentIds.length} blog draft${contentIds.length === 1 ? "" : "s"} for campaign ${campaignKey} on ${id} until ${validUntil}.`,
		),
	);
}

async function workRevokeBlog(ctx: WorkContext, id: string): Promise<number> {
	if (!id) throw new Error("work revoke-blog requires a work item id");
	if (ctx.work.as) {
		throw new Error(
			"work revoke-blog requires an owner/admin user principal; remove --as and use an authenticated user login",
		);
	}
	const identityError = oauthHarnessGuard(ctx);
	if (identityError) {
		return fail(
			ctx,
			identityError,
			`Could not revoke blog publishing on ${id}: ${identityError.message}`,
		);
	}
	const campaignKey = ctx.work.campaign?.trim();
	const reason = ctx.work.reason?.trim();
	if (!campaignKey || !reason) {
		throw new Error("work revoke-blog requires --campaign and --reason");
	}
	id = await resolveWorkItemId(ctx, id);
	if (ctx.work.operatorOverride) {
		const session = resolveAgentSession(ctx.work.session);
		const override = await postComment(
			ctx,
			id,
			`Owner/admin credential override: blog authorization revocation from ${session?.session ?? "an unidentified harness session"} using ${ctx.authSource ?? "an unknown credential source"}.`,
		);
		if (override.error) {
			return fail(
				ctx,
				override.error,
				`Could not audit the operator override for ${id}: ${override.error.message}`,
			);
		}
	}
	const call = await boardCall(
		ctx,
		"work.revoke_owned_channel",
		{
			id,
			campaignKey,
			reason,
		},
		`Revoke blog publishing for campaign ${campaignKey} on ${id}: ${reason}`,
	);
	if (call.error) {
		return fail(
			ctx,
			call.error,
			`Could not revoke blog campaign on ${id}: ${call.error.message}`,
		);
	}
	return ok(ctx, call.value, () =>
		console.log(
			`${yellow("Revoked", ctx.color)} blog campaign ${campaignKey} on ${id}.`,
		),
	);
}

async function workHeartbeat(ctx: WorkContext, id: string): Promise<number> {
	if (!id) throw new Error("work heartbeat requires a work item id");
	id = await resolveWorkItemId(ctx, id);
	const attemptId = cachedAttemptId(ctx, id);
	if (!attemptId) {
		return fail(
			ctx,
			missingAttemptResult(id).error!,
			`Could not heartbeat ${id}: no active attempt is cached. Start the item in this workspace first.`,
		);
	}
	const key = workAttemptKey(ctx, id);
	const clock = ctx.heartbeatClock ?? { now: Date.now, wait: sleep };
	const deadline = clock.now() + (ctx.work.watch ?? 0) * 1_000;
	const callable = mutationCallable(
		ctx.work.as,
		"work.heartbeat_work_item_attempt",
	);
	let confirmedLeaseExpiry: number | undefined;
	let rateRetries = 0;
	for (;;) {
		// Pin the original fence. Another process may settle or replace its cache.
		if (ctx.attemptStore.get(key) !== attemptId) {
			return fail(
				ctx,
				{
					code: "STALE_ATTEMPT",
					message: "The cached Attempt changed; heartbeat watch stopped.",
				},
				"Heartbeat watch stopped: the cached Attempt changed.",
			);
		}
		if (
			confirmedLeaseExpiry !== undefined &&
			clock.now() >= confirmedLeaseExpiry
		) {
			return fail(
				ctx,
				{
					code: "INVALID_LEASE",
					message:
						"The last confirmed Attempt lease expired; heartbeat watch stopped.",
				},
				"The last confirmed Attempt lease expired; heartbeat watch stopped.",
			);
		}
		const touch = await boardCall(ctx, callable, { id, attemptId });
		if (touch.error) {
			const { status, code } = touch.error;
			const rateLimited =
				status === 429 ||
				(status === undefined && isRateLimitError(touch.error.message));
			// A timeout, dropped connection or 5xx says nothing about the lease.
			const transient =
				status === 408 ||
				(status !== undefined && status >= 500) ||
				(status === undefined && code === undefined);
			// Retry only after a confirmed renewal and inside that lease; a guessed
			// lease never grants permission to keep trying.
			if (
				ctx.work.watch !== undefined &&
				(rateLimited || transient) &&
				confirmedLeaseExpiry !== undefined
			) {
				const hint =
					touch.error.retryAfter !== undefined
						? touch.error.retryAfter * 1000
						: rateLimitRetryAfterMs(touch.error.message);
				const delay = Math.max(
					500,
					hint ?? 0,
					Math.min(60_000, 5_000 * 2 ** Math.min(rateRetries, 4)),
				);
				const retryDeadline = Math.min(deadline, confirmedLeaseExpiry);
				const reason = rateLimited ? "rate limited" : touch.error.message;
				if (clock.now() + delay >= retryDeadline) {
					const message = `Heartbeat failed (${reason}) and cannot retry within the original watch horizon and confirmed lease; watch stopped.`;
					return fail(ctx, { ...touch.error, message }, message);
				}
				rateRetries++;
				console.error(
					`Heartbeat ${reason}; retrying the same Attempt in ${delay / 1000}s.`,
				);
				await clock.wait(delay);
				if (clock.now() >= deadline)
					return fail(
						ctx,
						touch.error,
						"Heartbeat retry reached the original watch horizon; watch stopped.",
					);
				continue;
			}
			// A stale response can be a concurrent-write conflict, not a dead lease.
			// Keep the lookup pointer; every retry still revalidates server authority.
			return fail(
				ctx,
				touch.error,
				`Could not heartbeat ${id}: ${touch.error.message}`,
			);
		}
		const expiresAt =
			isRecord(touch.value) && typeof touch.value.expiresAt === "string"
				? touch.value.expiresAt
				: undefined;
		if (expiresAt && Date.parse(expiresAt) > clock.now())
			ctx.recordScope?.({ workItemId: id, heldUntil: Date.parse(expiresAt) });
		ok(ctx, touch.value, () => {
			console.log(
				`${green("Heartbeat", ctx.color)} touched attempt ${attemptId} on ${id}${expiresAt ? ` (attempt expires ${expiresAt})` : ""}.`,
			);
		});
		if (ctx.work.watch === undefined) return 0;
		const remainingLease = expiresAt
			? Date.parse(expiresAt) - clock.now()
			: NaN;
		if (!Number.isFinite(remainingLease) || remainingLease <= 0) {
			return fail(
				ctx,
				{
					code: "INVALID_LEASE",
					message: "Heartbeat returned no future expiry; watch stopped.",
				},
				"Heartbeat returned no future expiry; watch stopped.",
			);
		}
		confirmedLeaseExpiry = Date.parse(expiresAt!);
		rateRetries = 0;
		const remainingWatch = deadline - clock.now();
		if (remainingWatch > 0)
			// Serial calls; leave most of the server-issued lease for request latency.
			await clock.wait(Math.min(30_000, remainingLease / 3, remainingWatch));
		if (clock.now() >= deadline) {
			console.error(
				`Heartbeat watch reached its ${ctx.work.watch} s horizon; the Attempt lease expires at ${expiresAt}. Run it again to keep renewing.`,
			);
			return 0;
		}
	}
}

/**
 * Corroborate an EXISTING item you independently hit, instead of filing a
 * duplicate. Calls the canonical credential-derived corroboration ledger; a
 * stable principal counts once across every session and API key. Evidence is
 * mandatory because raw comments never affect ranking.
 */
async function workConfirm(ctx: WorkContext, id: string): Promise<number> {
	if (!id) throw new Error("work confirm requires a work item id");
	id = await resolveWorkItemId(ctx, id);
	const body =
		ctx.work.note?.trim() ||
		(ctx.work.contradicts
			? "independently checked this settled claim and it does not hold"
			: "independently reproduced this issue");
	const evidence = ctx.work.evidence?.trim();
	if (!evidence) {
		throw new Error("work confirm requires --evidence <ref>");
	}
	if (ctx.work.as && isUuid(ctx.work.as)) {
		throw new Error(
			"work confirm cannot impersonate a tedi UUID; use its slug namespace or the tedi credential",
		);
	}
	const callable = mutationCallable(ctx.work.as, "work.corroborate_work_items");
	const call = await boardCall(ctx, callable, {
		id,
		evidenceRef: evidence,
		stance: ctx.work.contradicts ? "contradicts" : "corroborates",
		body,
	});
	if (call.error) {
		return fail(
			ctx,
			call.error,
			`Could not confirm ${id}: ${call.error.message}`,
		);
	}
	return ok(ctx, call.value, () =>
		console.log(
			`${green("Confirmed", ctx.color)} ${id} (corroboration recorded).`,
		),
	);
}

/**
 * Build the acceptance contract an `accept` will write.
 *
 * One `doneLooksLike` sentence is the whole contract. The previous
 * `--acceptance <json>` escape hatch is gone: it existed to submit a full
 * stored contract, and every field that made a full contract meaningful —
 * claims, evidence kinds, review requirements — stopped being consulted by any
 * gate. Keeping a flag that wrote unread fields and silently overrode
 * `--done-when` only offered a way to get acceptance wrong.
 *
 * See `decisions/minimal-gates-over-pre-proof.md`. Stored legacy
 * contracts still PARSE on read so live rows keep deserializing; nothing
 * writes one.
 */
export function buildAcceptanceContract(
	doneWhen: string | undefined,
): Record<string, unknown> {
	const done = doneWhen?.trim();
	if (!done)
		throw new Error(
			'work accept requires --done-when "<what done looks like>"',
		);
	return { version: 1, doneLooksLike: done };
}

async function workAccept(ctx: WorkContext, id: string): Promise<number> {
	if (!id) throw new Error("work accept requires a work item id");
	mutationCallable(ctx.work.as?.trim(), "work.accept_work_item");
	id = await resolveWorkItemId(ctx, id);
	const acceptanceContract = buildAcceptanceContract(ctx.work.doneWhen);
	const call = await boardCall(ctx, "work.accept_work_item", {
		id,
		acceptanceContract,
	});
	if (call.error)
		return fail(
			ctx,
			call.error,
			`Could not accept ${id}: ${call.error.message}${ownerActionHint(ctx, call.error)}`,
		);
	return ok(ctx, call.value, () =>
		console.log(`${green("Accepted", ctx.color)} ${id}.`),
	);
}

/**
 * Resolve every repeated `--commit <sha>` into the settlement metadata block.
 *
 * Under `decisions/minimal-gates-over-pre-proof.md` settling IS the
 * completion, and for coding work the commits on `main` are the ledger entry
 * — so the shas have to travel with the settlement rather than through a
 * separate evidence submission that nothing reads any more.
 *
 * Each value goes through `resolveCommitFlag`, which expands the short sha
 * `git push` prints and REFUSES one that names no object in this checkout.
 * That local refusal is the whole anti-fabrication story now that the digest
 * ceremony is gone: a fabricated sha fails at the terminal of the agent that
 * typed it, where the mistake is still fixable, instead of being recorded as a
 * pointer to nothing. It degrades rather than blocks outside a worktree.
 *
 * `commitSha` repeats the first entry so a consumer reading one sha does not
 * have to know about the array; duplicates collapse and order is preserved.
 */
export function buildSettlementMetadata(
	commits: readonly string[] | undefined,
	cwd = process.cwd(),
): Record<string, unknown> | undefined {
	if (!commits?.length) return undefined;
	const resolved: string[] = [];
	for (const value of commits) {
		if (!value.trim()) continue;
		const sha = resolveCommitFlag(value, cwd);
		if (!resolved.includes(sha)) resolved.push(sha);
	}
	if (resolved.length === 0) return undefined;
	return {
		settlement: {
			mode: "commit",
			commitSha: resolved[0],
			commitShas: resolved,
		},
	};
}

async function workSettle(ctx: WorkContext, id: string): Promise<number> {
	if (!id) throw new Error("work settle requires a work item id");
	id = await resolveWorkItemId(ctx, id);
	const outcome = ctx.work.outcome?.trim();
	if (
		!outcome ||
		!["succeeded", "failed", "cancelled", "expired"].includes(outcome)
	) {
		throw new Error(
			"work settle requires --outcome succeeded|failed|cancelled|expired",
		);
	}
	const attemptId = cachedAttemptId(ctx, id);
	if (!attemptId)
		return fail(
			ctx,
			missingAttemptResult(id).error!,
			`Could not settle ${id}: no attempt is cached.`,
		);
	const as = ctx.work.as?.trim();
	// Resolve BEFORE the board call: a fabricated sha must fail locally, not
	// land as a settled pointer to nothing.
	const metadata = ctx.work.input
		? { ...workMetadataInput(ctx), ...buildSettlementMetadata(ctx.work.commit) }
		: buildSettlementMetadata(ctx.work.commit);
	const call = await boardCall(
		ctx,
		mutationCallable(as, "work.settle_work_item_attempt"),
		withSession(ctx, {
			id,
			attemptId,
			outcome,
			...(ctx.work.note?.trim() ? { summary: ctx.work.note.trim() } : {}),
			...(ctx.work.needsUser ? { needsUser: ctx.work.needsUser } : {}),
			...(ctx.work.requestId ? { requestId: ctx.work.requestId } : {}),
			...(metadata ? { metadata } : {}),
		}),
	);
	if (call.error) {
		// Preserve the pointer on failure: a heartbeat may have raced settlement.
		return fail(
			ctx,
			call.error,
			`Could not settle ${id}: ${call.error.message}`,
		);
	}
	ctx.attemptStore.remove(workAttemptKey(ctx, id), attemptId);
	ctx.recordScope?.({ workItemId: id, heldUntil: 0 });
	return terminalWorkResult(
		ctx,
		id,
		call.value,
		`Settled ${id} (${outcome}).`,
		attemptId,
	);
}

function terminalWorkResult(
	ctx: WorkContext,
	id: string,
	value: unknown,
	message: string,
	attemptId?: string,
): number {
	const session = resolveAgentSession(ctx.work.session);
	let cleanup: ReturnType<typeof cleanupAttemptWorktrees> = [];
	if (session && !session.derived) {
		try {
			cleanup = (ctx.cleanupWorktrees ?? cleanupAttemptWorktrees)({
				workItemId: id,
				agentSession: session.session,
				...(attemptId ? { attemptId } : {}),
			});
		} catch (error) {
			cleanup = [
				{ path: process.cwd(), removed: false, reason: errorText(error) },
			];
		}
	}
	return ok(
		ctx,
		cleanup.length && isRecord(value)
			? { ...value, localWorktreeCleanup: cleanup }
			: value,
		() => {
			console.log(message);
			for (const result of cleanup) {
				console.log(
					`${result.removed ? "Removed" : "Kept"} ${result.path}${result.reason ? `: ${result.reason}` : ""}`,
				);
			}
		},
	);
}

async function workSubmitEvidence(
	ctx: WorkContext,
	id: string,
): Promise<number> {
	if (!id) throw new Error("work submit-evidence requires a work item id");
	id = await resolveWorkItemId(ctx, id);
	const attemptId = cachedAttemptId(ctx, id);
	if (!attemptId)
		return fail(
			ctx,
			missingAttemptResult(id).error!,
			`Could not submit evidence for ${id}: no attempt is cached.`,
		);
	const claimKey = ctx.work.claimKey?.trim();
	const kind = ctx.work.evidenceKind?.trim();
	const uri = ctx.work.evidence?.trim();
	if (!claimKey || !kind || !uri)
		throw new Error(
			"work submit-evidence requires --claim-key, --evidence-kind, and --evidence",
		);
	const as = ctx.work.as?.trim();
	// No client-side digest and no per-kind repackaging: submission is a plain
	// record now, and the kind vocabulary is the server's to police. The
	// `--evidence-digest` demand invited hand-typed sha256 values, so the flag
	// is gone rather than guarded
	// (decisions/minimal-gates-over-pre-proof.md).
	const metadata = ctx.work.evidenceMetadata?.trim()
		? parseObjectArgument(
				ctx.work.evidenceMetadata.trim(),
				"--evidence-metadata",
			)
		: undefined;
	const call = await boardCall(
		ctx,
		mutationCallable(as, "work.submit_work_item_evidence"),
		withSession(ctx, {
			id,
			attemptId,
			claimKey,
			kind,
			uri,
			...(ctx.work.evidenceMediaType?.trim()
				? { mediaType: ctx.work.evidenceMediaType.trim() }
				: {}),
			...(ctx.work.evidenceLabel?.trim()
				? { label: ctx.work.evidenceLabel.trim() }
				: {}),
			...(metadata ? { metadata } : {}),
		}),
	);
	if (call.error)
		return fail(
			ctx,
			call.error,
			`Could not submit evidence for ${id}: ${call.error.message}`,
		);
	return ok(ctx, call.value, () =>
		console.log(`${green("Submitted evidence", ctx.color)} for ${id}.`),
	);
}

async function workComplete(ctx: WorkContext, id: string): Promise<number> {
	if (!id) throw new Error("work complete requires a work item id");
	mutationCallable(ctx.work.as?.trim(), "work.complete_work_item");
	id = await resolveWorkItemId(ctx, id);
	const call = await boardCall(ctx, "work.complete_work_item", { id });
	if (call.error)
		return fail(
			ctx,
			call.error,
			`Could not complete ${id}: ${call.error.message}${ownerActionHint(ctx, call.error)}`,
		);
	return terminalWorkResult(ctx, id, call.value, `Completed ${id}.`);
}

async function workTrailers(ctx: WorkContext, id: string): Promise<number> {
	if (!id) throw new Error("work trailers requires a work item id");
	const identityError = oauthHarnessGuard(ctx);
	if (identityError) {
		return fail(
			ctx,
			identityError,
			`Could not generate trailers: ${identityError.message}`,
		);
	}
	const resolvedId = await resolveWorkItemId(ctx, id);
	const session = resolveAgentSession(ctx.work.session);
	assertUnambiguousSession(session);
	if (isDetectedExternalHarness(session) && session?.derived) {
		throw new Error(
			"work trailers requires an immutable Agent-Session. Set TEDIX_AGENT_SESSION or use the harness-native session id before `tedix agent start`.",
		);
	}
	// Refuse to hand back a trailer the deploy gate will reject.
	//
	// The suffix is intentionally opaque. Immutable Git certification joins this
	// exact value to the settled attempt; only the harness prefix and the
	// control-character/length boundary can be checked locally.
	if (session && !session.derived && !GATE_SESSION_KEY.test(session.session)) {
		throw new Error(
			[
				`Agent-Session "${session.session}" cannot carry Git certification: expected <harness>:<opaque-session-key> without control characters.`,
				"Start a traceable external-agent session and use its exact session key.",
			].join("\n"),
		);
	}
	const trailers = [
		`Work-Item: ${resolvedId}`,
		...(session && !session.derived
			? [`Agent-Session: ${session.session}`]
			: []),
	];
	if (ctx.json) {
		console.log(
			JSON.stringify({
				workItemId: resolvedId,
				agentSession: session?.session,
				trailers,
			}),
		);
	} else {
		console.log(trailers.join("\n"));
	}
	return 0;
}

const HANDOFF_ENV_TO_CLEAR = [
	"TEDIX_AGENT_SESSION",
	"TEDIX_EXTERNAL_AGENT",
	"TEDIX_MCP_BEARER_TOKEN",
	"TEDIX_MCP_API_KEY",
] as const;

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/** One accepted item and an explicit host destination; never transfer a fence. */
async function workHandoff(
	ctx: WorkContext,
	id: string,
	text: string,
): Promise<number> {
	if (!id || text)
		throw new Error("work handoff requires exactly one Work Item id");
	if (ctx.work.as)
		throw new Error(
			"work handoff uses the credential-scoped item; --as is not supported",
		);
	const host = ctx.work.host;
	if (host !== "codex" && host !== "claude")
		throw new Error("work handoff requires --host codex|claude");
	const target = ctx.work.to?.trim().toLowerCase();
	const targetChat = target?.startsWith("codex:") ? target.slice(6) : undefined;
	if (
		ctx.work.to !== undefined &&
		(host !== "codex" || !targetChat || !UUID_RE.test(targetChat))
	)
		throw new Error(
			"handoff --to requires --host codex and an exact codex:<chat UUID>",
		);
	if (!/^[a-zA-Z0-9_-]+$/.test(ctx.workspace))
		throw new Error("work handoff requires a named CLI workspace");
	id = await resolveWorkItemId(ctx, id);
	const call = await getWorkItem(ctx, id);
	if (call.error)
		return fail(ctx, call.error, `Could not read ${id}: ${call.error.message}`);
	const item =
		isRecord(call.value) && isRecord(call.value.workItem)
			? call.value.workItem
			: call.value;
	if (!isRecord(item) || item.id !== id || item.disposition !== "accepted")
		throw new Error(
			`work handoff requires an accepted Work Item; inspect ${id} with work context`,
		);
	let prompt = `Continue Tedix Work Item ${id} in CLI workspace ${ctx.workspace}. Read its current context and readiness through tedix first. Establish your own verified external-agent identity and Agent-Session before any Work mutation. Start or resume only your own admitted Attempt, then heartbeat, settle, and complete it under the Work protocol. The launcher did not transfer an Attempt, credential, or permission to act.`;
	const { prefixLaneBrief } = await import("./lane");
	const recalled = await prefixLaneBrief(
		`${String(item.title ?? "")}\n${String(item.description ?? "")}`,
		[
			"-w",
			ctx.workspace,
			...(process.env.TEDIX_ORGANIZATION
				? ["--organization", process.env.TEDIX_ORGANIZATION]
				: []),
		],
		host === "claude" ? "claude-code" : "codex",
		ctx.organizationId,
	);
	if (recalled.recall) prompt = `${recalled.recall}\n\n${prompt}`;
	if (targetChat) {
		const target = `codex:${targetChat}`;
		const binding = ctx.resolveContext
			? ctx.resolveContext(targetChat)
			: resolveAgentContext({ sessionId: targetChat });
		if (
			binding.status !== "bound" ||
			binding.contextSource !== "chat" ||
			binding.contextSessionId !== targetChat ||
			binding.workspace !== ctx.workspace ||
			!ctx.mcpUrl ||
			binding.mcpUrl !== ctx.mcpUrl ||
			binding.projectId !== item.projectId ||
			(ctx.organizationId !== undefined &&
				binding.organization !== ctx.organizationId)
		)
			throw new Error(
				"Target chat must be explicitly bound to this profile and Work project in this checkout",
			);
		const prior = readDelegations(process.env, target).find((e) => e.id === id);
		if (
			ctx.work.launch &&
			!(
				prior?.launch &&
				prior.to === target &&
				prior.projectId === item.projectId &&
				prior.organization === binding.organization
			)
		)
			recordDelegation(process.env, target, {
				id,
				title: String(item.title ?? id),
				via: "session",
				to: target,
				workspace: ctx.workspace,
				createdAt: new Date().toISOString(),
				launch: true,
				projectId: String(item.projectId),
				organization: binding.organization,
				orgId: String(item.orgId),
				...(prior?.deliveredAt ? { deliveredAt: prior.deliveredAt } : {}),
			});
		if (ctx.work.launch)
			recordLocalSession(process.env, targetChat, "codex", process.cwd());
		return ok(
			ctx,
			{
				workItemId: id,
				target,
				registered: !!ctx.work.launch,
				note: "Exact-chat supervisor handoff; the recipient must obtain its own admission.",
			},
			() =>
				console.log(
					`${ctx.work.launch ? "Registered" : "Preview"} ${id} for ${target}`,
				),
		);
	}
	// The shared Codex daemon can retain a session without dispatching the
	// plugin SessionStart hook. A fresh host process delivers this opt-in brief.
	const args =
		host === "codex" ? ["--no-daemon", "-C", process.cwd(), prompt] : [prompt];
	const command = [
		"env",
		...HANDOFF_ENV_TO_CLEAR.flatMap((name) => ["-u", name]),
		`TEDIX_PLUGIN_PREFLIGHT=1`,
		`TEDIX_WORKSPACE=${ctx.workspace}`,
		`TEDIX_WORK_ITEM_ID=${id}`,
		host,
		...(host === "codex"
			? ["--no-daemon", "-C", shellQuote(process.cwd())]
			: []),
		shellQuote(prompt),
	].join(" ");
	if (!ctx.work.launch) {
		const preview = {
			workItemId: id,
			workspace: ctx.workspace,
			host,
			command,
			note: "Read-only preview. Add --launch to start a new host session; the host must establish its own identity and Attempt.",
		};
		console.log(
			ctx.json ? JSON.stringify(preview) : `${command}\n${preview.note}`,
		);
		return 0;
	}
	const env: NodeJS.ProcessEnv = {
		...process.env,
		TEDIX_PLUGIN_PREFLIGHT: "1",
		TEDIX_WORKSPACE: ctx.workspace,
		TEDIX_WORK_ITEM_ID: id,
	};
	for (const name of HANDOFF_ENV_TO_CLEAR) delete env[name];
	if (ctx.launchHost) return ctx.launchHost(host, args, env);
	const result = spawnSync(host, args, {
		cwd: process.cwd(),
		env,
		stdio: "inherit",
	});
	if (result.error)
		throw new Error(`Could not launch ${host}: ${result.error.message}`);
	return result.status ?? 1;
}

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

interface StructuredFactoryVerb {
	tool: string;
	namespace?: "projects" | "work" | "agent";
	write: boolean;
	pathField?: string;
	defaultInput?: (ctx: WorkContext) => Record<string, unknown>;
	transform?: (
		input: Record<string, unknown>,
		ctx: WorkContext,
	) => Record<string, unknown>;
}

const STRUCTURED_FACTORY_VERBS: Record<string, StructuredFactoryVerb> = {
	"dispatch-list": { tool: "list_work_items", write: false },
	"dispatch-get": {
		tool: "get_work_items_by_id",
		write: false,
		pathField: "id",
	},
	"dispatch-attempts": {
		tool: "list_work_item_attempts",
		write: false,
		pathField: "id",
	},
	"agent-turn-triage": {
		tool: "triage_agent_turn",
		namespace: "agent",
		write: false,
	},
	"agent-reply-label": {
		tool: "label_agent_reply",
		namespace: "agent",
		write: false,
	},
	"agent-reply-draft-request": {
		tool: "request_agent_reply_draft",
		namespace: "agent",
		write: true,
	},
	"agent-session-report": {
		tool: "report_work_agent_session_status",
		write: true,
	},
	"case-list": {
		tool: "list_work_cases",
		write: false,
		defaultInput: (ctx) => ({ limit: ctx.work.limit ?? 50 }),
	},
	"case-get": { tool: "get_work_case", write: false, pathField: "caseId" },
	"case-create": { tool: "create_work_case", write: true },
	"case-stage": { tool: "update_work_case", write: true, pathField: "caseId" },
	"case-close": {
		tool: "update_work_case",
		write: true,
		pathField: "caseId",
		transform: (input) => ({ ...input, stage: "closed" }),
	},
	"case-attach": {
		tool: "attach_work_case_item",
		write: true,
		pathField: "caseId",
	},
	"case-dependency-add": { tool: "add_work_case_dependency", write: true },
	"milestone-list": {
		tool: "list_project_milestones",
		namespace: "projects",
		write: false,
		pathField: "id",
	},
	"milestone-create": {
		tool: "create_project_milestone",
		namespace: "projects",
		write: true,
		pathField: "id",
	},
	"milestone-update": {
		tool: "update_project_milestone",
		namespace: "projects",
		write: true,
		pathField: "id",
	},
	"milestone-attach": {
		tool: "attach_project_milestone_work_item",
		namespace: "projects",
		write: true,
		pathField: "id",
	},
	"milestone-dependency-add": {
		tool: "add_project_milestone_dependency",
		namespace: "projects",
		write: true,
		pathField: "id",
	},
	"health-list": {
		tool: "list_project_health_judgments",
		namespace: "projects",
		write: false,
		pathField: "id",
	},
	"health-record": {
		tool: "record_project_health_judgment",
		namespace: "projects",
		write: true,
		pathField: "id",
	},
	"approval-list": {
		tool: "list_work_approvals",
		write: false,
		defaultInput: (ctx) => ({ limit: ctx.work.limit ?? 50 }),
	},
	"approval-audit-list": {
		tool: "list_work_approval_audit",
		write: false,
		defaultInput: (ctx) => ({ limit: ctx.work.limit ?? 50 }),
	},
	"approval-propose": { tool: "propose_work_approval", write: true },
	"approval-decide": {
		tool: "decide_work_approval",
		write: true,
		pathField: "proposalId",
	},
	"interaction-list": {
		tool: "list_work_interaction_cli_rows",
		write: false,
		defaultInput: (ctx) => ({ limit: Math.min(5, ctx.work.limit ?? 5) }),
	},
	"interaction-audit-list": {
		tool: "list_work_interaction_audit",
		write: false,
		defaultInput: (ctx) => ({ limit: ctx.work.limit ?? 50 }),
	},
	"interaction-outbox-list": {
		tool: "list_work_interaction_outbox",
		write: false,
		defaultInput: (ctx) => ({ limit: ctx.work.limit ?? 50 }),
	},
	"interaction-get": {
		tool: "get_work_interaction",
		write: false,
		pathField: "requestId",
		defaultInput: () => ({}),
	},
	"interaction-create": {
		tool: "create_work_interaction",
		write: true,
		transform: (input, ctx) => withSession(ctx, input),
	},
	"interaction-respond": {
		tool: "respond_work_interaction",
		write: true,
		pathField: "requestId",
		// --no-deliver: response metadata.delivery="none" (a closure the
		// asking session need not see; never listed as undelivered).
		transform: (input, ctx) =>
			ctx.work.noDeliver
				? {
						...input,
						metadata: {
							...(isRecord(input.metadata) ? input.metadata : {}),
							delivery: "none",
						},
					}
				: input,
	},
	"interaction-cancel": {
		tool: "cancel_work_interaction",
		write: true,
		pathField: "requestId",
		transform: (input, ctx) => ({
			...input,
			confirmDestructive: true,
			reason:
				ctx.work.reason?.trim() || "User requested work interaction-cancel",
		}),
	},
	"interaction-undelivered": {
		tool: "list_undelivered_work_interaction_responses",
		write: false,
		defaultInput: (ctx) => ({ limit: ctx.work.limit ?? 50 }),
	},
	"interaction-ack": { tool: "ack_work_interaction_delivery", write: true },
	"interaction-draft-delivered": {
		tool: "record_reply_draft_delivery",
		write: true,
		pathField: "requestId",
	},
	"admission-get": {
		tool: "get_work_admission_specification",
		write: false,
		pathField: "id",
	},
	"admission-replace": {
		tool: "replace_work_admission_specification",
		write: true,
		pathField: "id",
	},
	"resource-list": {
		tool: "list_work_resource_pools",
		write: false,
		defaultInput: (ctx) => ({ limit: ctx.work.limit ?? 50 }),
	},
	"resource-put": { tool: "put_work_resource_pool", write: true },
	"budget-list": {
		tool: "list_work_budget_envelopes",
		write: false,
		defaultInput: (ctx) => ({ limit: ctx.work.limit ?? 50 }),
	},
	"budget-put": { tool: "put_work_budget_envelope", write: true },
	fleet: {
		tool: "get_work_fleet_control_tower",
		write: false,
		defaultInput: () => ({}),
	},
	clusters: {
		tool: "plan_work_execution_clusters",
		write: false,
		defaultInput: (ctx) => ({
			limit: ctx.work.limit ?? 100,
			candidateLimit: 10,
			maxParallelism: 8,
		}),
	},
	scheduler: {
		tool: "list_ready_work",
		write: false,
		defaultInput: (ctx) => ({
			limit: ctx.work.limit ?? 20,
			candidateLimit: 200,
		}),
	},
};

function structuredFactoryInput(
	ctx: WorkContext,
	verb: string,
	spec: StructuredFactoryVerb,
	pathId: string,
): Record<string, unknown> {
	const raw = ctx.work.input?.trim();
	if (!raw) {
		const defaults = spec.defaultInput?.(ctx);
		if (defaults) {
			const withPath =
				spec.pathField && pathId
					? { ...defaults, [spec.pathField]: pathId }
					: defaults;
			return spec.transform?.(withPath, ctx) ?? withPath;
		}
		throw new Error(`work ${verb} requires --input <json|@path>`);
	}
	const parsed = parseObjectArgument(raw, "--input");
	const input =
		spec.pathField && pathId ? { ...parsed, [spec.pathField]: pathId } : parsed;
	return spec.transform?.(input, ctx) ?? input;
}

async function workStructuredFactory(
	ctx: WorkContext,
	verb: string,
	pathId: string,
): Promise<number> {
	const spec = STRUCTURED_FACTORY_VERBS[verb];
	if (!spec) throw new Error(`Unknown structured Work factory verb ${verb}`);
	const callable = `${spec.namespace ?? "work"}.${spec.tool}`;
	if (spec.write) mutationCallable(ctx.work.as?.trim(), callable);
	else if (ctx.work.as?.trim())
		throw new Error(
			`work ${verb} does not expose a tedi-scoped callable; remove --as and use the credential-scoped canonical read`,
		);
	if (ctx.work.executorTedi && verb !== "clusters")
		throw new Error("--executor-tedi is only valid with work clusters");
	let input = structuredFactoryInput(ctx, verb, spec, pathId);
	if (verb === "clusters") {
		const embeddedExecutor = isRecord(input.executor)
			? input.executor
			: undefined;
		const embedded =
			embeddedExecutor?.type === "tedi" &&
			typeof embeddedExecutor.id === "string"
				? embeddedExecutor.id
				: undefined;
		if (ctx.work.executorTedi && embedded && ctx.work.executorTedi !== embedded)
			throw new Error("--executor-tedi conflicts with executor.id in --input");
		const selected = ctx.work.executorTedi ?? embedded;
		if (ctx.authSource?.startsWith("stored-login") && !selected)
			throw new Error(
				"Operator cluster planning requires --executor-tedi <uuid>",
			);
		if (ctx.work.executorTedi)
			input = {
				...input,
				executor: { type: "tedi", id: ctx.work.executorTedi },
			};
	}
	const call = await boardCall(ctx, callable, input);
	if (call.error) {
		return fail(
			ctx,
			call.error,
			`Could not run work ${verb}: ${call.error.message}`,
		);
	}
	return ok(ctx, call.value, () =>
		console.log(JSON.stringify(call.value, null, 2)),
	);
}

async function workClaimFiles(
	ctx: WorkContext,
	id: string,
	text: string,
): Promise<number> {
	if (!id || text)
		throw new Error(
			"work claim-files requires exactly one Work Item id; pass files with --path",
		);
	mutationCallable(ctx.work.as, "work.replace_work_admission_specification");
	if (ctx.work.input)
		throw new Error("work claim-files uses --repo-key and --path, not --input");
	const keys = fileResourceKeys(ctx.work.repoKey, ctx.work.paths);
	id = await resolveWorkItemId(ctx, id);
	const result = await claimFiles(id, keys, (tool, input) =>
		boardCall(ctx, tool, input),
	);
	if (result.error) return fail(ctx, result.error, result.error.message);
	return ok(ctx, result.value, () =>
		console.log(
			`${result.value.changed ? "Declared" : "Already declared"} ${keys.length} file requirement(s) for ${id}. Resources are reserved only at work start.`,
		),
	);
}

// ─── Delegation ledger ───────────────────────────────────────────────────────

/** Default purpose window of a delegation filed without --objective. */
const DELEGATION_EXPIRES = "14d";

/**
 * `tedix work delegate "<title>" --done-when "…" --via subagent|session`:
 * the lead session registers work it handed off as one accepted Work Item
 * (reused when an open item has the same title), with the brief as a comment,
 * and remembers the id locally so its prompt context names it until settled.
 * `--done <id> --note "…"` records the outcome and completes the item.
 */
async function workDelegate(ctx: WorkContext, title: string): Promise<number> {
	mutationCallable(ctx.work.as?.trim(), "work.create_work_items");
	const lead = resolveAgentSession(ctx.work.session);
	assertUnambiguousSession(lead);
	if (!lead || lead.derived || !delegationKey(lead.session))
		throw new Error(
			"work delegate needs the lead session's id: run it inside Claude Code or Codex, or pass --session <id>",
		);
	if (ctx.work.done?.trim()) return settleDelegation(ctx, lead.session);
	const t = title.trim();
	const via = ctx.work.via?.trim();
	const doneWhen = ctx.work.doneWhen?.trim();
	if (!t || !doneWhen || (via !== "subagent" && via !== "session"))
		throw new Error(
			'work delegate requires "<title>" --done-when "<what done looks like>" --via subagent|session',
		);
	const to = ctx.work.to?.trim() || undefined;
	const delegation = {
		via,
		...(to ? { to } : {}),
		leadSession: lead.session,
	};
	const search = await listWorkItems(ctx, {
		titleContains: t.slice(0, 200),
		limit: 20,
		...projectArg(ctx.work.project),
	});
	if (search.error)
		return fail(
			ctx,
			search.error,
			`Could not search work items: ${search.error.message}`,
		);
	const existing = itemsFromList(search.value).find(
		(row) =>
			String(row.title ?? "").toLowerCase() === t.toLowerCase() &&
			(row.disposition === "proposed" || row.disposition === "accepted"),
	);
	let id = typeof existing?.id === "string" ? existing.id : "";
	let disposition = String(existing?.disposition ?? "proposed");
	if (!id) {
		const { objective, workClass } = ctx.work;
		if (workClass && !CREATE_EXCEPTION_CLASSES.has(workClass))
			throw new Error(
				`--class must be one of maintenance|incident|hygiene, got "${workClass}"`,
			);
		const created = await boardCall(
			ctx,
			"work.create_work_items",
			withSession(ctx, {
				title: t,
				description: `Delegated by lead session ${lead.session} via ${via}${to ? ` to ${to}` : ""}.\n\nDone when: ${doneWhen}`,
				...(ctx.work.kind ? { workKind: ctx.work.kind } : {}),
				// A project carries its own purpose; an unparented delegation is a
				// time-bounded maintenance exception unless told otherwise.
				...(objective
					? { objectiveId: objective.trim() }
					: workClass || !ctx.work.project
						? {
								workClass: workClass ?? "maintenance",
								purposeExceptionExpiresAt: expiresToIso(
									ctx.work.expires ?? DELEGATION_EXPIRES,
								),
							}
						: {}),
				...projectArg(ctx.work.project),
				metadata: { delegation },
			}),
		);
		if (created.error)
			return fail(
				ctx,
				created.error,
				`Could not create the delegation: ${created.error.message}`,
			);
		const item = isRecord(created.value)
			? isRecord(created.value.workItem)
				? created.value.workItem
				: created.value
			: {};
		id = typeof item.id === "string" ? item.id : "";
		disposition = String(item.disposition ?? "proposed");
		if (!id)
			return fail(
				ctx,
				{ code: "MISSING_ID", message: "create returned no id" },
				"Could not create the delegation: the board returned no id.",
			);
	}
	if (disposition === "proposed") {
		const accepted = await boardCall(ctx, "work.accept_work_item", {
			id,
			acceptanceContract: buildAcceptanceContract(doneWhen),
		});
		if (accepted.error)
			return fail(
				ctx,
				accepted.error,
				`Created ${id} but could not accept it: ${accepted.error.message}`,
			);
	}
	const brief = await postComment(
		ctx,
		id,
		`Delegation brief (via ${via}${to ? ` → ${to}` : ""}; lead session ${lead.session}): ${t}\nDone when: ${doneWhen}\nSettle with: tedix work delegate --done ${id} --note "<outcome and evidence>"`,
		{ delegation },
	);
	if (brief.error)
		return fail(
			ctx,
			brief.error,
			`Could not comment the brief on ${id}: ${brief.error.message}`,
		);
	recordDelegation(process.env, lead.session, {
		id,
		title: t,
		via,
		...(to ? { to } : {}),
		workspace: ctx.workspace,
		createdAt: new Date().toISOString(),
	});
	const reused = Boolean(existing);
	return ok(ctx, { id, reused, via, ...(to ? { to } : {}) }, () =>
		console.log(
			`${green(reused ? "Reused" : "Delegated", ctx.color)} ${id}  via ${via}${to ? ` → ${to}` : ""}  ${truncate(t, 60)}`,
		),
	);
}

async function settleDelegation(
	ctx: WorkContext,
	leadSession: string,
): Promise<number> {
	const note = ctx.work.note?.trim();
	if (!note)
		throw new Error(
			'work delegate --done <id> requires --note "<outcome and evidence>"',
		);
	const id = await resolveWorkItemId(ctx, ctx.work.done!.trim());
	const settlement = buildSettlementMetadata(ctx.work.commit);
	const comment = await postComment(ctx, id, `Delegation settled: ${note}`, {
		delegation: { settled: true },
		...settlement,
	});
	if (comment.error)
		return fail(
			ctx,
			comment.error,
			`Could not record the outcome on ${id}: ${comment.error.message}`,
		);
	const call = await boardCall(ctx, "work.complete_work_item", { id });
	if (call.error)
		return fail(
			ctx,
			call.error,
			`Recorded the outcome on ${id} but could not complete it: ${call.error.message}`,
		);
	forgetDelegations(process.env, leadSession, [id]);
	return ok(ctx, call.value, () =>
		console.log(`${green("Settled delegation", ctx.color)} ${id}.`),
	);
}

async function workCancel(ctx: WorkContext, id: string): Promise<number> {
	if (!id) throw new Error("work cancel requires a work item id");
	mutationCallable(ctx.work.as?.trim(), "work.cancel_work_items");
	id = await resolveWorkItemId(ctx, id);
	const call = await boardCall(ctx, "work.cancel_work_items", {
		id,
		...(ctx.work.reason ? { reason: ctx.work.reason } : {}),
	});
	if (call.error)
		return fail(
			ctx,
			call.error,
			`Could not cancel ${id}: ${call.error.message}`,
		);
	return terminalWorkResult(ctx, id, call.value, `Cancelled ${id}.`);
}

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
