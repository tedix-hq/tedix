import {
	DERIVED_RUNTIME_EVENT_VERSION,
	DerivedRuntimeEventEnvelopeSchema,
	derivedRuntimeEventKey,
	type DerivedRuntimeEventEnvelope,
} from "@tedix/api-contract/schemas/derived-events";
import type { TediRuntimeEvent } from "@tedix/api-contract/schemas/cognitive-runtime";

export interface K2Record {
	content: Uint8Array;
	headers?: Record<string, string>;
}

export interface K2SendResult {
	success: boolean;
	error?: { message: string; retryable: boolean };
}

/** Minimal current Cloudflare K2 Workers binding surface. */
export interface K2StreamBinding {
	send(records: K2Record[]): Promise<K2SendResult>;
}

export interface DerivedRuntimeEventSink {
	publish(event: TediRuntimeEvent): Promise<void>;
}

/** Selects structural fields only. `event.payload` is never read. */
export function deriveRuntimeEvent(
	event: TediRuntimeEvent,
): DerivedRuntimeEventEnvelope {
	return DerivedRuntimeEventEnvelopeSchema.parse({
		version: DERIVED_RUNTIME_EVENT_VERSION,
		type: "tedix.runtime-event.derived",
		eventId: event.id,
		tediId: event.tediId,
		runId: event.runId ?? null,
		kind: event.kind,
		sequence: event.sequence ?? null,
		occurredAt: event.createdAt,
		runtimeBackend: event.runtime?.backend ?? null,
	});
}

export class K2DerivedRuntimeEventPublisher implements DerivedRuntimeEventSink {
	private readonly encoder = new TextEncoder();

	constructor(private readonly stream: K2StreamBinding) {}

	async publish(event: TediRuntimeEvent): Promise<void> {
		const envelope = deriveRuntimeEvent(event);
		const result = await this.stream.send([
			{
				content: this.encoder.encode(JSON.stringify(envelope)),
				headers: {
					"content-type": "application/json",
					"event-type": envelope.type,
					"schema-version": String(envelope.version),
				},
			},
		]);
		if (!result.success) {
			const error = new Error(result.error?.message ?? "K2 produce failed");
			Object.assign(error, { retryable: result.error?.retryable ?? false });
			throw error;
		}
	}
}

export const DERIVED_EVENT_REPLAY_CONSUMERS = {
	analytics: { subscriptionName: "tedix_runtime_analytics" },
	assurance: { subscriptionName: "tedix_runtime_assurance" },
} as const;

export interface K2ConsumedRecord {
	content: Uint8Array;
	headers?: Record<string, string>;
}

export interface K2ConsumedBatch {
	batchId: string | null;
	records: K2ConsumedRecord[];
}

/** Pull-client seam matching K2's batch lease + explicit ack/nack contract. */
export interface K2ReplayClient {
	consume(input: {
		subscriptionId: string;
		workerId: string;
		maxRecords: number;
	}): Promise<K2ConsumedBatch>;
	ack(input: {
		subscriptionId: string;
		batchId: string;
		workerId: string;
	}): Promise<void>;
	nack(input: {
		subscriptionId: string;
		batchId: string;
		workerId: string;
	}): Promise<void>;
}

export interface DerivedEventIdempotencyStore {
	has(key: string): Promise<boolean>;
	mark(key: string): Promise<void>;
}

export interface ReplayDerivedEventBatchOptions {
	client: K2ReplayClient;
	subscriptionId: string;
	workerId: string;
	maxRecords?: number;
	idempotency: DerivedEventIdempotencyStore;
	handle(
		event: DerivedRuntimeEventEnvelope,
		idempotencyKey: string,
	): Promise<void>;
}

/**
 * Processes one leased K2 batch. A single failure nacks the whole batch;
 * already-marked records are skipped when K2 redelivers it.
 */
export async function replayDerivedEventBatch(
	options: ReplayDerivedEventBatchOptions,
): Promise<{ received: number; processed: number; duplicate: number }> {
	const batch = await options.client.consume({
		subscriptionId: options.subscriptionId,
		workerId: options.workerId,
		maxRecords: options.maxRecords ?? 100,
	});
	if (!batch.batchId) return { received: 0, processed: 0, duplicate: 0 };

	let processed = 0;
	let duplicate = 0;
	try {
		for (const record of batch.records) {
			const event = DerivedRuntimeEventEnvelopeSchema.parse(
				JSON.parse(new TextDecoder().decode(record.content)),
			);
			const key = derivedRuntimeEventKey(event);
			if (await options.idempotency.has(key)) {
				duplicate++;
				continue;
			}
			await options.handle(event, key);
			await options.idempotency.mark(key);
			processed++;
		}
		await options.client.ack({
			subscriptionId: options.subscriptionId,
			batchId: batch.batchId,
			workerId: options.workerId,
		});
		return { received: batch.records.length, processed, duplicate };
	} catch (error) {
		await options.client.nack({
			subscriptionId: options.subscriptionId,
			batchId: batch.batchId,
			workerId: options.workerId,
		});
		throw error;
	}
}
