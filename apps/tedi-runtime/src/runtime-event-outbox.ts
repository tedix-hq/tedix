/**
 * Durable outbox for cognitive-runtime ledger events.
 *
 * Two lanes share one DO-storage queue and one redrive sweep:
 *
 * - **observational** (`publish`) — `step.completed`, `tool.started`,
 *   `tool.completed`, `tool.failed`. These used to be `await`ed straight
 *   through to `platform.recordRuntimeEvent(...)` on the model/tool hot path,
 *   where each write took about a second and several ran
 *   sequentially inside a single answer. They are now persisted locally first
 *   (a DO-storage put, sub-millisecond) and published to the API in the
 *   background, so the next model step or tool call starts immediately.
 * - **terminal** (`enqueueTerminal`) — `run.completed` / `run.failed` /
 *   `run.canceled`. Terminal publication persists first and waits for the run
 *   observations; legacy mirror fallback uses the same queue. Exhausted rows
 *   remain recoverable with a `ledger_terminal_exhausted` alert.
 *
 * Bare fire-and-forget was rejected: an evicted isolate would lose the
 * evidence. Persisting first means the redrive sweep recovers anything the
 * background publish did not finish.
 *
 * `flush(runId)` reports whether the visibility barrier drained. Kernel reads a child
 * run's `tool.completed` rows to reconstruct its answer
 * (`apps/api/src/rpc/routers/kernel/child-run-reads.ts`), so "run.completed is
 * visible" must still imply "this run's observational events are visible".
 * `onLedgerMirror` drains the run before writing the lifecycle chain.
 *
 * Every write is idempotent server-side — the API conflicts-do-nothing on
 * `runtimeEventId(tediId, runId, sequence)` — so a redrive after a partial
 * success is safe.
 */

import type { TediRuntimeEvent } from "@tedix/api-contract/schemas/cognitive-runtime";
import { exceptionTopology } from "./exception-topology";
import type { DerivedRuntimeEventSink } from "./k2-derived-events";

/** DO-storage prefix for ledger events awaiting durable publication. */
export const LEDGER_OUTBOX_PREFIX = "ledger-outbox:";
const BLOCKED_PREFIX = "ledger-delivery-blocked:";
/** Spacing between outbox redrive sweeps (seconds). */
export const LEDGER_OUTBOX_REDRIVE_SECONDS = 300;
/** Terminal attempts before an explicit exhausted alert; evidence stays queued. */
export const LEDGER_OUTBOX_MAX_REDRIVES = 24;
/**
 * Observational attempts before an explicit exhausted alert. Exhausted rows remain
 * recoverable, retried once per scheduled sweep; terminals remain fenced behind them.
 */
export const OBSERVATIONAL_MAX_REDRIVES = 6;
/**
 * Ceiling on observational rows this isolate will persist while the API is
 * unreachable. Past it, events are still attempted in the background but not
 * written to DO storage. A compact per-run unresolved-delivery count is persisted
 * before such sends. Unconfirmed sends block terminal publication even after eviction.
 * Those markers require evidence repair before removal; execution must not replay.
 */
export const OBSERVATIONAL_PENDING_CAP = 256;

export interface LedgerOutboxEntry {
	event: TediRuntimeEvent;
	redrives: number;
	firstDroppedAt: number;
	/**
	 * Absent means terminal — entries persisted before the observational lane
	 * existed carry no class and must keep the long terminal budget.
	 */
	class?: "terminal" | "observational";
}

export interface RuntimeEventSink {
	recordRuntimeEvent(event: TediRuntimeEvent): Promise<unknown>;
}

export interface RuntimeEventOutboxDeps {
	storage: DurableObjectStorage;
	/** Keeps a background publish alive past the call that started it. */
	waitUntil(promise: Promise<unknown>): void;
	/** Resolved lazily — a cold DO may not have a platform client yet. */
	platform(): Promise<RuntimeEventSink | null>;
	/**
	 * Optional derivative sink. It is invoked only after the canonical API/D1
	 * write succeeds and never participates in ledger delivery or settlement.
	 */
	derivedEvents?: DerivedRuntimeEventSink;
	/** Arms the DO's `redriveLedgerOutbox` scheduled sweep (idempotent). */
	scheduleRedrive(): Promise<void>;
}

/** Bounded, payload-free operator view of one exact run's delivery state. */
export interface RuntimeEventOutboxRunSnapshot {
	runId: string;
	observational: number;
	terminal: number;
	kinds: Record<string, number>;
	oldestPendingAgeMs: number | null;
	maxRedrives: number;
	blockedPending: number;
	blockedInMemory: boolean;
	inFlight: number;
	redriveActive: boolean;
}

/** Stable storage key; run filtering uses event.runId, never assumes an ID format. */
export function outboxKey(event: TediRuntimeEvent): string {
	return `${LEDGER_OUTBOX_PREFIX}${event.id ?? `${event.runId}:${event.sequence ?? 0}`}`;
}

function isTerminal(event: TediRuntimeEvent): boolean {
	return ["run.completed", "run.failed", "run.canceled"].includes(event.kind);
}

function budgetFor(entry: LedgerOutboxEntry): number {
	return entry.class === "observational"
		? OBSERVATIONAL_MAX_REDRIVES
		: LEDGER_OUTBOX_MAX_REDRIVES;
}

export class RuntimeEventOutbox {
	/** In-flight background publishes, keyed by storage key, for `flush`. */
	private readonly inflight = new Map<string, Promise<void>>();
	private readonly inflightRuns = new Map<string, string | undefined>();
	/** Keys this isolate persisted and has not yet confirmed published. */
	private readonly persisted = new Set<string>();
	/** One saturation line per episode — an outage would otherwise log per step. */
	private saturated = false;
	private hydrated: Promise<void> | undefined;
	private readonly blockedRuns = new Set<string>();
	private redriving: Promise<boolean> | undefined;
	private readonly runQueues = new Map<string, Promise<unknown>>();
	private publishDerivedAfterCanonical(event: TediRuntimeEvent): void {
		if (!this.deps.derivedEvents) return;
		const publish = Promise.resolve()
			.then(() => this.deps.derivedEvents?.publish(event))
			.catch((error) => {
				console.warn(
					JSON.stringify({
						_tr: "k2_derived_event_publish_failed",
						tediId: event.tediId,
						runId: event.runId,
						kind: event.kind,
						exception: exceptionTopology(error),
					}),
				);
			});
		try {
			this.deps.waitUntil(publish);
		} catch {
			// K2 is a derivative analytics lane. A host without waitUntil must not
			// turn it into a gate on the canonical D1 ledger.
		}
	}
	/** Read-only diagnostic; never redrives, publishes, or exposes event payloads. */
	async inspectRun(runId: string): Promise<RuntimeEventOutboxRunSnapshot> {
		const [entries, marker] = await Promise.all([
			this.deps.storage.list<LedgerOutboxEntry>({
				prefix: LEDGER_OUTBOX_PREFIX,
			}),
			this.deps.storage.get<{ pending: number }>(`${BLOCKED_PREFIX}${runId}`),
		]);
		let observational = 0;
		let terminal = 0;
		let oldestPendingAt: number | null = null;
		let maxRedrives = 0;
		const kinds: Record<string, number> = {};
		for (const entry of entries.values()) {
			if (entry.event.runId !== runId) continue;
			if (entry.class === "observational") observational++;
			else terminal++;
			kinds[entry.event.kind] = (kinds[entry.event.kind] ?? 0) + 1;
			if (Number.isFinite(entry.firstDroppedAt))
				oldestPendingAt =
					oldestPendingAt === null
						? entry.firstDroppedAt
						: Math.min(oldestPendingAt, entry.firstDroppedAt);
			maxRedrives = Math.max(maxRedrives, entry.redrives);
		}
		return {
			runId,
			observational,
			terminal,
			kinds,
			oldestPendingAgeMs:
				oldestPendingAt === null
					? null
					: Math.max(0, Date.now() - oldestPendingAt),
			maxRedrives,
			blockedPending: Math.max(0, marker?.pending ?? 0),
			blockedInMemory: this.blockedRuns.has(runId),
			inFlight: [...this.inflightRuns.values()].filter((id) => id === runId)
				.length,
			redriveActive: Boolean(this.redriving),
		};
	}
	private serialize<T>(runId: string, operation: () => Promise<T>): Promise<T> {
		const prior = this.runQueues.get(runId) ?? Promise.resolve();
		const next = prior.catch(() => {}).then(operation);
		this.runQueues.set(runId, next);
		void next
			.finally(() => {
				if (this.runQueues.get(runId) === next) this.runQueues.delete(runId);
			})
			.catch(() => {});
		return next;
	}

	private async hydrate(): Promise<void> {
		this.hydrated ??= this.deps.storage
			.list<LedgerOutboxEntry>({ prefix: LEDGER_OUTBOX_PREFIX })
			.then((rows) => {
				for (const key of rows.keys()) this.persisted.add(key);
			})
			.catch((error) => {
				this.hydrated = undefined;
				throw error;
			});
		await this.hydrated;
	}

	private readonly markerQueues = new Map<string, Promise<void>>();
	/** Reserve lost/unknown delivery before a non-durable send, including eviction. */
	private async updateBlocked(
		event: TediRuntimeEvent,
		delta: 1 | -1,
	): Promise<void> {
		const run = event.runId ?? "";
		const previous = this.markerQueues.get(run) ?? Promise.resolve();
		const update = previous
			.catch(() => {})
			.then(async () => {
				const key = `${BLOCKED_PREFIX}${run}`;
				try {
					const marker = await this.deps.storage.get<{ pending: number }>(key);
					const pending = Math.max(0, (marker?.pending ?? 0) + delta);
					if (pending > 0)
						await this.deps.storage.put(key, {
							pending,
							reason: "observational_delivery_unknown",
							at: Date.now(),
						});
					else await this.deps.storage.delete(key);
				} catch {
					// No durable proof can be manufactured during a storage failure.
					this.blockedRuns.add(run);
					console.error(
						JSON.stringify({
							_tr: "ledger_delivery_blocked",
							runId: run,
							tediId: event.tediId,
							reason: "marker_storage_unavailable",
						}),
					);
				}
			});
		this.markerQueues.set(run, update);
		await update;
		if (this.markerQueues.get(run) === update) this.markerQueues.delete(run);
	}

	/** Preserve the existing mirror client; only terminal publication crosses the barrier. */
	orderedSink<T extends RuntimeEventSink>(platform: T): T {
		return new Proxy(platform, {
			get: (target, property) => {
				if (property === "recordRuntimeEvent")
					return (event: TediRuntimeEvent) =>
						isTerminal(event)
							? this.publishTerminal(event)
							: target.recordRuntimeEvent(event);
				return Reflect.get(target, property, target);
			},
		});
	}

	/** Persist before attempting delivery; an unavailable observation never loses its terminal. */
	async publishTerminal(event: TediRuntimeEvent): Promise<void> {
		return this.serialize(event.runId ?? "", () => this.deliverTerminal(event));
	}

	private async deliverTerminal(event: TediRuntimeEvent): Promise<void> {
		await this.persistTerminal(event);
		// Try the immediate delivery before relying on the delayed scheduler. A
		// transient schedule failure must not strand a terminal whose API is up.
		// The mirror already made one full observational flush before seq 0; do
		// not repeat every failed API write after seq 2 while Home waits to settle.
		if (!(await this.flush(event.runId, false))) {
			await this.deps.scheduleRedrive();
			return;
		}
		const platform = await this.deps.platform();
		if (!platform) {
			await this.deps.scheduleRedrive();
			return;
		}
		try {
			await platform.recordRuntimeEvent(event);
			this.publishDerivedAfterCanonical(event);
			await this.deps.storage.delete(outboxKey(event));
			this.persisted.delete(outboxKey(event));
		} catch {
			// The event is durable; schedule its redrive only after the immediate
			// send failed. Never replay execution to repair an observation.
			await this.deps.scheduleRedrive();
		}
	}

	constructor(private readonly deps: RuntimeEventOutboxDeps) {}

	/**
	 * Observational lane. Returns as soon as the event is durable locally; the
	 * remote write runs in the background. Never throws into a turn.
	 */
	async publish(event: TediRuntimeEvent): Promise<void> {
		return this.serialize(event.runId ?? "", () =>
			this.publishObservation(event),
		);
	}

	private async publishObservation(event: TediRuntimeEvent): Promise<void> {
		const key = outboxKey(event);
		const hydrated = await this.hydrate().then(
			() => true,
			() => false,
		);
		let durable = false;
		if (
			hydrated &&
			(this.persisted.has(key) ||
				this.persisted.size < OBSERVATIONAL_PENDING_CAP)
		) {
			this.persisted.add(key); // Reserve before await, across concurrent runs.
			try {
				await this.deps.storage.put<LedgerOutboxEntry>(key, {
					event,
					redrives: 0,
					firstDroppedAt: Date.now(),
					class: "observational",
				});
				this.persisted.add(key);
				durable = true;
			} catch (err) {
				this.persisted.delete(key);
				// A failed local put must not break the turn either; fall through to
				// a background-only attempt.
				console.warn(
					JSON.stringify({
						_tr: "ledger_outbox_persist_failed",
						tediId: event.tediId,
						runId: event.runId,
						kind: event.kind,
						delivery: "background_without_durability",
						exception: exceptionTopology(err),
					}),
				);
			}
		} else if (hydrated && !this.saturated) {
			this.saturated = true;
			console.warn(
				JSON.stringify({
					_tr: "ledger_outbox_saturated",
					tediId: event.tediId,
					runId: event.runId,
					kind: event.kind,
					pending: this.persisted.size,
				}),
			);
		}
		if (durable) this.saturated = false;
		else await this.updateBlocked(event, 1);
		this.start(event, key, durable);
	}

	/**
	 * Terminal lane: persist and let the scheduled sweep carry it. No immediate
	 * background attempt — the caller already exhausted its in-process retries,
	 * so an instant retry would only repeat a fresh failure.
	 */
	async enqueueTerminal(event: TediRuntimeEvent): Promise<void> {
		return this.serialize(event.runId ?? "", async () => {
			await this.persistTerminal(event);
			await this.deps.scheduleRedrive();
		});
	}

	private async persistTerminal(event: TediRuntimeEvent): Promise<void> {
		const key = outboxKey(event);
		await this.deps.storage.put<LedgerOutboxEntry>(key, {
			event,
			redrives: 0,
			firstDroppedAt: Date.now(),
			class: "terminal",
		});
		this.persisted.add(key);
	}

	/**
	 * Visibility barrier. Awaits this isolate's in-flight publishes, then makes
	 * one immediate attempt at anything still persisted for the run. False means
	 * evidence remains unavailable: terminal callers must use publishTerminal.
	 */
	async flush(runId?: string, retry = true): Promise<boolean> {
		const waiting = [...this.inflight.entries()]
			.filter(([key]) => !runId || this.inflightRuns.get(key) === runId)
			.map(([, promise]) => promise);
		if (waiting.length > 0) await Promise.allSettled(waiting);

		const allEntries = await this.deps.storage.list<LedgerOutboxEntry>({
			prefix: LEDGER_OUTBOX_PREFIX,
		});
		const entries = new Map(
			[...allEntries].filter(
				([, entry]) => !runId || entry.event.runId === runId,
			),
		);
		const blocked =
			this.blockedRuns.has(runId ?? "") ||
			(runId
				? Boolean(await this.deps.storage.get(`${BLOCKED_PREFIX}${runId}`))
				: this.blockedRuns.size > 0 ||
					(await this.deps.storage.list({ prefix: BLOCKED_PREFIX })).size > 0);

		if (entries.size === 0) return !blocked;
		const platform = await this.deps.platform();
		if (!platform) {
			await this.deps.scheduleRedrive();
			return false;
		}
		let remaining = 0;
		for (const [key, entry] of entries) {
			// The terminal lane owns its own retry schedule; a flush must not burn
			// its budget or block a settle behind a degraded API.
			if (entry.class !== "observational") continue;
			if (!retry) {
				remaining++;
				continue;
			}
			try {
				await platform.recordRuntimeEvent(entry.event);
				this.publishDerivedAfterCanonical(entry.event);
				await this.deps.storage.delete(key);
				this.persisted.delete(key);
			} catch {
				remaining++;
			}
		}
		if (remaining > 0) await this.deps.scheduleRedrive();
		return remaining === 0 && !blocked;
	}

	/**
	 * Scheduled sweep over both lanes. Returns true when entries remain, so the
	 * caller re-arms the schedule.
	 */
	async redrive(): Promise<boolean> {
		this.redriving ??= this.redriveOnce().finally(() => {
			this.redriving = undefined;
		});
		return this.redriving;
	}

	private async redriveOnce(): Promise<boolean> {
		const entries = await this.deps.storage.list<LedgerOutboxEntry>({
			prefix: LEDGER_OUTBOX_PREFIX,
		});
		if (entries.size === 0) return false;
		const platform = await this.deps.platform();
		let remaining = 0;
		const ordered = [...entries].sort(
			(a, b) =>
				Number(a[1].class !== "observational") -
				Number(b[1].class !== "observational"),
		);
		for (const [key, entry] of ordered) {
			await this.serialize(entry.event.runId ?? "", async () => {
				if (!(await this.deps.storage.get(key))) return;
				if (
					entry.class !== "observational" &&
					!(await this.flush(entry.event.runId, false))
				) {
					remaining++;
					return;
				}
				if (!platform) {
					remaining++;
					return;
				}
				try {
					await platform.recordRuntimeEvent(entry.event);
					this.publishDerivedAfterCanonical(entry.event);
					await this.deps.storage.delete(key);
					this.persisted.delete(key);
					console.log(
						JSON.stringify({
							_tr: "ledger_outbox_redriven",
							kind: entry.event.kind,
							tediId: entry.event.tediId,
							runId: entry.event.runId,
							redrives: entry.redrives + 1,
						}),
					);
				} catch (err) {
					const redrives = entry.redrives + 1;
					if (redrives >= budgetFor(entry)) {
						if (entry.redrives < budgetFor(entry))
							console.error(
								JSON.stringify({
									_tr:
										entry.class === "observational"
											? "ledger_observational_exhausted"
											: "ledger_terminal_exhausted",
									kind: entry.event.kind,
									tediId: entry.event.tediId,
									runId: entry.event.runId,
									redrives,
									firstDroppedAt: entry.firstDroppedAt,
									exception: exceptionTopology(err),
								}),
							);
						await this.deps.storage.put(key, {
							...entry,
							redrives: budgetFor(entry),
						});
						remaining++;
						return;
					}

					await this.deps.storage.put<LedgerOutboxEntry>(key, {
						...entry,
						redrives,
					});
					remaining++;
				}
			});
		}
		return remaining > 0;
	}

	/** Fire the background publish and register it for `flush`. */
	private start(event: TediRuntimeEvent, key: string, durable: boolean): void {
		const promise = this.send(event, key, durable).finally(() => {
			this.inflight.delete(key);
			this.inflightRuns.delete(key);
		});
		this.inflight.set(key, promise);
		this.inflightRuns.set(key, event.runId);
		try {
			this.deps.waitUntil(promise);
		} catch {
			// A host without a usable waitUntil still gets the write: `flush` awaits
			// the same promise and the sweep covers whatever it did not finish.
		}
	}

	/**
	 * `durable` says whether this event has a storage row backing it. When it
	 * does, success deletes the row and failure leaves it for the sweep. When it
	 * does not (storage put failed, or the isolate is saturated), this attempt is
	 * the only one the event gets.
	 */
	private async send(
		event: TediRuntimeEvent,
		key: string,
		durable: boolean,
	): Promise<void> {
		try {
			const platform = await this.deps.platform();
			if (!platform) {
				if (durable) await this.deps.scheduleRedrive();
				else
					console.error(
						JSON.stringify({
							_tr: "ledger_delivery_blocked",
							runId: event.runId,
							tediId: event.tediId,
							reason: "observational_delivery_unconfirmed",
						}),
					);
				return;
			}
			await platform.recordRuntimeEvent(event);
			this.publishDerivedAfterCanonical(event);
			if (durable) {
				await this.deps.storage.delete(key);
				this.persisted.delete(key);
			} else await this.updateBlocked(event, -1);
		} catch (err) {
			console.warn(
				JSON.stringify({
					_tr: "ledger_outbox_background_publish_failed",
					kind: event.kind,
					tediId: event.tediId,
					runId: event.runId,
					durable,
					exception: exceptionTopology(err),
				}),
			);
			if (durable) await this.deps.scheduleRedrive().catch(() => {});
			else
				console.error(
					JSON.stringify({
						_tr: "ledger_delivery_blocked",
						runId: event.runId,
						tediId: event.tediId,
						reason: "observational_delivery_unconfirmed",
					}),
				);
		}
	}
}
