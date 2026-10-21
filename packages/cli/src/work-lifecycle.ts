import { setTimeout as sleep } from "node:timers/promises";
import { resolveCommitFlag } from "./local-context";
import { dim, errorText, green } from "./format";
import { isRateLimitError, rateLimitRetryAfterMs } from "./home-rate-limit";
import {
	cleanupAttemptWorktrees,
	provisionAttemptWorktree,
} from "./worktree-adapter";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import {
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
import { boardCall } from "./work-native";
import { fail, ok } from "./work-render";
import { resolveWorkItemId, parseObjectArgument } from "./work-queries";
import type { WorkContext } from "./work";

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

export async function workStart(ctx: WorkContext, id: string): Promise<number> {
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

export async function workHeartbeat(
	ctx: WorkContext,
	id: string,
): Promise<number> {
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

export async function workAccept(
	ctx: WorkContext,
	id: string,
): Promise<number> {
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

export async function workSettle(
	ctx: WorkContext,
	id: string,
): Promise<number> {
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

export async function workSubmitEvidence(
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

export async function workComplete(
	ctx: WorkContext,
	id: string,
): Promise<number> {
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

export async function workTrailers(
	ctx: WorkContext,
	id: string,
): Promise<number> {
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

export async function workCancel(
	ctx: WorkContext,
	id: string,
): Promise<number> {
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
