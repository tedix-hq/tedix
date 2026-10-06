import type { TediRuntimeEvent } from "@tedix/api-contract/schemas/cognitive-runtime";
import {
	parseOwnedReadObservations,
	type OwnedReadObservation,
} from "@tedix/mcp-shared/read-observation-receipt";

const PREFIX = "artifact-contributions:";
const MAX_OBSERVATIONS = 100;

interface ContributionState {
	conversationId?: string;
	runId: string;
	observations: OwnedReadObservation[];
	unavailable?: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** Durable, per-run contribution evidence. It never infers reads from history. */
export class ArtifactContributionReceipts {
	private readonly queues = new Map<string, Promise<unknown>>();
	private readonly stickyUnavailable = new Set<string>();
	private readonly seenThisInstance = new Set<string>();
	constructor(private readonly storage: DurableObjectStorage) {}

	private key(runId: string): string {
		return `${PREFIX}${runId}`;
	}

	async decorate(event: TediRuntimeEvent): Promise<TediRuntimeEvent> {
		const runId = event.runId;
		if (!runId) return event;
		const prior = this.queues.get(runId) ?? Promise.resolve();
		const next = prior
			.catch(() => {})
			.then(() => this.decorateSerialized(event));
		this.queues.set(runId, next);
		try {
			return await next;
		} finally {
			if (this.queues.get(runId) === next) this.queues.delete(runId);
		}
	}

	private async decorateSerialized(
		event: TediRuntimeEvent,
	): Promise<TediRuntimeEvent> {
		const runId = event.runId!;
		const payload = record(event.payload) ?? {};
		const supplied = Object.hasOwn(payload, "readObservations")
			? parseOwnedReadObservations(payload.readObservations)
			: [];
		let state: ContributionState;
		try {
			const persistedState = await this.storage.get<ContributionState>(
				this.key(runId),
			);
			const firstSeenThisInstance = !this.seenThisInstance.has(runId);
			state = persistedState ?? {
				runId,
				conversationId: event.conversationId,
				observations: [],
			};
			// A fresh isolate cannot know whether a prior instance lost an observation
			// write before it restarted. Retain the durable prefix, but never promote
			// inherited state back to a clean observation claim.
			if (persistedState && !this.seenThisInstance.has(runId)) {
				state.unavailable = true;
			}
			if (
				!persistedState &&
				firstSeenThisInstance &&
				event.kind !== "tool.started"
			) {
				state.unavailable = true;
			}
			this.seenThisInstance.add(runId);
			const persisted = parseOwnedReadObservations(state.observations);
			if (
				state.runId !== runId ||
				state.conversationId !== event.conversationId ||
				persisted.length !== state.observations.length
			)
				state = {
					runId,
					conversationId: event.conversationId,
					observations: [],
					unavailable: true,
				};
			else state.observations = persisted;
			if (this.stickyUnavailable.has(runId)) state.unavailable = true;
			if (
				Object.hasOwn(payload, "readObservations") &&
				(!Array.isArray(payload.readObservations) ||
					supplied.length !== payload.readObservations.length)
			)
				state.unavailable = true;
			const byReceipt = new Map(
				state.observations.map((row) => [row.receipt.receiptId, row]),
			);
			for (const row of supplied) {
				const existing = byReceipt.get(row.receipt.receiptId);
				if (existing && JSON.stringify(existing) !== JSON.stringify(row))
					state.unavailable = true;
				else byReceipt.set(row.receipt.receiptId, structuredClone(row));
			}
			state.observations = [...byReceipt.values()].sort((a, b) =>
				a.receipt.receiptId < b.receipt.receiptId
					? -1
					: a.receipt.receiptId > b.receipt.receiptId
						? 1
						: 0,
			);
			if (state.observations.length > MAX_OBSERVATIONS) {
				state.observations = state.observations.slice(0, MAX_OBSERVATIONS);
				state.unavailable = true;
			}
			if (
				event.kind === "tool.started" ||
				supplied.length > 0 ||
				state.unavailable
			)
				await this.storage.put(this.key(runId), state);
			if (state.unavailable) this.stickyUnavailable.delete(runId);
		} catch {
			this.stickyUnavailable.add(runId);
			state = {
				runId,
				conversationId: event.conversationId,
				observations: [],
				unavailable: true,
			};
		}
		const rawProduced = payload.producedArtifactIds;
		const produced = Array.isArray(rawProduced)
			? rawProduced.filter(
					(value): value is string =>
						typeof value === "string" &&
						value.length > 0 &&
						value.length <= 500,
				)
			: [];
		if (
			Object.hasOwn(payload, "producedArtifactIds") &&
			(!Array.isArray(rawProduced) ||
				produced.length !== rawProduced.length ||
				produced.length > 20)
		) {
			state.unavailable = true;
			try {
				await this.storage.put(this.key(runId), state);
			} catch {
				this.stickyUnavailable.add(runId);
			}
		}
		if (produced.length === 0) return event;
		return {
			...event,
			payload: {
				...payload,
				artifactContributionReceipt: {
					version: 1,
					artifactIds: [...new Set(produced)].slice(0, 20),
					// These are durable observations from the executed prefix, not proof
					// that the run had no earlier/indirect reads or that provider ACLs
					// remain valid.
					completeness: state.unavailable ? "unavailable" : "observed_prefix",
					observations: structuredClone(state.observations),
				},
			},
		};
	}
}
