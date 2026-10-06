import { describe, expect, it } from "vite-plus/test";
import {
	MAX_TELEMETRY_BATCH_EVENTS,
	MAX_TELEMETRY_BODY_BYTES,
	WEBMCP_TELEMETRY_PATH,
} from "./telemetry";
import {
	createWebMcpTelemetryIngest,
	MAX_LOGGED_TELEMETRY_BATCHES_PER_WINDOW,
	TELEMETRY_LOG_WINDOW_MS,
	type WebMcpTelemetryLogEventV1,
} from "./telemetry-ingest";

const context = { tenant: "acme", deployedSha: "abc123" };

function harness() {
	const logged: WebMcpTelemetryLogEventV1[] = [];
	let clock = 1_000;
	const ingest = createWebMcpTelemetryIngest({
		now: () => clock,
		sink: (event) => {
			logged.push(event);
		},
	});
	return {
		logged,
		ingest,
		advance(ms: number) {
			clock += ms;
		},
	};
}

function post(body: string, headers: Record<string, string> = {}): Request {
	return new Request(`https://acme.os.tedix.dev${WEBMCP_TELEMETRY_PATH}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body,
	});
}

const validEvent = {
	tool: "list_work_items",
	scope: "work",
	outcome: "ok",
	durationMs: 41.7,
};

const validBatch = { schemaVersion: 1, events: [validEvent] };

describe("createWebMcpTelemetryIngest", () => {
	it("accepts a valid batch and logs one stamped line", async () => {
		const { ingest, logged } = harness();
		const response = await ingest.handle(
			post(JSON.stringify(validBatch)),
			context,
		);
		expect(response.status).toBe(204);
		expect(logged).toHaveLength(1);
		expect(logged[0]).toEqual({
			event: "webmcp.client",
			receivedAt: new Date(1_000).toISOString(),
			tenant: "acme",
			deployedSha: "abc123",
			events: [
				{
					tool: "list_work_items",
					scope: "work",
					outcome: "ok",
					durationMs: 42,
				},
			],
		});
	});

	it("refuses non-POST, non-JSON, and oversized bodies", async () => {
		const { ingest, logged } = harness();
		const get = new Request("https://acme.os.tedix.dev/webmcp/telemetry");
		expect((await ingest.handle(get, context)).status).toBe(405);
		expect(
			(
				await ingest.handle(
					post(JSON.stringify(validBatch), { "Content-Type": "text/plain" }),
					context,
				)
			).status,
		).toBe(415);
		const oversized = JSON.stringify({
			schemaVersion: 1,
			events: [{ ...validEvent, tool: "x".repeat(MAX_TELEMETRY_BODY_BYTES) }],
		});
		expect((await ingest.handle(post(oversized), context)).status).toBe(413);
		expect((await ingest.handle(post("not json"), context)).status).toBe(400);
		expect(logged).toHaveLength(0);
	});

	it("refuses a batch envelope over the event cap or off-schema", async () => {
		const { ingest, logged } = harness();
		const tooMany = {
			schemaVersion: 1,
			events: Array.from(
				{ length: MAX_TELEMETRY_BATCH_EVENTS + 1 },
				() => validEvent,
			),
		};
		expect(
			(await ingest.handle(post(JSON.stringify(tooMany)), context)).status,
		).toBe(400);
		expect(
			(
				await ingest.handle(
					post(JSON.stringify({ schemaVersion: 2, events: [] })),
					context,
				)
			).status,
		).toBe(400);
		expect(logged).toHaveLength(0);
	});

	it("drops malformed events, rebuilds survivors, and bounds every field", async () => {
		const { ingest, logged } = harness();
		const batch = {
			schemaVersion: 1,
			events: [
				{ ...validEvent, tool: "t".repeat(4_000), durationMs: 10_000_000 },
				{ tool: "no_outcome", scope: "work", durationMs: 1 },
				{ ...validEvent, outcome: "not_an_outcome" },
				{ ...validEvent, durationMs: Number.NaN },
				"not an object",
				{ ...validEvent, extra: "field is dropped" },
			],
		};
		const response = await ingest.handle(post(JSON.stringify(batch)), context);
		expect(response.status).toBe(204);
		expect(logged).toHaveLength(1);
		expect(logged[0]?.events).toEqual([
			{
				tool: "t".repeat(128),
				scope: "work",
				outcome: "ok",
				durationMs: 600_000,
			},
			{ tool: "list_work_items", scope: "work", outcome: "ok", durationMs: 42 },
		]);
	});

	it("accepts an all-dropped batch without spending a log line", async () => {
		const { ingest, logged } = harness();
		const response = await ingest.handle(
			post(JSON.stringify({ schemaVersion: 1, events: [{ nope: true }] })),
			context,
		);
		expect(response.status).toBe(204);
		expect(logged).toHaveLength(0);
	});

	it("sheds logging above the per-window cap, then recovers next window", async () => {
		const { ingest, logged, advance } = harness();
		const body = JSON.stringify(validBatch);
		for (let i = 0; i < MAX_LOGGED_TELEMETRY_BATCHES_PER_WINDOW + 5; i += 1) {
			expect((await ingest.handle(post(body), context)).status).toBe(204);
		}
		expect(logged).toHaveLength(MAX_LOGGED_TELEMETRY_BATCHES_PER_WINDOW);

		advance(TELEMETRY_LOG_WINDOW_MS);
		expect((await ingest.handle(post(body), context)).status).toBe(204);
		expect(logged).toHaveLength(MAX_LOGGED_TELEMETRY_BATCHES_PER_WINDOW + 1);
	});

	it("normalizes invocationId: exact UUID lowercased, anything else dropped", async () => {
		const { ingest, logged } = harness();
		const batch = {
			schemaVersion: 1,
			events: [
				{
					...validEvent,
					invocationId: "5B2F0F9C-7F68-4A3A-9A58-0B6A9A1C2D3E",
				},
				{ ...validEvent, invocationId: "not-a-uuid" },
				{ ...validEvent, invocationId: 42 },
			],
		};
		const response = await ingest.handle(post(JSON.stringify(batch)), context);
		expect(response.status).toBe(204);
		expect(logged[0]?.events).toEqual([
			{
				tool: "list_work_items",
				scope: "work",
				outcome: "ok",
				durationMs: 42,
				invocationId: "5b2f0f9c-7f68-4a3a-9a58-0b6a9a1c2d3e",
			},
			// A malformed id costs the FIELD, never the event.
			{ tool: "list_work_items", scope: "work", outcome: "ok", durationMs: 42 },
			{ tool: "list_work_items", scope: "work", outcome: "ok", durationMs: 42 },
		]);
	});

	it("sheds log lines above the per-isolate window rate", async () => {
		const { ingest, logged, advance } = harness();
		const body = JSON.stringify(validBatch);
		for (let i = 0; i < MAX_LOGGED_TELEMETRY_BATCHES_PER_WINDOW + 5; i += 1) {
			expect((await ingest.handle(post(body), context)).status).toBe(204);
		}
		expect(logged).toHaveLength(MAX_LOGGED_TELEMETRY_BATCHES_PER_WINDOW);

		advance(TELEMETRY_LOG_WINDOW_MS);
		expect((await ingest.handle(post(body), context)).status).toBe(204);
		expect(logged).toHaveLength(MAX_LOGGED_TELEMETRY_BATCHES_PER_WINDOW + 1);
	});
});
