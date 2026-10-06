import { describe, expect, it } from "vite-plus/test";
import {
	createOsClientErrorIngest,
	LOG_WINDOW_MS,
	MAX_CLIENT_ERROR_BODY_BYTES,
	MAX_LOGGED_REPORTS_PER_WINDOW,
	type OsClientErrorEventV1,
} from "./ingest";
import { OS_CLIENT_ERROR_PATH } from "./report";

const context = { tenant: "acme", deployedSha: "abc123" };

function harness() {
	const logged: OsClientErrorEventV1[] = [];
	let clock = 1_000;
	const ingest = createOsClientErrorIngest({
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
	return new Request(`https://acme.os.tedix.dev${OS_CLIENT_ERROR_PATH}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body,
	});
}

const validReport = {
	schemaVersion: 1,
	failureSite: "browser.window-error",
	severity: "error",
	handled: false,
	captureMechanism: "window.error",
	pageLocation: "https://acme.os.tedix.dev/outputs/9#share=cap_live_abc123",
	exception: { type: "TypeError", message: "x is not a function" },
};

describe("createOsClientErrorIngest", () => {
	it("accepts a valid report and logs a stamped event", async () => {
		const { ingest, logged } = harness();

		const response = await ingest.handle(post(JSON.stringify(validReport)), {
			...context,
			reportedUserId: "U2abc",
		});

		expect(response.status).toBe(204);
		expect(logged).toHaveLength(1);
		expect(logged[0]).toMatchObject({
			event: "os.client-error",
			tenant: "acme",
			deployedSha: "abc123",
			reportedUserId: "U2abc",
		});
		// The trust boundary strips the capability fragment even though the
		// producer already did: the endpoint carries no credential, so any client
		// can claim any string.
		expect(logged[0]?.report.pageLocation).toBe(
			"https://acme.os.tedix.dev/outputs/9",
		);
	});

	it("refuses a non-POST method", async () => {
		const { ingest, logged } = harness();

		const response = await ingest.handle(
			new Request(`https://acme.os.tedix.dev${OS_CLIENT_ERROR_PATH}`),
			context,
		);

		expect(response.status).toBe(405);
		expect(logged).toHaveLength(0);
	});

	it("refuses a non-JSON content type", async () => {
		const { ingest, logged } = harness();

		const response = await ingest.handle(
			post(JSON.stringify(validReport), { "Content-Type": "text/plain" }),
			context,
		);

		expect(response.status).toBe(415);
		expect(logged).toHaveLength(0);
	});

	it("refuses an oversized declared body before buffering it", async () => {
		const { ingest, logged } = harness();
		// `Request` recomputes Content-Length from the body it was given, so the
		// declared-length branch is only reachable through a request whose header
		// is set independently. Reading the body fails the test outright, which is
		// the property that matters: an oversized upload is never buffered.
		const declaresOversized = {
			method: "POST",
			headers: new Headers({
				"Content-Type": "application/json",
				"Content-Length": String(MAX_CLIENT_ERROR_BODY_BYTES + 1),
			}),
			text: () => Promise.reject(new Error("body must not be buffered")),
		} as unknown as Request;

		const response = await ingest.handle(declaresOversized, context);

		expect(response.status).toBe(413);
		expect(logged).toHaveLength(0);
	});

	it("refuses an oversized body that declared no length", async () => {
		const { ingest, logged } = harness();
		const oversized = JSON.stringify({
			...validReport,
			exception: {
				type: "Error",
				stack: "s".repeat(MAX_CLIENT_ERROR_BODY_BYTES),
			},
		});

		const response = await ingest.handle(post(oversized), context);

		expect(response.status).toBe(413);
		expect(logged).toHaveLength(0);
	});

	it("refuses malformed JSON and an unsupported shape", async () => {
		const { ingest, logged } = harness();

		expect((await ingest.handle(post("{not json"), context)).status).toBe(400);
		expect(
			(await ingest.handle(post(JSON.stringify({ hi: 1 })), context)).status,
		).toBe(400);
		expect(logged).toHaveLength(0);
	});

	it("sheds logging above the per-isolate rate without refusing the caller", async () => {
		const { ingest, logged, advance } = harness();
		const total = MAX_LOGGED_REPORTS_PER_WINDOW + 25;

		for (let index = 0; index < total; index += 1) {
			const response = await ingest.handle(
				post(JSON.stringify({ ...validReport, failureSite: `site-${index}` })),
				context,
			);
			expect(response.status).toBe(204);
		}
		expect(logged).toHaveLength(MAX_LOGGED_REPORTS_PER_WINDOW);

		advance(LOG_WINDOW_MS);
		await ingest.handle(post(JSON.stringify(validReport)), context);
		expect(logged).toHaveLength(MAX_LOGGED_REPORTS_PER_WINDOW + 1);
	});
});
