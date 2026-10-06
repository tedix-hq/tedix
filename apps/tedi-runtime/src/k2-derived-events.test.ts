import assert from "node:assert/strict";
import type { TediRuntimeEvent } from "@tedix/api-contract/schemas/cognitive-runtime";
import {
	DERIVED_EVENT_REPLAY_CONSUMERS,
	K2DerivedRuntimeEventPublisher,
	replayDerivedEventBatch,
	type K2ConsumedBatch,
	type K2ReplayClient,
} from "./k2-derived-events";

const runtimeEvent = {
	id: "run-1:tool.1.completed",
	tediId: "tedi-1",
	kind: "tool.completed",
	conversationId: "tedi-1:agent:main:main",
	runId: "run-1",
	sequence: 3,
	payload: { arguments: { token: "must-not-leak" }, result: "private" },
	runtime: { backend: "cloudflare-agents" },
	createdAt: "2026-10-01T12:00:00.000Z",
} as TediRuntimeEvent;

// The producer uses the current K2 Workers binding shape and emits no payload.
{
	const sent: Uint8Array[] = [];
	const publisher = new K2DerivedRuntimeEventPublisher({
		async send(records) {
			sent.push(...records.map((record) => record.content));
			return { success: true };
		},
	});
	await publisher.publish(runtimeEvent);
	assert.equal(sent.length, 1);
	const body = JSON.parse(new TextDecoder().decode(sent[0]));
	assert.equal(body.version, 1);
	assert.equal(body.eventId, runtimeEvent.id);
	assert.equal(body.kind, runtimeEvent.kind);
	assert.equal("payload" in body, false);
	assert.equal(JSON.stringify(body).includes("must-not-leak"), false);
}

// K2 reports rejected batches in the result object rather than throwing.
{
	const publisher = new K2DerivedRuntimeEventPublisher({
		async send() {
			return {
				success: false,
				error: { message: "capacity", retryable: true },
			};
		},
	});
	await assert.rejects(() => publisher.publish(runtimeEvent), /capacity/);
}

class ReplayClient implements K2ReplayClient {
	readonly acks: string[] = [];
	readonly nacks: string[] = [];
	constructor(private readonly batch: K2ConsumedBatch) {}
	async consume(): Promise<K2ConsumedBatch> {
		return this.batch;
	}
	async ack(input: { batchId: string }): Promise<void> {
		this.acks.push(input.batchId);
	}
	async nack(input: { batchId: string }): Promise<void> {
		this.nacks.push(input.batchId);
	}
}

const encoded = new TextEncoder().encode(
	JSON.stringify({
		version: 1,
		type: "tedix.runtime-event.derived",
		eventId: runtimeEvent.id,
		tediId: runtimeEvent.tediId,
		runId: runtimeEvent.runId,
		kind: runtimeEvent.kind,
		sequence: runtimeEvent.sequence,
		occurredAt: runtimeEvent.createdAt,
		runtimeBackend: runtimeEvent.runtime?.backend,
	}),
);

// Independent subscriptions each receive and ack the same record. Their own
// idempotency ledgers make replay safe without coupling consumer positions.
{
	assert.notEqual(
		DERIVED_EVENT_REPLAY_CONSUMERS.analytics.subscriptionName,
		DERIVED_EVENT_REPLAY_CONSUMERS.assurance.subscriptionName,
	);
	for (const [index, subscription] of Object.values(
		DERIVED_EVENT_REPLAY_CONSUMERS,
	).entries()) {
		const client = new ReplayClient({
			batchId: `batch-${index}`,
			records: [{ content: encoded }],
		});
		const seen = new Set<string>();
		const handled: string[] = [];
		const first = await replayDerivedEventBatch({
			client,
			subscriptionId: subscription.subscriptionName,
			workerId: `worker-${index}`,
			idempotency: {
				has: async (key) => seen.has(key),
				mark: async (key) => void seen.add(key),
			},
			handle: async (_event, key) => void handled.push(key),
		});
		assert.deepEqual(first, { received: 1, processed: 1, duplicate: 0 });
		assert.equal(client.acks.length, 1);

		const replay = await replayDerivedEventBatch({
			client,
			subscriptionId: subscription.subscriptionName,
			workerId: `worker-${index}`,
			idempotency: {
				has: async (key) => seen.has(key),
				mark: async (key) => void seen.add(key),
			},
			handle: async (_event, key) => void handled.push(key),
		});
		assert.deepEqual(replay, { received: 1, processed: 0, duplicate: 1 });
		assert.equal(handled.length, 1);
	}
}

// A malformed record nacks the entire lease; K2 has no per-message retry.
{
	const client = new ReplayClient({
		batchId: "bad-batch",
		records: [{ content: new TextEncoder().encode("{}") }],
	});
	await assert.rejects(() =>
		replayDerivedEventBatch({
			client,
			subscriptionId: "analytics",
			workerId: "worker-1",
			idempotency: { has: async () => false, mark: async () => {} },
			handle: async () => {},
		}),
	);
	assert.deepEqual(client.acks, []);
	assert.deepEqual(client.nacks, ["bad-batch"]);
}

console.log("k2-derived-events tests passed");
