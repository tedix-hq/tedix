/**
 * Warming the embedded tool schemas while the panel opens.
 *
 * A cold isolate paid 3.8-13.4s of `tedix_mcp_code` describe in front of the
 * first word of the first answer, measured from `tedi_runtime_events` on live
 * staging turns. It recurs after every deploy and every Durable Object
 * hibernation, so it lands on most FIRST questions — the ones a person judges
 * the product by. The panel authorizes several seconds before anything is
 * typed, so the warm spends that gap instead of the user's.
 *
 * Two properties carry the whole feature, and both are cheap to break by
 * editing one side of a pair:
 *
 *  1. The warm must produce the SAME cache key the turn will look up. The key
 *     is built from the conversation owner, the namespace prefix and the
 *     admitted callables, so the warm and the turn have to derive their tenant
 *     constraint from one place. They did not originally — `stream` built it
 *     inline — and a warm keyed differently is pure cost with no benefit.
 *  2. The warm must not become a turn. It starts no run, writes no message and
 *     carries no platform client, so it cannot land in the ledger.
 */

import assert from "node:assert/strict";
import { chatTurnProbe, tediDo } from "../test/tedi-do";
import { embedded, embeddedToken } from "../test/embedded-edge";
import {
	embeddedSchemaCacheKey,
	preparedTedixMcpAITools,
} from "./ai-sdk-adapter";

const bound = {
	hostTenantArgument: "company_id",
	hostTenantNamespace: "shop",
	embeddedAssistantCallables: [
		"shop.orders_list",
		"shop.orders_status_summary",
	],
	// Confirmed browser write actions: never part of the chat tool loop.
	portableWebMcpCallables: ["shop.update_order"],
};
const bodyOf = async (requests: Request[], path: string) => {
	const request = requests.find((item) => new URL(item.url).pathname === path);
	return request
		? ((await request.clone().json()) as Record<string, unknown>)
		: null;
};

// --- the warm and the turn derive ONE tenant constraint ----------------------
{
	const { adapter, forwarded } = await embedded();
	const session = await embeddedToken(bound);
	await adapter.authorize(session);
	await adapter.stream(session, {
		text: "hello",
		turnKey: "turn-1",
		signal: new AbortController().signal,
	} as never);
	await new Promise((resolve) => setTimeout(resolve, 0));
	const warm = await bodyOf(forwarded, "/__internal/chat/warm");
	const turn = await bodyOf(forwarded, "/__internal/chat/stream");
	const constraint = {
		tool_argument_constraints: { company_id: "367" },
		tool_namespace_prefix: "shop",
		tool_allowed_callables: bound.embeddedAssistantCallables,
	};
	assert.deepEqual(warm, { session_key: "embed:shop:1", ...constraint });
	for (const [key, value] of Object.entries(constraint))
		assert.deepEqual(turn?.[key], value, `the turn's ${key} matches the warm`);
	assert.doesNotMatch(
		JSON.stringify([warm, turn]),
		/update_order/,
		"confirmed browser write actions must not enter chat",
	);
}

// --- the warm never blocks or fails the connection ---------------------------
for (const warmResponse of [
	() => new Promise<Response>(() => {}),
	() => Promise.reject(new Error("DO unavailable")),
]) {
	const { adapter } = await embedded({}, (request) =>
		new URL(request.url).pathname === "/__internal/chat/warm"
			? warmResponse()
			: Response.json({ ok: true }),
	);
	const authority = await adapter.authorize(await embeddedToken(bound));
	assert.equal(authority.sessionKey, "embed:shop:1");
}

// --- only a tenant-bound session has schemas worth resolving ---
{
	const { adapter, forwarded } = await embedded();
	await adapter.authorize(await embeddedToken());
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(await bodyOf(forwarded, "/__internal/chat/warm"), null);
}

// --- the warm is not a turn, and the first turn reuses what it resolved ---
{
	const described: string[] = [];
	const constraint = {
		tool_argument_constraints: { company_id: "367" },
		tool_namespace_prefix: "acme_staging",
		tool_allowed_callables: [
			"acme_staging.orders_list",
			"acme_staging.orders_status_summary",
		],
	};
	const runtime = {
		bindTurn() {},
		clearTurn() {},
		getSystemInstructions: () => "MCP",
		async executeTool(name: string) {
			described.push(name);
			return constraint.tool_allowed_callables.map((callable) => ({
				callable,
				parameters: { type: "object", properties: {} },
			}));
		},
	};
	const sessionKey = "embed:acme:367:1743:warm-test";
	const probe = chatTurnProbe({
		mcpRuntime: runtime,
		platform: {
			setEpisodeTrace() {},
			async rankDiscovery() {
				return {};
			},
		},
		async facetTurn() {
			return { assistantText: "ok" };
		},
	});
	const warm = (body: unknown) =>
		probe.agent.onRequest(
			new Request("https://do.internal/__internal/chat/warm", {
				method: "POST",
				body: JSON.stringify(body),
			}),
		);

	// An unbound session is a no-op, not a describe.
	assert.equal((await warm({ session_key: sessionKey })).status, 204);
	assert.deepEqual(described, []);

	// A bound warm resolves schemas and writes nothing: no run, no message.
	assert.equal(
		(await warm({ session_key: sessionKey, ...constraint })).status,
		204,
	);
	const warmDescribes = described.length;
	assert.ok(warmDescribes > 0, "the warm resolves the tool schemas");
	assert.deepEqual(probe.appended, []);
	assert.deepEqual(probe.queued, []);

	// The first turn with the same binding hits the warmed cache entry.
	await probe.run({
		sessionKey,
		text: "Which orders are overdue?",
		toolArgumentConstraints: constraint.tool_argument_constraints,
		toolNamespacePrefix: constraint.tool_namespace_prefix,
		toolAllowedCallables: constraint.tool_allowed_callables,
	});
	assert.equal(
		described.length,
		warmDescribes,
		"the turn reuses the warm's schemas instead of describing again",
	);
}
{
	// A failing warm never surfaces as an error.
	const agent = tediDo({
		state: { slug: "acme" },
		async getMcpRuntime() {
			return {
				async executeTool() {
					throw new Error("gateway down");
				},
			};
		},
	});
	const response = await agent.onRequest(
		new Request("https://do.internal/__internal/chat/warm", {
			method: "POST",
			body: JSON.stringify({
				session_key: "embed:acme:1",
				tool_argument_constraints: { company_id: "1" },
				tool_allowed_callables: ["acme_staging.orders_list"],
			}),
		}),
	);
	assert.equal(response.status, 204);
}

// --- a warm and its turn agree on the cache key -------------------------------
{
	// The key the warm writes and the key the first turn reads are derived from
	// the same three inputs. A differing runId or session token must not split
	// them, or the warm buys nothing.
	const shared = {
		conversationId: "acme-demo-assistant:sess-abc",
		toolNamespacePrefix: "acme_staging",
		toolAllowedCallables: [
			"acme_staging.orders_status_summary",
			"acme_staging.orders_list",
		],
	};
	const warmKey = embeddedSchemaCacheKey(shared);
	const turnKey = embeddedSchemaCacheKey({ ...shared });
	assert.equal(warmKey, turnKey);

	// Callable ORDER must not split the key either: the warm builds its list
	// from the same claims, but nothing guarantees array order downstream.
	assert.equal(
		embeddedSchemaCacheKey({
			...shared,
			toolAllowedCallables: [
				"acme_staging.orders_list",
				"acme_staging.orders_status_summary",
			],
		}),
		warmKey,
		"callable order must not change the cache key",
	);

	// A different tenant must never read this warm.
	assert.notEqual(
		embeddedSchemaCacheKey({
			...shared,
			conversationId: "other-tedi:sess-abc",
		}),
		warmKey,
		"a warm must never cross the tenant boundary",
	);
}

// --- a warm with no constraints resolves nothing ------------------------------
{
	// `preparedTedixMcpAITools` returns the plain tool set untouched when the
	// binding is not tenant-bound, so an unbound warm cannot trigger a describe.
	let described = false;
	const runtime = {
		executeTool: async () => {
			described = true;
			return [];
		},
		getToolSpecs: () => [],
	} as never;
	await preparedTedixMcpAITools(runtime, null);
	assert.equal(described, false, "an unbound binding must not describe");
}

console.log("embedded-internal-routes.test.ts: all assertions passed");
