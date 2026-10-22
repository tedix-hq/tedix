import { isLeanContextSession } from "@tedix/api-contract/utils/runtime-identity";
import {
	type AdaptiveLearningMode,
	adaptiveLearningModeForTurn,
} from "./adaptive-learning";
import type { ArtifactsPushReceipt } from "./artifacts-git";
import { type BrainDigest, compileBrainDigest } from "./brain/brain-digest";
import { auditRationaleCorpus } from "./brain/corpus-audit";
import type { BridgeTurnInput, RecentTurn } from "./bridge-turn-input";
import { logTediSourceFailure } from "./context-failure-log";
import { createTurnLearningTelemetry } from "./learning-telemetry";
import { isEphemeralSession } from "./ledger-mirror";
import { type ObserverToolExecutionEvidence } from "./observer-execution-evidence";
import {
	commitDailyLogEntries,
	type DailyLogBatch,
	type DailyLogEntry,
	utcDateSlug,
} from "./workspace";
import type { RuntimeMemoryHost } from "./runtime-memory";

/**
 * Corpus-audit alarm. Computes rationale-corpus health telemetry
 * (`auditRationaleCorpus` from `brain/corpus-audit.ts` — the
 * single source shared with the context bridge) over the
 * tedi's completed rationale chain and logs the result as telemetry.
 *
 * Pure read: only `platform.getRationaleChain`. The container plugin persists
 * the result to `memory/corpus-audit.json`; the isolate has no workspace dir,
 * so it logs the stats (matching tedix-context's own console output). The
 * platform call is timeout-guarded (20s) so a hung upstream cannot wedge the
 * DO alarm. Fail-soft: errors never break chat; the next alarm retries.
 */
export async function onAuditCorpus(
	this: RuntimeMemoryHost,
	admittedRunId?: string,
): Promise<void> {
	try {
		await this.ensureIdentity();
		const nativePlatform = await this.getPlatformClient();
		const platform =
			nativePlatform &&
			(admittedRunId
				? this.admittedEffectPort(nativePlatform, admittedRunId)
				: nativePlatform);
		if (!platform) throw new Error("Maintenance platform is unavailable");
		const result = await Promise.race([
			auditRationaleCorpus(platform, 100),
			new Promise<never>((_, reject) =>
				setTimeout(
					() => reject(new Error("auditRationaleCorpus timed out")),
					20_000,
				),
			),
		]);
		console.log(
			`[isolate.corpus-audit] records=${result.totalRecords} ` +
				`complete=${Math.round(result.completionRate * 100)}% ` +
				`avgConfidence=${result.avgConfidence} ` +
				`categories=${result.uniqueCategories.length} ` +
				`contrastive=${result.contrastiveViability} lora=${result.loraViability} ` +
				`tedi=${this.state.slug}`,
		);
	} catch (err) {
		if (admittedRunId) throw err;
		logTediSourceFailure("corpus_audit", "audit", err, "error");
		// Fail-soft — never break chat; the next alarm retries.
	}
}

/**
 * Brain-digest alarm. Distills the tedi's top-K brain facts into a stable
 * knowledge summary (`compileBrainDigest` from `brain/brain-digest.ts`
 * — the single source shared with the context bridge),
 * persists it to DO SQLite, and refreshes the in-memory cache that
 * {@link brainDigestAddendum} injects into the system prompt every turn
 * ("stable retrieval mode").
 *
 * Makes a platform read (`getDomains` + per-domain `memorySearch`) plus one
 * LLM distill call via {@link getObserverLlmClient}. Both the platform reads
 * and the LLM call are timeout-guarded (25s ceiling — slightly above the
 * directive/corpus 20s because the per-domain searches fan out) so a hung
 * upstream cannot wedge the DO alarm. Returns `null` until the corpus has 3+
 * facts, so young tedis simply get no digest (the addendum stays empty).
 * Failures propagate to the owning maintenance operation; the prior cached
 * digest stays active.
 */
export async function onCompileBrainDigest(
	this: RuntimeMemoryHost,
	admittedRunId: string,
): Promise<void> {
	if (typeof admittedRunId !== "string" || !admittedRunId.trim())
		throw new Error("Maintenance compilation requires its original run ID");
	await this.runtimeAdmission()?.assertAcceptedTurn({ runId: admittedRunId });
	await this.ensureIdentity();
	const nativePlatform = await this.getPlatformClient();
	const platform =
		nativePlatform && this.admittedEffectPort(nativePlatform, admittedRunId);
	if (!platform) throw new Error("Maintenance platform is unavailable");
	const llm = this.getObserverLlmClient(admittedRunId);
	const previousDigest =
		this.brainDigest ?? (await this.getBrainDigestStore().load());
	const digest = await Promise.race([
		compileBrainDigest(platform, {
			llm,
			model: this.env.AZURE_OBSERVER_DEPLOYMENT,
			previousDigest,
		}),
		new Promise<BrainDigest | null>((_, reject) =>
			setTimeout(
				() => reject(new Error("compileBrainDigest timed out")),
				25_000,
			),
		),
	]);
	if (!digest) return;
	await this.runtimeAdmission()?.assertAcceptedTurn({ runId: admittedRunId });
	await this.getBrainDigestStore().save(digest);
	this.brainDigest = digest;
	this.brainDigestLoaded = true;
	console.log(
		`[isolate.brain-digest] compiled facts=${digest.factCount} ` +
			`domains=${digest.domains.length} tedi=${this.state.slug}`,
	);
}

/**
 * Single post-turn MEMORY-effects dispatcher: the brain bridge (learning)
 * and the daily narrative log. Every turn surface (WS chat, MCP, voice,
 * workflow commit) routes through here so lean-context sessions —
 * blind verification (`evidence:judge:*`) and lean workflow synthesis
 * (`workflow:synth:*`) — are excluded from ALL memory surfaces by ONE
 * structural gate — a future memory surface added here inherits it instead
 * of needing its own vigilance-based check. The write-side gates inside
 * `enqueueDailyLogPair` / `onBridgeTurn` remain as defense-in-depth for
 * queue-replay entry points. Audit/ledger mirroring (`onLedgerMirror`) and
 * session compaction are deliberately NOT dispatched here: a blind judge
 * turn stays durable and audited — it only must not be learned from.
 */
export async function dispatchTurnMemoryEffects(
	this: RuntimeMemoryHost,
	input: {
		user: RecentTurn;
		assistant: RecentTurn;
		runId: string;
		sessionKey: string;
		origin: string;
		/** Home Work Item served by this delegated turn, when present. */
		workItemId?: string;
		learningMode?: AdaptiveLearningMode;
		traceId?: string;
		/**
		 * WS1: pre-captured tool-call refs for the run. The workflow-commit path
		 * passes these explicitly because the trace-bundle writer consumes the
		 * per-run step buffer before this dispatcher runs there; every other
		 * surface lets the dispatcher read the buffer directly.
		 */
		toolCallRefs?: string[];
		/** Canonical, content-free tool outcomes captured before trace consumption. */
		executionEvidence?: ObserverToolExecutionEvidence[];
		/** Await the bridge inline (workflow commit needs completion ordering). */
		awaitBridge?: boolean;
		/** Workflow commit logs only genuine inserts. */
		dailyLog?: boolean;
	},
): Promise<void> {
	if (
		isLeanContextSession(input.sessionKey) ||
		isEphemeralSession(input.sessionKey)
	) {
		createTurnLearningTelemetry(input).finish(
			"skipped",
			"lean_context_session",
		);
		return;
	}
	const toolCallRefs =
		input.toolCallRefs ?? this.toolCallRefsForRun(input.runId);
	const executionEvidence =
		input.executionEvidence ?? this.toolExecutionEvidenceForRun(input.runId);
	const payload = {
		user: input.user,
		assistant: input.assistant,
		runId: input.runId,
		origin: input.origin,
		sessionKey: input.sessionKey,
		...(input.workItemId ? { workItemId: input.workItemId } : {}),
		...(toolCallRefs.length > 0 ? { toolCallRefs } : {}),
		...(executionEvidence.length > 0 ? { executionEvidence } : {}),
		...(input.learningMode !== undefined
			? { learningMode: input.learningMode }
			: {}),
		...(input.traceId ? { traceId: input.traceId } : {}),
	};
	if (
		(input.learningMode ??
			adaptiveLearningModeForTurn({
				userText: input.user.content,
				assistantText: input.assistant.content,
			})) === "disabled"
	) {
		createTurnLearningTelemetry(input).finish("skipped", "learning_disabled");
		return;
	}
	const admission = this.runtimeAdmission();
	if (admission) {
		await this.acceptRuntimeTurn(`${input.runId}:memory`, input.sessionKey, {
			kind: "memory_effects",
			payload,
		});
		const memoryKey = `runtime-admission-memory:${input.runId}`;
		const prior = await this.ctx.storage.get<{
			stage: string;
			payload: BridgeTurnInput;
		}>(memoryKey);
		if (prior && JSON.stringify(prior.payload) !== JSON.stringify(payload))
			throw new Error("Original memory operation changed");
		if (!prior)
			await this.ctx.storage.put(memoryKey, { stage: "accepted", payload });
	}
	if (input.awaitBridge) {
		try {
			await this.onBridgeTurn(payload);
		} catch (e) {
			logTediSourceFailure("brain_bridge", "execute", e);
		}
	} else {
		void this.queue("onBridgeTurn", payload, {
			retry: { maxAttempts: 3 },
		}).catch((e) => logTediSourceFailure("brain_bridge", "queue", e));
	}
	if (input.dailyLog !== false) {
		this.enqueueDailyLogPair(input.user, input.assistant);
	}
}

/**
 * Enqueue a user+assistant pair into {@link State.pendingDailyEntries}
 * for the admitted periodic {@link onDailyLogFlush} owner.
 */
export function enqueueDailyLogPair(
	this: RuntimeMemoryHost,
	user: RecentTurn,
	assistant: RecentTurn,
): void {
	// A blind verification turn (`evidence:judge:*`) leaves no trace in the
	// tedi's own narrative memory: the daily log is compacted and read back as
	// context, so logging the judge prompt would reintroduce the claim text the
	// judge is supposed to evaluate independently. Same reasoning as the
	// `onBridgeTurn` gate. Lean workflow-synthesis turns (`workflow:synth:*`)
	// are excluded too: they are self-contained summarizations already
	// recorded in run rationales, so a narrative-memory trace would only
	// re-inject bulk workflow input into compacted context.
	if (isLeanContextSession(user.sessionKey)) return;
	const turnId = `${user.ts}-${assistant.ts}`;
	const entries: DailyLogEntry[] = [
		{ ts: user.ts, role: "user", content: user.content, turnId },
		{
			ts: assistant.ts,
			role: "assistant",
			content: assistant.content,
			turnId,
		},
	];
	const next = [...(this.state.pendingDailyEntries ?? []), ...entries];
	this.setState({ ...this.state, pendingDailyEntries: next });
}

/**
	 * Drain {@link State.pendingDailyEntries} into the per-tedi CF Artifacts
	 * repo, grouped by UTC date so a flush that straddles midnight still
	 * writes the right file per day. Serialized via {@link dailyLogWriteLock}
	 * so admitted writes cannot race a non-fast-forward push.
	 *
	 * Fail-soft: on commit/push error, leaves entries in the queue for the
	 * next tick. We snapshot before commit and remove just the drained ids
	 * after, so entries enqueued during the in-flight write are not dropped.
	 *
	 * Repo is provisioned lazily on first flush (see `artifacts-git.ts`).

	 */
export async function onDailyLogFlush(
	this: RuntimeMemoryHost,
	admittedRunId?: string,
): Promise<ArtifactsPushReceipt | null> {
	const run = async (): Promise<ArtifactsPushReceipt | null> => {
		if (!admittedRunId)
			throw new Error(
				"Daily logs require an original admitted maintenance operation",
			);
		await this.assertChatTurnActive(admittedRunId);
		if (this.ctx.storage.kv.get("runtime-admission-artifacts-pending"))
			throw new Error("Previous Artifacts push is unresolved");
		const pending = this.state.pendingDailyEntries ?? [];
		if (pending.length === 0) return null;
		await this.ensureIdentity();
		const { tediId, slug } = this.state;
		if (!tediId) {
			if (admittedRunId)
				throw new Error("Maintenance tedi identity is missing");
			console.warn("[isolate.daily-log] flush skipped: missing tediId");
			return null;
		}
		const nativeArtifacts = this.env.ARTIFACTS;
		const artifacts =
			nativeArtifacts &&
			(admittedRunId
				? this.admittedEffectPort(nativeArtifacts, admittedRunId)
				: nativeArtifacts);
		if (!artifacts) {
			if (admittedRunId)
				throw new Error("Maintenance Artifacts binding is unavailable");
			console.warn(
				"[isolate.daily-log] flush skipped: ARTIFACTS binding missing",
			);
			return null;
		}

		const snapshot = pending.slice();
		const byDate = new Map<string, DailyLogEntry[]>();
		for (const entry of snapshot) {
			const date = utcDateSlug(entry.ts);
			const list = byDate.get(date) ?? [];
			list.push(entry);
			byDate.set(date, list);
		}
		const batches: DailyLogBatch[] = [...byDate.entries()].map(
			([date, entries]) => ({ date, entries }),
		);

		await this.ctx.storage.put("runtime-admission-artifacts-pending", {
			runId: admittedRunId,
			snapshot,
			stage: "running",
		});
		let pushReceipt: ArtifactsPushReceipt | null;
		try {
			if (admittedRunId)
				await this.runtimeAdmission()?.assertAcceptedTurn({
					runId: admittedRunId,
				});
			pushReceipt = await commitDailyLogEntries(artifacts, {
				assertReady: () => this.assertChatTurnActive(admittedRunId),
				accountId: this.env.CF_ACCOUNT_ID,
				// Matches the `namespace` in apps/tedi-runtime/wrangler.jsonc
				// and apps/tedi/cloudflare.config.ts — same repo identity for both
				// runtimes.
				namespace: "tedix-prod",
				tediId,
				slug: slug || tediId,
				batches,
			});
		} catch (err) {
			if (admittedRunId) throw err;
			console.warn(
				"[isolate.daily-log] Artifacts commit failed; leaving queue for retry:",
				err,
			);
			return null;
		}

		if (!pushReceipt)
			throw new Error("Artifacts push acknowledgment is missing");
		await this.runtimeAdmission()?.assertOriginalClaim({
			runId: admittedRunId,
		});
		const drained = new Set(
			snapshot.map((e) => `${e.ts}|${e.role}|${e.turnId}`),
		);
		const remaining = (this.state.pendingDailyEntries ?? []).filter(
			(e) => !drained.has(`${e.ts}|${e.role}|${e.turnId}`),
		);
		this.ctx.storage.transactionSync(() => {
			this.ctx.storage.kv.put(`runtime-admission-artifacts:${admittedRunId}`, {
				pushReceipt,
				snapshot,
			});
			this.setState({ ...this.state, pendingDailyEntries: remaining });
			this.ctx.storage.kv.delete("runtime-admission-artifacts-pending");
		});
		return pushReceipt;
	};

	const next = this.dailyLogWriteLock.then(run, run);
	this.dailyLogWriteLock = next.then(
		() => undefined,
		() => undefined,
	);
	return await next;
}
