import { buildTediConversationId } from "@tedix/api-contract/utils/runtime-identity";
import {
	type CompactionResult,
	DEFAULT_KEEP_RECENT_TOKENS,
	type TediSessionRepo,
} from "@tedix/tedi-session/session-repo";
import { buildCompactionLedgerPayload } from "./compaction-ledger";
import { sanitizeTurnKey } from "./ledger-mirror";
import { summarizeContextEntries } from "./pi-compaction";
import { logTediRuntimeFailure } from "./runtime-failure-log";
import type { RuntimeMemoryHost } from "./runtime-memory";

/**
 * Per-session compaction callback (queued, retried). Runs AFTER the assistant
 * turn is committed so the just-appended turns are part of the window. The DO
 * has no `waitUntil`, so compaction goes through the same durable
 * `this.queue(...)` substrate as `onBridgeTurn` / `onLedgerMirror` rather than
 * a bare fire-and-forget that a hibernating DO could drop.
 *
 * `compactSession` itself is a FAST NO-OP unless the session exceeds the
 * keep-recent-token budget (it walks the branch and returns early when the
 * head fits), so it is safe to enqueue every turn. The summarizer port is
 * best-effort: a `null`/throw makes the repo append no marker and never throws
 * into the queue. Non-destructive — the marker is an append-only read-time
 * overlay; the original `session_entries` rows stay on disk.
 */
export async function onCompactSession(
	this: RuntimeMemoryHost,
	payload: {
		sessionKey: string;
		operationId: string;
	},
): Promise<void> {
	if (typeof payload.operationId !== "string")
		throw new Error("Compaction callback lacks accepted operation");
	await this.runCompaction(payload.sessionKey, undefined, payload.operationId);
}

export async function prepareCompaction(
	this: RuntimeMemoryHost,
	sessionKey: string,
	opts?: { keepRecentTokens?: number },
) {
	await this.ensureIdentity();
	const modelRef = this.modelOverrideForSurface("observer")?.modelRef ?? null;
	const input = {
		kind: "session-compaction",
		sessionKey,
		options: {
			keepRecentTokens: opts?.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS,
			modelRef,
			deployment: modelRef?.startsWith("azure-openai/")
				? (this.observerDeploymentForTurn() ?? null)
				: null,
		},
		source: JSON.parse(
			JSON.stringify(this.sessionRepo.getBranch(sessionKey)),
		) as ReturnType<TediSessionRepo["getBranch"]>,
	};
	const operationId = `${this.state.tediId}:compaction:${await this.runtimeReceiptHash(input)}`;
	await this.acceptRuntimeTurn(operationId, sessionKey, input);
	const key = `runtime-compaction:${operationId}`;
	return this.ctx.storage.transactionSync(() => {
		const previous = this.ctx.storage.kv.get<{
			input: typeof input;
			stage: "accepted" | "running" | "completed";
			result?: CompactionResult | null;
			modelReceipt?: unknown;
		}>(key);
		if (previous && JSON.stringify(previous.input) !== JSON.stringify(input))
			throw new Error("Compaction immutable input changed");
		if (!previous) this.ctx.storage.kv.put(key, { input, stage: "accepted" });
		return operationId;
	});
}

/**
 * Run one compaction pass AND make it OBSERVABLE — the shared seam behind both
 * the queued {@link onCompactSession} (per-turn, default budget) and the admin
 * FORCE hook (`/__admin/force-compact`, tiny budget). Delegates the cut to
 * `sessionRepo.compactSession` (non-destructive read-time overlay), then, ONLY
 * when a marker was actually appended, emits ONE canonical `context.compacted`
 * runtime event into D1 `tedi_runtime_events` so the compaction is queryable in
 * the ledger.
 *
 * The event id embeds `runId` + `firstKeptEntryId` so a retried compaction at
 * the same cut is idempotent (matches the `session_entries` marker PK, which is
 * also keyed on `firstKeptEntryId`). `conversationId` uses the same
 * `${slug||tediId}:${sessionKey}` shape as every other isolate ledger emitter.
 * Best-effort throughout: the cut itself never throws into a turn, and the
 * event emission is wrapped so a ledger hiccup never undoes a successful cut.
 *
 * Returns the {@link CompactionResult} (or null) so the FORCE route can echo it
 * back to the operator as proof.
 */
export async function summarizeAdmittedCompaction(
	this: RuntimeMemoryHost,
	entries: Parameters<typeof summarizeContextEntries>[1],
	previousSummary: string | undefined,
	sessionKey: string,
	options: { modelRef: string | null; deployment: string | null },
) {
	return summarizeContextEntries(
		this.env,
		entries,
		previousSummary,
		this.tediAigMetadata("observer:session-compaction", { sessionKey }),
		{
			modelRef: options.modelRef ?? undefined,
			deployment: options.deployment ?? undefined,
		},
	);
}

export async function runCompaction(
	this: RuntimeMemoryHost,
	sessionKey: string,
	opts?: { keepRecentTokens?: number },
	acceptedOperationId?: string,
): Promise<CompactionResult | null> {
	const operationId =
		acceptedOperationId ?? (await this.prepareCompaction(sessionKey, opts));
	const key = `runtime-compaction:${operationId}`;
	type Journal = {
		input: {
			kind: string;
			sessionKey: string;
			options: {
				keepRecentTokens: number;
				modelRef: string | null;
				deployment: string | null;
			};
			source: ReturnType<TediSessionRepo["getBranch"]>;
		};
		stage: "accepted" | "running" | "completed";
		result?: CompactionResult | null;
		modelReceipt?: unknown;
	};
	const original = this.ctx.storage.kv.get<Journal>(key);
	if (
		!original ||
		original.input.sessionKey !== sessionKey ||
		original.input.kind !== "session-compaction"
	)
		throw new Error("Missing original compaction operation");
	const admission = this.runtimeAdmission();
	await admission?.assertOriginalClaim({
		runId: operationId,
		sessionKey,
		input: original.input,
	});
	const finish = async (result: CompactionResult | null) => {
		const receipt = this.ctx.storage.kv.get<Journal>(key);
		if (
			!receipt ||
			receipt.stage !== "completed" ||
			JSON.stringify(receipt.input) !== JSON.stringify(original.input)
		)
			throw new Error("Compaction terminal receipt missing");
		await this.completeRuntimeTurn(operationId, operationId, {
			inputHash: await this.runtimeReceiptHash(original.input),
			result,
			modelReceipt: receipt.modelReceipt ?? null,
		});
		return result;
	};
	if (original.stage === "completed") return finish(original.result ?? null);
	await admission?.assertAcceptedTurn({
		runId: operationId,
		sessionKey,
		input: original.input,
	});
	this.ctx.storage.transactionSync(() => {
		const current = this.ctx.storage.kv.get<Journal>(key);
		if (
			!current ||
			current.stage !== "accepted" ||
			JSON.stringify(current.input) !== JSON.stringify(original.input)
		)
			throw new Error("Compaction already dispatched; reconciliation required");
		if (
			JSON.stringify(this.sessionRepo.getBranch(sessionKey)) !==
			JSON.stringify(original.input.source)
		)
			throw new Error("Compaction source branch changed");
		this.ctx.storage.kv.put(key, { ...current, stage: "running" });
	});
	let modelCalled = false;
	const result = await this.sessionRepo.compactSession(
		sessionKey,
		async (entries, previousSummary) => {
			await admission?.assertAcceptedTurn({
				runId: operationId,
				sessionKey,
				input: original.input,
			});
			if (
				JSON.stringify(this.sessionRepo.getBranch(sessionKey)) !==
				JSON.stringify(original.input.source)
			)
				throw new Error("Compaction source branch changed before model");
			modelCalled = true;
			const summary = await this.summarizeAdmittedCompaction(
				entries,
				previousSummary,
				sessionKey,
				original.input.options,
			);
			if (!summary?.trim())
				throw new Error(
					"Compaction model result unknown; reconciliation required",
				);
			const current = this.ctx.storage.kv.get<Journal>(key);
			if (
				!current ||
				current.stage !== "running" ||
				JSON.stringify(current.input) !== JSON.stringify(original.input)
			)
				throw new Error("Compaction dispatched journal changed");
			this.ctx.storage.kv.put(key, {
				...current,
				modelReceipt: {
					summaryHash: await this.runtimeReceiptHash(summary),
					entriesHash: await this.runtimeReceiptHash({
						entries,
						previousSummary: previousSummary ?? null,
					}),
				},
			});
			await admission?.assertAcceptedTurn({
				runId: operationId,
				sessionKey,
				input: original.input,
			});
			if (
				JSON.stringify(this.sessionRepo.getBranch(sessionKey)) !==
				JSON.stringify(original.input.source)
			)
				throw new Error("Compaction source branch changed before commit");
			return summary;
		},
		{ keepRecentTokens: original.input.options.keepRecentTokens },
	);
	if (modelCalled && !result?.compacted)
		throw new Error(
			"Compaction dispatched without verified commit; reconciliation required",
		);
	const settle = async () => {
		const current = this.ctx.storage.kv.get<Journal>(key);
		if (
			!current ||
			current.stage !== "running" ||
			JSON.stringify(current.input) !== JSON.stringify(original.input)
		)
			throw new Error("Compaction dispatched journal changed");
		this.ctx.storage.kv.put(key, { ...current, stage: "completed", result });
		return finish(result);
	};
	if (!result?.compacted) return settle();

	// Observability: emit ONE canonical ledger event for the real cut.
	try {
		await this.ensureIdentity();
		const { tediId, slug } = this.state;
		if (!tediId) throw new Error("Compaction owner missing");
		const platform = await this.getPlatformClient();
		if (!platform) throw new Error("Compaction ledger port missing");
		const conversationId = buildTediConversationId({
			tediRef: slug || tediId,
			sessionKey,
		});
		// Compaction is a SESSION event, not a turn, so it gets its own
		// deterministic non-turn id keyed on the compaction marker (always
		// present after a real cut — `if (!result?.compacted) return` above
		// guarantees it). Deliberately NOT a `{surface}` runId, so it never
		// collides with turn runIds or their `{runId}:{seq}` event ids.
		const runId = `${tediId}:compaction:${sanitizeTurnKey(String(result.markerTs))}`;
		const payload = buildCompactionLedgerPayload(sessionKey, result);
		await admission?.assertAcceptedTurn({
			runId: operationId,
			sessionKey,
			input: original.input,
		});
		await platform.recordRuntimeEvent({
			id: `${runId}:compaction:${payload.firstKeptEntryId}`,
			tediId,
			kind: "context.compacted",
			conversationId,
			runId,
			sequence: 0,
			payload,
			runtime: { backend: "cloudflare-agents" },
			createdAt: new Date().toISOString(),
		});
	} catch (err) {
		// Ledger emission is best-effort — the cut already succeeded.
		logTediRuntimeFailure("tedi.runtime.compaction_ledger_emit_failed", err);
		throw err;
	}
	return settle();
}

/**
 * Enqueue a best-effort per-session compaction pass through the durable queue.
 * Called from every SUCCESS turn fan-out (right after the daily-log enqueue).
 * `compactSession` no-ops cheaply when under budget, so this is safe per turn.
 */
export async function enqueueCompaction(
	this: RuntimeMemoryHost,
	sessionKey: string,
): Promise<void> {
	const operationId = await this.prepareCompaction(sessionKey);
	await this.queue(
		"onCompactSession",
		{ sessionKey, operationId },
		{ retry: { maxAttempts: 2 } },
	);
}
