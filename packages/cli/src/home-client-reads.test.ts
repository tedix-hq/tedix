import { describe, expect, test } from "bun:test";
import { type McpClientLike, TedixHomeClient } from "./home-client";

// `tedix status` read a run set that the Code Mode gateway had replaced with a
// truncation preview (a page of real runs is several times the 6k-token
// budget) and a child tree still wrapped in the gateway envelope, so a
// delegated run in flight rendered as active=0 delegations=0. These reads now
// use server-side projections and return the unwrapped payload.

function harness(
	callImpl: (
		callIndex: number,
		params?: { name: string; arguments: Record<string, unknown> },
	) => Promise<unknown>,
): { client: TedixHomeClient; sources: string[] } {
	const sources: string[] = [];
	let calls = 0;
	const connect = async (): Promise<McpClientLike> => ({
		callTool: async (params) => {
			sources.push(String(params.arguments.code ?? ""));
			return callImpl(++calls, params);
		},
		close: async () => {},
	});
	const client = new TedixHomeClient({ connect, headers: {}, url: "http://x" });
	return { client, sources };
}

function gatewayResult(result: unknown) {
	return { structuredContent: { executionId: "exec-1", result } };
}

const truncated = (preview: string) => ({
	__tedix_truncated: true,
	preview,
	approxTokens: 27269,
	guidance: "Result truncated by the Code Mode gateway: ~27,269 tokens",
});

test("conversation title reads follow server cursors using one literal tool call per page", async () => {
	const { client, sources } = harness(async (index) =>
		gatewayResult(
			index === 1
				? { found: false, title: null, nextCursor: "page-two" }
				: { found: true, title: "Example title", nextCursor: null },
		),
	);
	expect(await client.readHomeConversationTitle("target-chat")).toBe(
		"Example title",
	);
	expect(sources).toEqual([
		'async () => await home.read_conversation_title({"limit":100,"includeArchived":true,"conversationId":"target-chat"})',
		'async () => await home.read_conversation_title({"limit":100,"includeArchived":true,"cursor":"page-two","conversationId":"target-chat"})',
	]);
});

test("message reads use a literal compact tool call and preserve page arguments", async () => {
	const page = {
		messages: [{ id: "m", role: "assistant", content: "answer" }],
		nextCursor: "next",
	};
	const { client, sources } = harness(async () => gatewayResult(page));
	expect(
		await client.readHomeMessages({
			conversationId: "chat",
			cursor: "previous",
			limit: 5,
		}),
	).toEqual(page);
	expect(sources).toEqual([
		'async () => await home.read_home_messages_compact({"conversationId":"chat","cursor":"previous","limit":5})',
	]);
});

const fullRun = {
	id: "54964dda-e749-43ba-ade9-a63547f26673",
	organizationId: "org-1",
	conversationId: "home:cli:-private-tmp",
	status: "running",
	delegatedTediId: "tedi-cto",
	childRunId: "tedi-cto:mcp:child-1",
	createdAt: "2026-10-08T20:44:03.907Z",
	progress: { current: 10, total: 100, label: "Delegated", detail: null },
	runtime: {
		backend: "custom",
		metadata: { executionRequirement: "x".repeat(5000) },
	},
	metadata: {
		kernelRoute: { routeKind: "delegate_tedi", targetTediLabel: "CTO" },
		childRunPreview: "Reviewing",
		redriveInput: { huge: "y".repeat(5000) },
		clientSubmissionId: "sub-1",
	},
};

describe("@tedix/cli readHomeRunSet", () => {
	test("reads compact rows in a single call and unwraps the run set", async () => {
		const { client, sources } = harness(async () =>
			gatewayResult({
				runSet: {
					conversationId: "home:cli:-private-tmp",
					activeRunIds: [fullRun.id],
					runs: [fullRun],
				},
			}),
		);
		const payload = await client.readHomeRunSet({
			conversationId: "home:cli:-private-tmp",
			limit: 20,
		});
		expect(sources).toHaveLength(1);
		expect(sources[0]).toBe(
			'async () => await home.read_home_run_set_compact({"conversationId":"home:cli:-private-tmp","limit":20})',
		);
		// The caller sees `{ runSet }`, not the `{ executionId, result }` envelope.
		expect(payload).toEqual({
			runSet: {
				conversationId: "home:cli:-private-tmp",
				activeRunIds: [fullRun.id],
				runs: [fullRun],
			},
		});
	});

	test("halves the page until the gateway stops truncating", async () => {
		const { client, sources } = harness(async (callIndex) =>
			gatewayResult(
				callIndex < 3
					? truncated('{"runSet":{"runs":[')
					: { runSet: { runs: [{ id: "r-1", status: "running" }] } },
			),
		);
		const payload = await client.readHomeRunSet({
			conversationId: "c",
			limit: 20,
		});
		expect(sources.map((source) => /"limit":(\d+)/.exec(source)?.[1])).toEqual([
			"20",
			"10",
			"5",
		]);
		expect(payload).toEqual({
			runSet: { runs: [{ id: "r-1", status: "running" }] },
		});
	});

	test("fails loudly when even one run cannot be returned", async () => {
		const { client } = harness(async () =>
			gatewayResult(truncated('{"runSet":{"runs":[')),
		);
		// Silence here is what made `tedix status` print "(none)" for a running
		// delegation: an unreturnable page must surface as an error.
		await expect(
			client.readHomeRunSet({ conversationId: "c", limit: 1 }),
		).rejects.toThrow(/Home run set is too large/);
	});
});

describe("@tedix/cli readChildRunTree", () => {
	test("reads compact nodes in a single call and unwraps the tree", async () => {
		const { client, sources } = harness(async () =>
			gatewayResult({
				tree: {
					conversationId: "c",
					nodes: [
						{
							id: "n-1",
							homeRunId: "r-1",
							delegatedTediId: "tedi-cto",
							childRunId: "tedi-cto:mcp:child-1",
							label: "CTO",
							status: "running",
							active: true,
							children: [],
							metadata: {
								preview: "Reviewing",
								progress: { label: "Working" },
							},
						},
					],
				},
			}),
		);
		const payload = await client.readChildRunTree({ conversationId: "c" });
		expect(sources[0]).toBe(
			'async () => await home.read_child_run_tree_compact({"conversationId":"c"})',
		);
		expect(payload).toMatchObject({
			tree: {
				conversationId: "c",
				nodes: [{ id: "n-1", childRunId: "tedi-cto:mcp:child-1" }],
			},
		});
	});

	test("pages down when the gateway truncates the tree", async () => {
		const { client, sources } = harness(async (callIndex) =>
			gatewayResult(
				callIndex < 2
					? truncated('{"tree":')
					: { tree: { conversationId: "c", nodes: [] } },
			),
		);
		const payload = await client.readChildRunTree({ conversationId: "c" });
		expect(
			sources.map((source) => /"limit":(\d+)/.exec(source)?.[1] ?? null),
		).toEqual([null, "10"]);
		expect(payload).toEqual({ tree: { conversationId: "c", nodes: [] } });
	});

	test("fails loudly when a single node cannot be returned", async () => {
		const { client } = harness(async () =>
			gatewayResult(truncated('{"tree":')),
		);
		await expect(
			client.readChildRunTree({ conversationId: "c", limit: 1 }),
		).rejects.toThrow(/Home child-run tree is too large/);
	});
});

describe("@tedix/cli Home event resume cursors", () => {
	for (const offset of [
		"3junk",
		"3.5",
		"invalid",
		"-1",
		"-0",
		"",
		" ",
		" 3",
		"3\n",
		"+3",
		"1e3",
		"0x10",
		"NaN",
		"Infinity",
		"9007199254740992",
		"9007199254740993",
	]) {
		test(`rejects ${JSON.stringify(offset)} before transport`, async () => {
			const { client, sources } = harness(async () =>
				gatewayResult({ events: [] }),
			);
			await expect(
				client.readHomeRunEvents({ homeRunId: "run-1", offset }),
			).rejects.toThrow(
				/Home event offset must be a non-negative safe integer in decimal digits/,
			);
			expect(sources).toEqual([]);
		});
	}

	for (const offset of [undefined, "0", "3", "0003", "9007199254740991"]) {
		test(`preserves valid cursor ${JSON.stringify(offset)}`, async () => {
			const start = Number(offset ?? "0");
			const { client, sources } = harness(async (_index, params) => {
				const source = String(params?.arguments.code);
				return gatewayResult(
					await new Function("home", `return (${source})()`)({
						read_home_run_events: async (args: { offset: number }) => {
							expect(args.offset).toBe(start);
							return {
								events: [],
								stream: { offset: start, nextOffset: start, closed: false },
							};
						},
					}),
				);
			});
			const page = await client.readHomeRunEvents({
				homeRunId: "run-1",
				offset,
			});
			expect(page.nextOffset).toBe(String(start));
			expect(sources).toHaveLength(1);
		});
	}
});
