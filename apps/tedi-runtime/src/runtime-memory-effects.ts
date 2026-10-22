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
 * and the LLM call have a 20s overall ceiling and a 10s inference deadline so a hung
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
	const controller = new AbortController();
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const digest = await Promise.race([
		compileBrainDigest(platform, {
			llm,
			model: this.env.AZURE_OBSERVER_DEPLOYMENT,
			previousDigest,
			signal: controller.signal,
		}),
		new Promise<BrainDigest | null>((_, reject) => {
			timeout = setTimeout(() => {
				controller.abort();
				reject(new Error("compileBrainDigest timed out"));
			}, 20_000);
		}),
	]).finally(() => {
		if (timeout) clearTimeout(timeout);
	});
	if (!digest) {
		this.ctx.storage.kv.put(`memory:maintenance:result:${admittedRunId}`, {
			task: "isolate-brain-digest",
			empty: true,
		});
		return;
	}
	await this.runtimeAdmission()?.assertAcceptedTurn({ runId: admittedRunId });
	await this.getBrainDigestStore().save(digest);
	this.ctx.storage.kv.put(`memory:maintenance:result:${admittedRunId}`, {
		task: "isolate-brain-digest",
		compiledAt: digest.compiledAt,
	});
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

export const DAILY_LOG_QUEUE_CAP = 500;
export const DAILY_LOG_FLUSH_BATCH = 50;
const DAILY_QUEUE_PREFIX = "memory:daily:entry:";
const PENDING_PUSH = "runtime-admission-artifacts-pending";
const MAX_ENTRY_CHARS = 4000;
type DailyQueueHost = Pick<RuntimeMemoryHost, "ctx" | "state" | "setState">;
export interface DailyQueueRow {
	key: string;
	entry: DailyLogEntry;
}
interface PendingDailyPush {
	runId: string;
	snapshot: DailyLogEntry[];
	keys?: string[];
	stage: string;
}
function boundedEntry(entry: DailyLogEntry): DailyLogEntry {
	return {
		...entry,
		content:
			entry.content.length <= MAX_ENTRY_CHARS
				? entry.content
				: entry.content.slice(0, MAX_ENTRY_CHARS) +
					"\n[entry excerpt; remaining text retained in the conversation ledger]",
	};
}
function queueRows(host: DailyQueueHost): DailyQueueRow[] {
	return [
		...host.ctx.storage.kv.list<DailyLogEntry>({ prefix: DAILY_QUEUE_PREFIX }),
	]
		.map(([key, entry]) => ({ key, entry }))
		.sort((a, b) => a.entry.ts - b.entry.ts || a.key.localeCompare(b.key));
}
function appendQueue(host: DailyQueueHost, entries: DailyLogEntry[]): void {
	const kv = host.ctx.storage.kv;
	let sequence = kv.get<number>("memory:daily:sequence") ?? 0;
	for (const entry of entries)
		kv.put(
			`${DAILY_QUEUE_PREFIX}${String(++sequence).padStart(16, "0")}`,
			boundedEntry(entry),
		);
	kv.put("memory:daily:sequence", sequence);
	const rows = queueRows(host);
	if (rows.length <= DAILY_LOG_QUEUE_CAP) return;
	if (!kv.get("memory:daily:cap-warning")) {
		console.warn({
			event: "tedi.memory.daily_queue_capped",
			pending: rows.length,
			cap: DAILY_LOG_QUEUE_CAP,
		});
		kv.put("memory:daily:cap-warning", true);
	}
	// A push snapshot is immutable until its remote result has been reconciled.
	const pending = kv.get<PendingDailyPush>(PENDING_PUSH);
	const protectedKeys = new Set(pending?.keys ?? []);
	const folded = rows
		.filter((row) => !protectedKeys.has(row.key))
		.slice(0, rows.length - DAILY_LOG_QUEUE_CAP + 1);
	if (folded.length < 2) return;
	const count = (kv.get<number>("memory:daily:folded") ?? 0) + folded.length;
	const excerpts = folded
		.map((r) => `${r.entry.role}: ${r.entry.content.slice(0, 120)}`)
		.join("\n")
		.slice(-3000);
	for (const row of folded) kv.delete(row.key);
	kv.put(folded[0]!.key, {
		ts: folded[0]!.entry.ts,
		role: "assistant",
		turnId: `folded-${sequence}`,
		content: `[Daily log summary: ${count} queue rows folded; excerpts only. Full turns remain in the conversation ledger.]\n${excerpts}`,
	} satisfies DailyLogEntry);
	kv.put("memory:daily:folded", count);
}
/** Atomically migrate legacy Agent state; every subsequent enqueue touches only DO KV. */
export function readDailyLogQueue(host: DailyQueueHost): DailyQueueRow[] {
	if (host.state.pendingDailyEntries?.length)
		host.ctx.storage.transactionSync(() => {
			appendQueue(host, host.state.pendingDailyEntries);
			host.setState({ ...host.state, pendingDailyEntries: [] });
		});
	return queueRows(host);
}
export function enqueueDailyLogPair(
	this: RuntimeMemoryHost,
	user: RecentTurn,
	assistant: RecentTurn,
): void {
	if (isLeanContextSession(user.sessionKey)) return;
	readDailyLogQueue(this);
	const turnId = `${user.ts}-${assistant.ts}`;
	this.ctx.storage.transactionSync(() =>
		appendQueue(this, [
			{ ts: user.ts, role: "user", content: user.content, turnId },
			{
				ts: assistant.ts,
				role: "assistant",
				content: assistant.content,
				turnId,
			},
		]),
	);
}
function dailyBatches(entries: DailyLogEntry[]): DailyLogBatch[] {
	const byDate = new Map<string, DailyLogEntry[]>();
	for (const entry of entries) {
		const date = utcDateSlug(entry.ts);
		const batch = byDate.get(date) ?? [];
		batch.push(entry);
		byDate.set(date, batch);
	}
	return [...byDate].map(([date, entries]) => ({ date, entries }));
}
function acknowledgeDailyPush(
	host: RuntimeMemoryHost,
	pending: PendingDailyPush,
	receipt: unknown,
	remaining?: PendingDailyPush,
): void {
	host.ctx.storage.transactionSync(() => {
		const kv = host.ctx.storage.kv;
		kv.put(`runtime-admission-artifacts:${pending.runId}`, {
			pushReceipt: receipt,
			snapshot: pending.snapshot,
			complete: !remaining,
		});
		const ids = new Set(
			pending.snapshot.map((e) => `${e.ts}|${e.role}|${e.turnId}`),
		);
		for (const row of queueRows(host))
			if (
				pending.keys
					? pending.keys.includes(row.key)
					: ids.has(`${row.entry.ts}|${row.entry.role}|${row.entry.turnId}`)
			)
				kv.delete(row.key);
		const recent = kv.get<DailyLogEntry[]>("memory:daily:recent") ?? [];
		kv.put(
			"memory:daily:recent",
			[...recent, ...pending.snapshot.map(boundedEntry)].slice(-100),
		);
		kv.put("memory:daily:lastFlushAt", new Date().toISOString());
		kv.delete("memory:daily:lastFlushError");
		if (remaining) kv.put(PENDING_PUSH, remaining);
		else {
			kv.delete(PENDING_PUSH);
			kv.put(`memory:maintenance:result:${pending.runId}`, {
				task: "isolate-daily-log-flush",
				receipt,
			});
		}
	});
}
/** One bounded batch per admitted alarm. Remote reads recover lost push acknowledgments. */
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
		readDailyLogQueue(this);
		if (this.ctx.storage.kv.get(`memory:maintenance:result:${admittedRunId}`))
			return null;
		await this.ensureIdentity();
		const { tediId, slug } = this.state;
		if (!tediId) throw new Error("Maintenance tedi identity is missing");
		if (!this.env.ARTIFACTS)
			throw new Error("Maintenance Artifacts binding is unavailable");
		const prior = this.ctx.storage.kv.get<PendingDailyPush>(PENDING_PUSH);
		if (prior) {
			await this.runtimeAdmission()?.assertOriginalClaim({
				runId: prior.runId,
			});
			const journal = this.ctx.storage.kv.get<{
				pushReceipt: ArtifactsPushReceipt;
				complete?: boolean;
			}>(`runtime-admission-artifacts:${prior.runId}`);
			if (journal?.pushReceipt && journal.complete !== false)
				acknowledgeDailyPush(this, prior, journal.pushReceipt);
			else {
				const { readFileFromRepo } = await import("./artifacts-git");
				const { formatDailyLogEntry } = await import("./artifacts-contract");
				const artifacts = this.admittedEffectPort(
					this.env.ARTIFACTS,
					prior.runId,
				);
				// Read the exact remote blocks before releasing the fence. If only some
				// dates landed, retain only the missing entries and retry their original run.
				const firstDate = utcDateSlug(prior.snapshot[0]!.ts);
				const chunk = prior.snapshot
					.slice(0, DAILY_LOG_FLUSH_BATCH)
					.filter((e) => utcDateSlug(e.ts) === firstDate);
				const processed = new Set(chunk);
				const rest = prior.snapshot.filter((e) => !processed.has(e));
				const chunkKeys = prior.keys?.filter((_, i) =>
					processed.has(prior.snapshot[i]!),
				);
				const restKeys = prior.keys?.filter(
					(_, i) => !processed.has(prior.snapshot[i]!),
				);
				const confirmed = {
					...prior,
					snapshot: chunk,
					...(chunkKeys ? { keys: chunkKeys } : {}),
				};
				const remaining = rest.length
					? {
							...prior,
							snapshot: rest,
							...(restKeys ? { keys: restKeys } : {}),
						}
					: undefined;
				const missing: DailyLogEntry[] = [];
				for (const batch of dailyBatches(chunk)) {
					const remote = await readFileFromRepo(
						artifacts,
						this.env.CF_ACCOUNT_ID,
						"tedix-prod",
						tediId,
						slug || tediId,
						`workspace/daily/${batch.date}.md`,
						() => this.assertChatTurnActive(prior.runId),
					);
					for (const entry of batch.entries)
						if (!remote?.includes(formatDailyLogEntry(entry)))
							missing.push(entry);
				}
				if (missing.length) {
					await this.assertChatTurnActive(prior.runId);
					const receipt = await commitDailyLogEntries(artifacts, {
						assertReady: () => this.assertChatTurnActive(prior.runId),
						accountId: this.env.CF_ACCOUNT_ID,
						namespace: "tedix-prod",
						tediId,
						slug: slug || tediId,
						batches: dailyBatches(missing),
					});
					if (!receipt)
						throw new Error("Artifacts push acknowledgment is missing");
					acknowledgeDailyPush(this, confirmed, receipt, remaining);
				} else
					acknowledgeDailyPush(
						this,
						confirmed,
						{ reconciled: true, source: "remote-daily-log-blocks" },
						remaining,
					);
				if (remaining)
					throw new Error("Daily log push reconciliation remains pending");
			}
		}
		const rows = readDailyLogQueue(this).slice(0, DAILY_LOG_FLUSH_BATCH);
		if (!rows.length) return null;
		// Limit each alarm to one date (one remote file read plus one push).
		const date = utcDateSlug(rows[0]!.entry.ts);
		const batch = rows.filter((r) => utcDateSlug(r.entry.ts) === date);
		const pending: PendingDailyPush = {
			runId: admittedRunId,
			snapshot: batch.map((r) => r.entry),
			keys: batch.map((r) => r.key),
			stage: "running",
		};
		await this.ctx.storage.put(PENDING_PUSH, pending);
		const artifacts = this.admittedEffectPort(
			this.env.ARTIFACTS,
			admittedRunId,
		);
		const receipt = await commitDailyLogEntries(artifacts, {
			assertReady: () => this.assertChatTurnActive(admittedRunId),
			accountId: this.env.CF_ACCOUNT_ID,
			namespace: "tedix-prod",
			tediId,
			slug: slug || tediId,
			batches: dailyBatches(pending.snapshot),
		});
		if (!receipt) throw new Error("Artifacts push acknowledgment is missing");
		await this.runtimeAdmission()?.assertOriginalClaim({
			runId: admittedRunId,
		});
		acknowledgeDailyPush(this, pending, receipt);
		return receipt;
	};
	const next = this.dailyLogWriteLock.then(run, run).catch((error) => {
		this.ctx.storage.kv.put(
			"memory:daily:lastFlushError",
			error instanceof Error ? error.message : String(error),
		);
		throw error;
	});
	this.dailyLogWriteLock = next.then(
		() => undefined,
		() => undefined,
	);
	return next;
}
