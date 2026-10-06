import assert from "node:assert/strict";
import { rankSignedPortableTools } from "./embedded-webmcp-discovery";

const signed = ["acme.list_orders", "acme.get_order", "acme.add_note"];
const executionId = "11111111-1111-4111-8111-111111111111";
const persistedReceipt = {
	executionId,
	usagePersistence: "persisted" as const,
};
let requests: unknown[] = [];
const rank = async (request: {
	candidates: Array<{ id: string; description: string }>;
}) => {
	requests.push(request);
	return {
		rankedIds: request.candidates.map((candidate) => candidate.id).reverse(),
		usagePersistence: "persisted" as const,
		executionAttempts: [{ executionId } as never],
	};
};

assert.deepEqual(
	await rankSignedPortableTools({
		query: "  find the latest order  ",
		callables: ["acme.list_orders", "intruder.delete_all", "acme.get_order"],
		signedCallables: signed,
		rank,
	}),
	{
		rankedIds: ["acme.get_order", "acme.list_orders"],
		receipt: persistedReceipt,
	},
);
assert.deepEqual(requests, [
	{
		query: "find the latest order",
		candidates: [
			{ id: "acme.list_orders", kind: "tool", description: "acme list orders" },
			{ id: "acme.get_order", kind: "tool", description: "acme get order" },
		],
	},
]);

requests = [];
assert.deepEqual(
	await rankSignedPortableTools({
		query: "find the latest order",
		callables: ["intruder.delete_all", "acme.get_order"],
		signedCallables: signed,
		rank,
	}),
	{ rankedIds: null, receipt: null },
);
assert.equal(requests.length, 0, "one signed candidate cannot dispatch Jev");

requests = [];
assert.deepEqual(
	await rankSignedPortableTools({
		query: "find the order tool",
		callables: ["acme.list_orders", "acme.get_order", "acme.add_note"],
		// Same namespace, but the signed provider route omits add_note.
		signedCallables: ["acme.list_orders", "acme.get_order"],
		rank,
	}),
	{
		rankedIds: ["acme.get_order", "acme.list_orders"],
		receipt: persistedReceipt,
	},
);
assert.deepEqual(
	(requests[0] as { candidates: Array<{ id: string }> }).candidates.map(
		(candidate) => candidate.id,
	),
	["acme.list_orders", "acme.get_order"],
	"Jev must never see the browser's cross-route candidate",
);
requests = [];

assert.deepEqual(
	await rankSignedPortableTools({
		query: "acme.get_order",
		callables: ["acme.list_orders", "acme.get_order"],
		signedCallables: signed,
		rank,
	}),
	{ rankedIds: ["acme.get_order", "acme.list_orders"], receipt: null },
);
assert.equal(requests.length, 0, "exact callable lookup bypasses Jev");

for (const rankedIds of [
	["intruder.delete_all", "acme.list_orders"],
	["acme.list_orders", "acme.list_orders"],
	null,
]) {
	assert.deepEqual(
		await rankSignedPortableTools({
			query: "find the latest order",
			callables: ["acme.list_orders", "acme.get_order"],
			signedCallables: signed,
			rank: async () => ({
				rankedIds,
				usagePersistence: "persisted",
				executionAttempts: [{ executionId } as never],
			}),
		}),
		{ rankedIds: null, receipt: persistedReceipt },
		"a paid but rejected ranking must retain its receipt",
	);
}
assert.deepEqual(
	await rankSignedPortableTools({
		query: "find the latest order",
		callables: ["acme.list_orders", "acme.get_order"],
		signedCallables: signed,
		rank: async () => ({
			rankedIds: ["acme.get_order", "acme.list_orders"],
			usagePersistence: "failed",
			executionAttempts: [{ executionId } as never],
		}),
	}),
	{ rankedIds: null, receipt: { executionId, usagePersistence: "failed" } },
);
assert.deepEqual(
	await rankSignedPortableTools({
		query: "find the latest order",
		callables: ["acme.list_orders", "acme.get_order"],
		signedCallables: signed,
		rank: async () => ({
			rankedIds: ["acme.get_order", "acme.list_orders"],
			usagePersistence: "persisted",
			executionAttempts: [],
		}),
	}),
	{ rankedIds: null, receipt: null },
	"an uncorrelatable rank must not displace stable order",
);
assert.deepEqual(
	await rankSignedPortableTools({
		query: "find the latest order",
		callables: ["acme.list_orders", "acme.get_order"],
		signedCallables: signed,
		rank: async () => {
			throw new Error("provider unavailable");
		},
	}),
	{ rankedIds: null, receipt: null },
);

console.log(
	"embedded WebMCP discovery remains signed, advisory, and fail-soft",
);
