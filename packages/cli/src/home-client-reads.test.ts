import { describe, expect, test } from "bun:test";
import {
	latestRunFromSet,
	type McpClientLike,
	summarizeHomePayload,
	TedixHomeClient,
} from "./home-client";

// `tedix status` read a run set that the Code Mode gateway had replaced with a
// truncation preview (a page of real runs is several times the 6k-token
// budget) and a child tree still wrapped in the gateway envelope, so a
// delegated run in flight rendered as active=0 delegations=0. These reads now
// project inside the gateway program and return the unwrapped payload.

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
	test("projects rows inside the gateway and returns the unwrapped run set", async () => {
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
		expect(sources[0]).toContain(
			'home.read_home_run_set({"conversationId":"home:cli:-private-tmp","limit":20})',
		);
		// The oversized fields never leave the gateway.
		expect(sources[0]).not.toContain("runtime");
		expect(sources[0]).not.toContain("redriveInput");
		// The caller sees `{ runSet }`, not the `{ executionId, result }` envelope.
		expect(payload).toEqual({
			runSet: {
				conversationId: "home:cli:-private-tmp",
				activeRunIds: [fullRun.id],
				runs: [fullRun],
			},
		});
	});

	test("the gateway projection keeps every field the CLI's summary reads", () => {
		// Apply the same key lists the gateway program uses to a raw row; the
		// summary and latest-run recovery must not change.
		const pick = (source: Record<string, unknown>, keys: string[]) =>
			Object.fromEntries(
				keys
					.filter((key) => source[key] !== undefined)
					.map((key) => [key, source[key]]),
			);
		const projected = {
			...pick(fullRun, [
				"id",
				"organizationId",
				"conversationId",
				"status",
				"delegatedTediId",
				"childRunId",
				"createdAt",
				"progress",
			]),
			metadata: {
				...pick(fullRun.metadata, ["clientSubmissionId"]),
				kernelRoute: fullRun.metadata.kernelRoute,
				childRunPreview: fullRun.metadata.childRunPreview,
			},
		};
		expect(summarizeHomePayload({ run: projected })).toEqual(
			summarizeHomePayload({ run: fullRun }),
		);
		expect(summarizeHomePayload({ run: projected })).toMatchObject({
			homeRunId: fullRun.id,
			status: "running",
			delegatedTediId: "tedi-cto",
			childRunId: "tedi-cto:mcp:child-1",
			targetTediLabel: "CTO",
			childRunPreview: "Reviewing",
		});
		expect(
			latestRunFromSet({ runSet: { runs: [projected] } }, "sub-1"),
		).toEqual({ homeRunId: fullRun.id, status: "running" });
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
	test("projects nodes inside the gateway and returns the unwrapped tree", async () => {
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
		expect(sources[0]).toContain(
			'home.read_child_run_tree({"conversationId":"c"})',
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
