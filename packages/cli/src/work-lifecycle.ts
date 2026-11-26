import {
	WorkAttemptSettlementSchema,
	workExecutorReference,
} from "@tedix/api-contract/schemas/work-items";
import { setTimeout as sleep } from "node:timers/promises";
import { resolveCommitFlag } from "./local-context";
import { dim, errorText, green } from "./format";
import { isRateLimitError, rateLimitRetryAfterMs } from "./home-rate-limit";
import { transientReadFailure } from "./read-retry";
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
import { createLeaseRenewer } from "./lease-renewer";
import { boardCall } from "./work-native";
import { fail, ok } from "./work-render";
import {
	resolveWorkItemId,
	parseObjectArgument,
	workTaskContract,
	workExecutorArg,
	workOwnerArgs,
} from "./work-queries";
import type { WorkContext } from "./work";

/** Renew a revoked machine credential once, keeping the same Attempt. */
export function isHeartbeatCredentialRejected(error: {
	code?: string;
	message: string;
}): boolean {
	return (
		error.code === "external_agent_inactive" ||
		error.message.includes("external_agent_inactive")
	);
}

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

export async function workStart(
	ctx: WorkContext,
	id: string,
	onStarted?: (attempt: Record<string, unknown>) => void,
): Promise<number> {
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
	if (isRecord(attempt)) onStarted?.(attempt);
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
			`Could not heartbeat ${id}: no attempt id is cached. Start the item in this workspace first.`,
		);
	}
	const clock = ctx.heartbeatClock ?? { now: Date.now, wait: sleep };
	const deadline = clock.now() + (ctx.work.watch ?? 0) * 1_000;
	const callable = mutationCallable(
		ctx.work.as,
		"work.heartbeat_work_item_attempt",
	);
	let rateRetries = 0;
	let credentialRenewed = false;
	let rateRetryError: Parameters<typeof fail>[1] | undefined;
	let thrown: unknown;
	let result: number | undefined;
	const renewer = createLeaseRenewer({
		now: clock.now,
		wait: clock.wait,
		...(ctx.work.watch !== undefined ? { horizonAt: deadline } : {}),
		onHorizon: () => {
			if (rateRetryError) {
				result = fail(
					ctx,
					rateRetryError,
					"Heartbeat retry reached the original watch horizon; watch stopped.",
				);
				return;
			}
			const expiresAt = renewer.expiresAt();
			console.error(
				`Heartbeat watch reached its ${ctx.work.watch} s horizon; the Attempt lease expires at ${expiresAt ? new Date(expiresAt).toISOString() : "unknown"}. Run it again to keep renewing.`,
			);
			result = 0;
		},
		onLost: () => {
			result = fail(
				ctx,
				{
					code: "INVALID_LEASE",
					message:
						"The last confirmed Attempt lease expired; heartbeat watch stopped.",
				},
				"The last confirmed Attempt lease expired; heartbeat watch stopped.",
			);
		},
		step: async ({ expiresAt: leaseExpiry }) => {
			rateRetryError = undefined;
			try {
				const touch = await boardCall(ctx, callable, { id, attemptId });
				if (touch.error) {
					const { status } = touch.error;
					// The gateway can revoke a credential before its cached expiry. Drop it
					// once so the next call exchanges a fresh one for the same session and
					// Attempt; a second consecutive rejection still stops the watch.
					if (isHeartbeatCredentialRejected(touch.error)) {
						if (ctx.discardCredential && !credentialRenewed) {
							credentialRenewed = true;
							ctx.discardCredential();
							console.error(
								"Heartbeat credential was rejected; retrying the same Attempt with a fresh credential.",
							);
							return { kind: "retry", delayMs: 0 };
						}
						const message =
							"Heartbeat credential could not be renewed; stopped.";
						result = fail(ctx, { ...touch.error, message }, message);
						return { kind: "stop" };
					}
					const rateLimited =
						status === 429 ||
						(status === undefined && isRateLimitError(touch.error.message));
					// A timeout, dropped connection or 5xx says nothing about the lease.
					// Coded socket failures (ECONNRESET, ETIMEDOUT) and deadline errors
					// arrive with a code or message, so the bare no-code/no-status check
					// alone would mistake them for a refusal.
					const transient =
						transientReadFailure(touch.error) ||
						(touch.error.status === undefined &&
							touch.error.code === undefined);
					// Retry only after a confirmed renewal and inside that lease; a guessed
					// lease never grants permission to keep trying.
					if (
						ctx.work.watch !== undefined &&
						(rateLimited || transient) &&
						leaseExpiry !== undefined
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
						const retryDeadline = Math.min(deadline, leaseExpiry);
						const reason = rateLimited ? "rate limited" : touch.error.message;
						if (clock.now() + delay >= retryDeadline) {
							const message = `Heartbeat failed (${reason}) and cannot retry within the original watch horizon and confirmed lease; watch stopped.`;
							result = fail(ctx, { ...touch.error, message }, message);
							return { kind: "stop" };
						}
						rateRetries++;
						rateRetryError = touch.error;
						console.error(
							`Heartbeat ${reason}; retrying the same Attempt in ${delay / 1000}s.`,
						);
						return { kind: "retry", delayMs: delay };
					}
					// A stale response can be a concurrent-write conflict, not a dead lease.
					// Keep the lookup pointer; every retry still revalidates server authority.
					result = fail(
						ctx,
						touch.error,
						`Could not heartbeat ${id}: ${touch.error.message}`,
					);
					return { kind: "stop" };
				}
				credentialRenewed = false;
				const expiresAt =
					isRecord(touch.value) && typeof touch.value.expiresAt === "string"
						? touch.value.expiresAt
						: undefined;
				if (expiresAt && Date.parse(expiresAt) > clock.now())
					ctx.recordScope?.({
						workItemId: id,
						heldUntil: Date.parse(expiresAt),
					});
				ok(ctx, touch.value, () => {
					console.log(
						`${green("Heartbeat", ctx.color)} touched attempt ${attemptId} on ${id}${expiresAt ? ` (attempt expires ${expiresAt})` : ""}.`,
					);
				});
				if (ctx.work.watch === undefined) {
					result = 0;
					return { kind: "stop" };
				}
				const renewedExpiry = expiresAt ? Date.parse(expiresAt) : NaN;
				if (!Number.isFinite(renewedExpiry) || renewedExpiry <= clock.now()) {
					result = fail(
						ctx,
						{
							code: "INVALID_LEASE",
							message: "Heartbeat returned no future expiry; watch stopped.",
						},
						"Heartbeat returned no future expiry; watch stopped.",
					);
					return { kind: "stop" };
				}
				rateRetries = 0;
				return { kind: "renewed", expiresAt: renewedExpiry };
			} catch (error) {
				thrown = error;
				return { kind: "stop" };
			}
		},
	});
	await renewer.done;
	if (thrown !== undefined) throw thrown;
	return result ?? 0;
}

/** Build the plain-language acceptance; optional task terms are supplied separately. */
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
	const executor = workExecutorArg(ctx.work.executor);
	const acceptanceContract = {
		...buildAcceptanceContract(ctx.work.doneWhen),
		...workTaskContract(ctx.work.taskContract),
	};
	const owner = workOwnerArgs(ctx.work.owner);
	id = await resolveWorkItemId(ctx, id);
	// Persist assignments through the guarded specification API before accepting.
	if (executor || owner) {
		const assignment = await boardCall(
			ctx,
			"work.update_work_item_specification",
			{
				id,
				...(executor
					? { executorReference: workExecutorReference(executor) }
					: {}),
				...owner,
			},
		);
		if (assignment.error)
			return fail(
				ctx,
				assignment.error,
				`Could not assign ${id}; acceptance was not attempted: ${assignment.error.message}${ownerActionHint(ctx, assignment.error)}`,
			);
	}
	const call = await boardCall(ctx, "work.accept_work_item", {
		id,
		acceptanceContract,
	});
	if (call.error)
		return fail(
			ctx,
			call.error,
			`Could not accept ${id}${executor ? ` (executor is assigned to ${executor})` : ""}${owner ? ` (owner is assigned to ${ctx.work.owner?.trim()})` : ""}: ${call.error.message}${ownerActionHint(ctx, call.error)}`,
		);
	return ok(ctx, call.value, () =>
		console.log(`${green("Accepted", ctx.color)} ${id}.`),
	);
}

/** Resolve abbreviated Git IDs and keep the input order without duplicates. */
export function resolveSettlementCommits(
	commits: readonly string[] | undefined,
	cwd = process.cwd(),
): string[] | undefined {
	const resolved = [
		...new Set(
			(commits ?? [])
				.filter((value) => value.trim())
				.map((value) => resolveCommitFlag(value, cwd)),
		),
	];
	return resolved.length ? resolved : undefined;
}

export async function workSettle(
	ctx: WorkContext,
	id: string,
	attemptId?: string,
): Promise<number> {
	if (!id) throw new Error("work settle requires a work item id");
	id = await resolveWorkItemId(ctx, id);
	attemptId ??= cachedAttemptId(ctx, id) ?? undefined;
	const outcome = ctx.work.outcome?.trim();
	if (
		!outcome ||
		![
			"succeeded",
			"landed_unverified",
			"failed",
			"rejected",
			"cancelled",
			"expired",
		].includes(outcome)
	) {
		throw new Error(
			"work settle requires --outcome succeeded|landed_unverified|failed|rejected|cancelled|expired",
		);
	}
	if (!attemptId)
		return fail(
			ctx,
			missingAttemptResult(id).error!,
			`Could not settle ${id}: no attempt id is cached.`,
		);
	const as = ctx.work.as?.trim();
	// Resolve BEFORE the board call: a fabricated sha must fail locally, not
	// land as a settled pointer to nothing.
	const input = ctx.work.input
		? parseObjectArgument(ctx.work.input, "--input")
		: {};
	if (
		Object.keys(input).some(
			(key) => !["metadata", "settlement", "complete"].includes(key),
		) ||
		(input.metadata !== undefined && !isRecord(input.metadata))
	)
		throw new Error("settle --input accepts metadata, settlement and complete");
	const metadata = input.metadata;
	const commits = resolveSettlementCommits(ctx.work.commit);
	if (commits && input.settlement !== undefined)
		throw new Error("Use --commit or an input settlement, not both");
	const settlement = commits
		? { mode: "commit" as const, commitShas: commits }
		: input.settlement === undefined
			? undefined
			: WorkAttemptSettlementSchema.parse(input.settlement);
	const call = await boardCall(
		ctx,
		mutationCallable(as, "work.settle_work_item_attempt"),
		withSession(ctx, {
			id,
			attemptId,
			outcome,
			...(ctx.work.note?.trim() ? { summary: ctx.work.note.trim() } : {}),
			...(settlement ? { settlement } : {}),
			...(input.complete !== undefined ? { complete: input.complete } : {}),
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
			const attempt =
				isRecord(value) && isRecord(value.attempt) ? value.attempt : null;
			const metadata =
				attempt && isRecord(attempt.metadata) ? attempt.metadata : null;
			if (metadata && isRecord(metadata.runnerMetrics))
				console.log(
					`Runner metrics: ${JSON.stringify(metadata.runnerMetrics)}`,
				);
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
			`Could not submit evidence for ${id}: no attempt id is cached.`,
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

export async function workParent(
	ctx: WorkContext,
	id: string,
	parent: string,
): Promise<number> {
	if (!id || !parent.trim() || parent.trim().includes(" "))
		throw new Error("work parent requires <id> <parent|none>");
	mutationCallable(ctx.work.as?.trim(), "work.set_work_item_parent");
	id = await resolveWorkItemId(ctx, id);
	const parentWorkItemId =
		parent.trim() === "none"
			? null
			: await resolveWorkItemId(ctx, parent.trim());
	const call = await boardCall(ctx, "work.set_work_item_parent", {
		id,
		parentWorkItemId,
	});
	if (call.error) return fail(ctx, call.error, call.error.message);
	return ok(ctx, call.value, () =>
		console.log(`Set parent of ${id} to ${parentWorkItemId ?? "none"}.`),
	);
}

export async function workUnrelate(
	ctx: WorkContext,
	id: string,
	related: string,
): Promise<number> {
	if (!id || !related.trim() || related.trim().includes(" ") || !ctx.work.kind)
		throw new Error("work unrelate requires <id> <related> --kind <kind>");
	mutationCallable(ctx.work.as?.trim(), "work.remove_work_relation");
	id = await resolveWorkItemId(ctx, id);
	const relatedWorkItemId = await resolveWorkItemId(ctx, related.trim());
	const call = await boardCall(ctx, "work.remove_work_relation", {
		workItemId: id,
		relatedWorkItemId,
		kind: ctx.work.kind,
	});
	if (call.error) return fail(ctx, call.error, call.error.message);
	return ok(ctx, call.value, () =>
		console.log(
			`Removed ${ctx.work.kind} relation from ${id} to ${relatedWorkItemId}.`,
		),
	);
}

export async function workMove(ctx: WorkContext, id: string): Promise<number> {
	if (!id) throw new Error("work move requires a work item id");
	const project = ctx.work.project?.trim();
	if (
		!project ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
			project,
		)
	)
		throw new Error("work move requires --project <project UUID>");
	mutationCallable(ctx.work.as?.trim(), "work.update_work_item_specification");
	id = await resolveWorkItemId(ctx, id);
	const call = await boardCall(ctx, "work.update_work_item_specification", {
		id,
		projectId: project,
	});
	if (call.error)
		return fail(
			ctx,
			call.error,
			`Could not move ${id}: ${call.error.message}${ownerActionHint(ctx, call.error)}`,
		);
	return ok(ctx, call.value, () =>
		console.log(`${green("Moved", ctx.color)} ${id} to project ${project}.`),
	);
}

/** Set or clear the start date; runners are not handed Work before it. */
export async function workNotBefore(
	ctx: WorkContext,
	id: string,
	when: string,
): Promise<number> {
	const usage =
		"work not-before requires a work item id and a time such as 2026-12-01 or 2026-12-01T09:00:00Z, or clear";
	const text = when.trim();
	if (!id || !text) throw new Error(usage);
	const at = Date.parse(
		/^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00Z` : text,
	);
	if (text !== "clear" && !Number.isFinite(at)) throw new Error(usage);
	const startAt = text === "clear" ? null : new Date(at).toISOString();
	mutationCallable(ctx.work.as?.trim(), "work.update_work_item_specification");
	id = await resolveWorkItemId(ctx, id);
	const call = await boardCall(ctx, "work.update_work_item_specification", {
		id,
		startAt,
	});
	if (call.error)
		return fail(
			ctx,
			call.error,
			`Could not set the start date of ${id}: ${call.error.message}${ownerActionHint(ctx, call.error)}`,
		);
	return ok(ctx, call.value, () =>
		console.log(
			startAt
				? `${green("Set", ctx.color)} ${id} to start no earlier than ${startAt}. Runners are not handed it before then.`
				: `${green("Cleared", ctx.color)} the start date of ${id}.`,
		),
	);
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
