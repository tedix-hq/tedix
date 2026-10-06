import { describe, expect, test } from "bun:test";
import { StatusSpinner } from "./activity";
import { streamHomeRunEvents } from "./events";
import type {
	McpClientLike,
	HomeRunEventsPage,
	ReadHomeRunEventsInput,
} from "./home-client";
import { TedixHomeClient } from "./home-client";
import { parseOptions } from "./options";
import { waitForSettlement } from "./turn";

const terminal = {
	events: [],
	nextOffset: "0",
	status: "completed",
	upToDate: true,
};
const task = (status = "completed", statusMessage?: string) => ({
	taskId: "run-progress",
	status,
	statusMessage,
	createdAt: "2026-09-10T00:00:00Z",
	lastUpdatedAt: "2026-09-10T00:00:00Z",
	ttlMs: null,
});
function spinner(quiet = false) {
	const writes: string[] = [];
	return {
		writes,
		value: new StatusSpinner({
			animate: false,
			quiet,
			stream: {
				write: (text: string) => {
					writes.push(text);
					return true;
				},
			} as NodeJS.WriteStream,
		}),
	};
}
/** A live spinner (TTY lane) whose writes are captured, with a fixed width. */
function liveSpinner() {
	const writes: string[] = [];
	return {
		writes,
		value: new StatusSpinner({
			animate: true,
			quiet: false,
			now: () => 0,
			stream: {
				columns: 200,
				write: (text: string) => {
					writes.push(text);
					return true;
				},
			} as NodeJS.WriteStream,
		}),
	};
}
function answerDelta(sequence: number, content: string) {
	return {
		offset: String(sequence),
		kind: "message.delta",
		sequence,
		payload: { role: "assistant", channel: "home", content },
	};
}
function options() {
	return { ...parseOptions([]).options, pollIntervalMs: 1, pollTimeoutMs: 500 };
}
const initial = {
	homeRunId: "run-progress",
	status: "running",
	assistantText: "",
	progressLabel: "Reading workspace",
	targetTediLabel: "CTO",
	childRunId: "child",
	delegatedTediId: "tedi",
};

describe("ask progress and completion", () => {
	test("completion aborts an outstanding event request instead of waiting for long polling", async () => {
		let aborted = 0;
		const client = {
			getTask: async () => task(),
			readHomeRun: async () => ({
				run: { id: initial.homeRunId, status: "completed" },
				assistantMessage: { content: "OK" },
			}),
			readHomeRunEvents: (
				_input: ReadHomeRunEventsInput,
				signal?: AbortSignal,
			) =>
				new Promise<HomeRunEventsPage>((_resolve, reject) => {
					signal?.addEventListener(
						"abort",
						() => {
							aborted++;
							reject(new DOMException("Aborted", "AbortError"));
						},
						{ once: true },
					);
				}),
		} as unknown as TedixHomeClient;
		const output = spinner();
		const result = await waitForSettlement(
			client,
			initial.homeRunId,
			initial,
			options(),
			{ enabled: false },
			output.value,
		);
		expect(result.assistantText).toBe("OK");
		expect(aborted).toBe(1);
		expect(output.writes.join("")).not.toContain("unavailable");
	}, 1000);
	test("working Task preserves Home progress and delegation then uses an explicit status message", async () => {
		let calls = 0;
		const output = spinner();
		const childReads: string[] = [];
		const client = {
			getTask: async () =>
				++calls === 1
					? task("working", "Running")
					: calls === 2
						? task("working", "Searching records")
						: task(),
			readHomeRun: async () => ({
				run: { id: initial.homeRunId, status: "completed" },
			}),
			readHomeRunEvents: async (input: ReadHomeRunEventsInput) => {
				if (input.childRunId) childReads.push(input.childRunId);
				return terminal;
			},
		} as unknown as TedixHomeClient;
		await waitForSettlement(
			client,
			initial.homeRunId,
			initial,
			options(),
			{ enabled: false },
			output.value,
		);
		expect(output.writes.join("")).toContain("Reading workspace");
		expect(output.writes.join("")).toContain("Searching records");
		expect(output.writes.join("")).toContain("CTO");
		expect(childReads).toEqual(["child"]);
	});
	test("an event failure is visible without failing the answer; JSON stays quiet", async () => {
		for (const quiet of [false, true]) {
			const output = spinner(quiet);
			const client = {
				getTask: async () => task(),
				readHomeRun: async () => ({
					run: { id: initial.homeRunId, status: "completed" },
				}),
				readHomeRunEvents: async () => {
					throw new Error("Unsupported capability");
				},
			} as unknown as TedixHomeClient;
			const result = await waitForSettlement(
				client,
				initial.homeRunId,
				initial,
				options(),
				{ enabled: false },
				output.value,
			);
			expect(result.status).toBe("completed");
			if (quiet) expect(output.writes).toEqual([]);
			else
				expect(output.writes.join("")).toContain(
					"Activity updates unavailable",
				);
		}
	});
	test("a status connection failure is shown and recovery still completes", async () => {
		let calls = 0;
		const output = spinner();
		const client = {
			getTask: async () => {
				if (++calls === 1) throw new Error("ECONNRESET");
				return task();
			},
			readHomeRun: async () => ({
				run: { id: initial.homeRunId, status: "completed" },
			}),
			readHomeRunEvents: async () => terminal,
		} as unknown as TedixHomeClient;
		await waitForSettlement(
			client,
			initial.homeRunId,
			initial,
			options(),
			{ enabled: false },
			output.value,
		);
		expect(output.writes.join("")).toContain(
			"Run status connection interrupted",
		);
		expect(calls).toBe(2);
	});
	test("the poll budget aborts a stalled status request without marking the run failed", async () => {
		let aborted = false;
		const client = {
			getTask: (_id: string, signal?: AbortSignal) =>
				new Promise((_resolve, reject) =>
					signal?.addEventListener("abort", () => {
						aborted = true;
						reject(new DOMException("Aborted", "AbortError"));
					}),
				),
			readHomeRunEvents: async () => terminal,
		} as unknown as TedixHomeClient;
		const result = await waitForSettlement(
			client,
			initial.homeRunId,
			{ ...initial, childRunId: undefined, delegatedTediId: undefined },
			{ ...options(), pollTimeoutMs: 20 },
			{ enabled: false },
			spinner().value,
		);
		expect(aborted).toBe(true);
		expect(result.status).toBe("running");
	});
	test("already-aborted event streams perform no read", async () => {
		let reads = 0;
		const ac = new AbortController();
		ac.abort();
		const stream = streamHomeRunEvents(
			{
				readHomeRunEvents: async () => {
					reads++;
					return terminal;
				},
			},
			{ homeRunId: initial.homeRunId },
			{ live: true, signal: ac.signal },
		);
		for await (const _event of stream) throw new Error("unexpected event");
		expect(reads).toBe(0);
	});
});

describe("Home activity transport cancellation", () => {
	test("forwards cancellation to transport without reconnecting or retrying", async () => {
		let calls = 0;
		let received: AbortSignal | undefined;
		const ac = new AbortController();
		const connection: McpClientLike = {
			callTool: async (_params, options) => {
				calls++;
				received = options.signal;
				ac.abort();
				throw new DOMException("Aborted", "AbortError");
			},
			close: async () => {},
		};
		const client = new TedixHomeClient({
			connect: async () => connection,
			headers: {},
			url: "http://x",
		});
		await expect(
			client.readHomeRunEvents({ homeRunId: "run" }, ac.signal),
		).rejects.toThrow("Aborted");
		expect(received).toBe(ac.signal);
		expect(calls).toBe(1);
	});
	test("cancellation ends a server-supplied read cooldown without sending another request", async () => {
		let calls = 0;
		const client = new TedixHomeClient({
			connect: async () => ({
				callTool: async () => {
					calls++;
					throw new Error('{"error":"Rate limit exceeded","retryAfter":60}');
				},
				close: async () => {},
			}),
			headers: {},
			url: "http://x",
		});
		await expect(
			client.readHomeRunEvents({ homeRunId: "run" }),
		).rejects.toThrow("Rate limit");
		const ac = new AbortController();
		const pending = client.readHomeRunEvents({ homeRunId: "run" }, ac.signal);
		ac.abort();
		await expect(pending).rejects.toThrow();
		expect(calls).toBe(1);
	});
});

test("OAuth transport aborts an accepted request with no response message", async () => {
	const ac = new AbortController();
	let accepted = false;
	const client = new TedixHomeClient({
		headers: {},
		url: "https://example.com/mcp",
		oauthProvider: {
			tokens: () => ({ access_token: "fixture", token_type: "Bearer" }),
			clientInformation: () => ({ client_id: "fixture" }),
		} as NonNullable<
			ConstructorParameters<typeof TedixHomeClient>[0]["oauthProvider"]
		>,
		fetch: async (_url, init) => {
			const request = JSON.parse(String(init?.body));
			if (request.method === "server/discover")
				return Response.json({
					jsonrpc: "2.0",
					id: request.id,
					result: { supportedVersions: ["2026-07-28"] },
				});
			accepted = true;
			setTimeout(() => ac.abort(), 10);
			return new Response(null, { status: 202 });
		},
	});
	try {
		await expect(
			client.readHomeRunEvents({ homeRunId: "run" }, ac.signal),
		).rejects.toThrow("abort");
		expect(accepted).toBe(true);
	} finally {
		await client.close();
	}
}, 1000);

describe("streamed answer deltas", () => {
	const solo = {
		...initial,
		childRunId: undefined,
		delegatedTediId: undefined,
	};
	const client = (events: unknown[]) =>
		({
			getTask: async () => task(),
			readHomeRun: async () => ({
				run: { id: solo.homeRunId, status: "completed" },
				assistantMessage: { content: "the canonical answer" },
			}),
			readHomeRunEvents: async () => ({
				events,
				nextOffset: String(events.length),
				status: "completed",
				upToDate: true,
			}),
		}) as unknown as TedixHomeClient;

	test("batched deltas render on the live line during the turn", async () => {
		const output = liveSpinner();
		output.value.start("working");
		await waitForSettlement(
			client([answerDelta(1, "Checking the "), answerDelta(2, "ledger now")]),
			solo.homeRunId,
			solo,
			options(),
			{ enabled: false },
			output.value,
		);
		output.value.stop();
		const out = output.writes.join("");
		expect(out).toContain("Checking the ledger now");
		// Live line only — a streamed fragment is never committed to scrollback.
		expect(out).not.toContain("Checking the ledger now\n");
		// And the contentless "message delta" activity row is gone.
		expect(out).not.toContain("message delta");
	});

	test("a delta behind the canonical message never renders", async () => {
		const output = liveSpinner();
		output.value.start("working");
		await waitForSettlement(
			client([
				answerDelta(1, "partial text"),
				{
					offset: "2",
					kind: "message.completed",
					payload: { role: "assistant", content: "the canonical answer" },
				},
				answerDelta(3, "STRAGGLER"),
			]),
			solo.homeRunId,
			solo,
			options(),
			{ enabled: false },
			output.value,
		);
		const out = output.writes.join("");
		expect(out).not.toContain("STRAGGLER");
		// The settled frame drops the partial from the live line, so the canonical
		// answer printSummary commits is never shadowed by a stale fragment.
		// Asserted BEFORE stop(), whose trailing CLEAR_LINE would mask it.
		expect(out).toContain("partial text");
		expect(output.writes[output.writes.length - 1]).not.toContain(
			"partial text",
		);
		output.value.stop();
	});
});
