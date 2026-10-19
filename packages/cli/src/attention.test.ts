import { describe, expect, test } from "bun:test";
import { runAttentionCommand } from "./attention";
import type { NativeToolContext } from "./work";
function fixture(
	options: { endpoint?: string; organization?: string; decide?: boolean } = {},
) {
	const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
	const freshness = {
		source: "orpc",
		sourceRef: "attention/listDeckCards",
		sourceHash: "fixture-hash",
		syncedAt: "2026-10-19T12:00:00.000Z",
	};
	const descriptor = (name: string, endpoint: string) => ({
		name,
		endpoint,
		toolRowId: `row-${name}`,
		eligible: true,
		authorized: true,
		schemaFreshness: freshness,
	});
	const native = descriptor(
		"tedix__configured_deck_list",
		options.endpoint ??
			(options.decide ? "attention/decideDeckCard" : "attention/listDeckCards"),
	);
	const callable = options.decide
		? "attention.decide_deck_card"
		: "attention.list_deck_cards";
	const client = {
		getTimeoutMs: () => 10000,
		callToolWithDestructiveApproval: async () => {
			throw new Error("Unexpected approval");
		},
		callTool: async (name: string, input: Record<string, unknown>) => {
			calls.push({ name, input });
			if (name === "get_info")
				return {
					nativeContext: {
						version: 1,
						surface: "mcp-gateway",
						appId: "app",
						appSlug: "tedix",
						organizationId: options.organization ?? "fictional-orchard",
						actor: { authType: "apiKey" },
						nativeTransportAvailable: true,
					},
					nativeCatalog: {
						status: "usable",
						search: descriptor("configured_search", "catalog/search"),
						describe: descriptor("configured_describe", "catalog/describe"),
					},
				};
			if (name === "configured_search")
				return {
					results: [
						{
							callable,
							authorized: true,
							native,
							outputSchema: { type: "object" },
						},
					],
				};
			if (name === "configured_describe")
				return {
					callable,
					authorized: true,
					native,
					schemaFreshness: freshness,
					parameters: options.decide
						? {
								type: "object",
								required: ["decision"],
								properties: { decision: { type: "object" } },
								additionalProperties: false,
							}
						: { type: "object" },
				};
			if (name === native.name && options.decide)
				return { saved: true, cardId: "11111111-1111-4111-8111-111111111111" };
			if (name === native.name)
				return {
					cards: [],
					count: 0,
					complete: true,
					observedAt: "2026-10-19T12:00:00.000Z",
				};
			throw new Error(`Unexpected tool ${name}`);
		},
	} as NativeToolContext["client"];
	return {
		ctx: {
			client,
			json: true,
			positionals: ["list"],
			workspace: "fixture",
			mcpUrl: "https://mcp.tedix.test/mcp",
			organizationId: "fictional-orchard",
		},
		calls,
	};
}
describe("Deck CLI native transport", () => {
	test("calls the catalog wire name after exact endpoint resolution", async () => {
		const { ctx, calls } = fixture();
		expect(await runAttentionCommand("deck", ctx)).toBe(0);
		expect(calls.map((call) => call.name)).toEqual([
			"get_info",
			"configured_search",
			"configured_describe",
			"tedix__configured_deck_list",
		]);
		expect(calls[1]?.input.namespace).toBe("attention");
	});
	test("accepts an organization-scoped workspace key without treating it as an ID", async () => {
		const { ctx } = fixture();
		expect(
			await runAttentionCommand("deck", {
				...ctx,
				workspace: JSON.stringify(["connect", "orchard"]),
				organizationId: undefined,
			}),
		).toBe(0);
	});
	test("refuses a mismatched native endpoint without executing it", async () => {
		const { ctx, calls } = fixture({ endpoint: "workItems/create" });
		expect(await runAttentionCommand("deck", ctx)).toBe(2);
		expect(
			calls.some((call) => call.name === "tedix__configured_deck_list"),
		).toBe(false);
	});
	test("refuses a different organization before catalog lookup", async () => {
		const { ctx, calls } = fixture({ organization: "other-orchard" });
		expect(await runAttentionCommand("deck", ctx)).toBe(2);
		expect(calls.map((call) => call.name)).toEqual(["get_info"]);
	});
	test("does not mutate when the supplied card and payload IDs differ", async () => {
		const { ctx, calls } = fixture();
		ctx.positionals = [
			"decide",
			"wrong",
			JSON.stringify({
				kind: "interaction",
				decision: {
					requestId: "11111111-1111-4111-8111-111111111111",
					expectedRequestVersion: 3,
					responseKind: "answer",
					body: "Proceed",
					metadata: {},
				},
			}),
		];
		expect(await runAttentionCommand("deck", ctx)).toBe(2);
		expect(calls).toEqual([]);
	});
});

test("wraps domain JSON in the native object envelope without approval elicitation", async () => {
	const { ctx, calls } = fixture({ decide: true });
	const requestId = "11111111-1111-4111-8111-111111111111";
	const decision = {
		kind: "interaction",
		decision: {
			requestId,
			expectedRequestVersion: 3,
			responseKind: "answer",
			body: "Use the proposed topic",
			metadata: {},
		},
	};
	ctx.positionals = ["decide", requestId, JSON.stringify(decision)];
	expect(await runAttentionCommand("deck", ctx)).toBe(0);
	expect(calls.at(-1)?.input).toMatchObject({ decision });
	expect(Object.keys(calls.at(-1)!.input)).toEqual(["decision"]);
});
