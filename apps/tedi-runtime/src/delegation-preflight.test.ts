import assert from "node:assert/strict";
import {
	assertNativeResearchCheckout,
	compactToolSchema,
	preflightDelegationTools,
	TOOL_SCHEMA_CHAR_CAP,
} from "./delegation-preflight";
import type { DelegationCapabilityPlan } from "@tedix/api-contract/schemas/kernel-runtime";
import {
	buildCodeModeResultHandle,
	readCodeModeResultPage,
	serializeCodeModeResultForHandle,
} from "@tedix/tedi-codemode-core/bounded-result";

const plan: DelegationCapabilityPlan = {
	version: "delegation-capabilities.v1",
	allowedToolIds: ["work.add_comment"],
	requiredCapabilities: ["work.comment"],
	missingCapabilities: [],
	urls: [],
	outputIds: [],
};
let modelCalls = 0;
async function replay(authorized: boolean) {
	const schemas = await preflightDelegationTools(plan, async (code) => {
		assert.match(code, /discover.describe/);
		return [
			{
				callable: "work.add_comment",
				authorized,
				missingScopes: authorized ? [] : ["mcp:work.write"],
				parameters: { type: "object", required: ["id", "body"] },
			},
		];
	});
	modelCalls++;
	return schemas;
}
await assert.rejects(replay(false), /mcp:work.write.*No scopes were added/);
assert.equal(modelCalls, 0, "missing scope fails before inference");
assert.match((await replay(true))[0]!, /"required":\["id","body"\]/);
const row = {
	callable: "work.add_comment",
	authorized: true,
	parameters: { type: "object" },
};
for (const result of [
	JSON.stringify([row]),
	{ result: [row] },
	{ result: { 0: row, length: 1 } },
]) {
	assert.match(
		(await preflightDelegationTools(plan, async () => result))[0]!,
		/work.add_comment/,
	);
}
for (const result of [
	{ __tedix_truncated: true, result: [row] },
	{ 1: row, length: 1 },
	{ result: [{ ...row, authorized: false }] },
]) {
	await assert.rejects(
		preflightDelegationTools(plan, async () => result),
		/could not be verified|unauthorized/,
	);
}
await assert.rejects(
	preflightDelegationTools(plan, async () => ({ partial: true })),
	/could not be verified/,
);
// Discovery metadata must not push authority/schema rows past the MCP model
// result limit before the preflight can inspect them.
const metadataHeavySchemas = await preflightDelegationTools(
	plan,
	async (code) => {
		const rows = await new Function("discover", `return (${code})()`)({
			describe: async (callable: string) => ({
				callable,
				authorized: true,
				parameters: { type: "object" },
				description: "x".repeat(12000),
			}),
		});
		assert.ok(JSON.stringify(rows).length < 12000);
		return rows;
	},
);
assert.match(metadataHeavySchemas[0]!, /work.add_comment/);
await assert.rejects(
	preflightDelegationTools(
		{ ...plan, missingCapabilities: ["work.comment"] },
		async () => {
			throw new Error("must not discover");
		},
	),
	/missing capabilities/,
);
for (const environment of [
	undefined,
	{ ready: false, preparation: "repository" },
	{ ready: true, preparation: "shell" },
]) {
	assert.doesNotThrow(() => assertNativeResearchCheckout(plan, environment));
	assert.doesNotThrow(() =>
		assertNativeResearchCheckout(undefined, environment),
	);
}
const repo = { ...plan, requiredCapabilities: ["repository.read"] };
assert.throws(
	() =>
		assertNativeResearchCheckout(repo, {
			ready: false,
			preparation: "repository",
		}),
	/empty or unready/,
);
assert.throws(
	() => assertNativeResearchCheckout(repo, undefined),
	/empty or unready.*too_large_for_native/,
);
// Replay: Home's native repository.read plan grants scratch clone_repo/repo_load.
// With no computer selected the child must reach them instead of failing at start.
const nativeSource = {
	...repo,
	allowedToolIds: [
		"read",
		"ls",
		"find",
		"grep",
		"code_search",
		"clone_repo",
		"repo_load",
	],
};
assert.doesNotThrow(() =>
	assertNativeResearchCheckout(nativeSource, undefined),
);
// A selected computer refuses scratch tools, so it must still be a ready checkout.
for (const environment of [
	{ ready: false, preparation: "repository" },
	{ ready: true, preparation: "shell" },
])
	assert.throws(
		() => assertNativeResearchCheckout(nativeSource, environment),
		/empty or unready/,
	);
assertNativeResearchCheckout(nativeSource, {
	ready: true,
	preparation: "repository",
});
assert.throws(
	() =>
		assertNativeResearchCheckout(repo, { ready: true, preparation: "shell" }),
	/empty or unready/,
);
assertNativeResearchCheckout(repo, { ready: true, preparation: "repository" });
assert.deepEqual(
	await preflightDelegationTools(undefined, async () => {
		throw new Error("must not discover");
	}),
	[],
);
// Replay: a busy gateway served a catalog without the Work namespace, and the
// first describe failed the whole delegated turn before inference.
const degraded = `Execution error: Callable "work.add_comment" is not exposed in the current gateway catalog. Nearest namespaces: home, organizations, flow.`;
let catalogReads = 0;
const recovered = await preflightDelegationTools(plan, async () => {
	catalogReads++;
	if (catalogReads === 1) throw new Error(degraded);
	return [row];
}, [0]);
assert.equal(catalogReads, 2);
assert.match(recovered[0]!, /work\.add_comment/);
let persistentReads = 0;
await assert.rejects(
	preflightDelegationTools(plan, async () => {
		persistentReads++;
		throw new Error(degraded);
	}, [0, 0]),
	/not exposed in the current gateway catalog/,
);
assert.equal(persistentReads, 3, "a persistent gap still fails closed");
let otherReads = 0;
await assert.rejects(
	preflightDelegationTools(plan, async () => {
		otherReads++;
		throw new Error("permission denied");
	}, [0]),
	/permission denied/,
);
assert.equal(otherReads, 1, "only a missing-catalog read is retried");
// Replay (Home run f762cb53): the describe rows for a document-drafting plan
// exceeded the gateway result budget, so the gateway kept them behind a
// `__tedix_result_handle` envelope. The preflight must page the stored result
// back with discover.read_result and verify it, never read the preview.
const draftPlan = {
	...plan,
	allowedToolIds: ["docs.create_document", "work.add_comment"],
};
const largeRows = draftPlan.allowedToolIds.map((callable) => ({
	callable,
	authorized: true,
	missingScopes: [],
	parameters: {
		type: "object",
		description: `${callable} "quoted" ${"schema ".repeat(1_900)}`,
	},
}));
const stored = serializeCodeModeResultForHandle(largeRows);
const handleEnvelope = buildCodeModeResultHandle(largeRows, stored, {
	handle: "exec-f762cb53",
	expiresAt: "2026-10-26T13:00:00.000Z",
});
const pagedCalls: string[] = [];
const paged = await preflightDelegationTools(draftPlan, async (code) => {
	pagedCalls.push(code);
	if (code.includes("discover.describe")) return handleEnvelope;
	const input = JSON.parse(
		/discover\.read_result\((.+)\)$/.exec(code)![1]!,
	) as { handle: string; offset: number; limit: number };
	assert.equal(input.handle, "exec-f762cb53");
	const page = readCodeModeResultPage(input.handle, stored, input);
	assert.ok(
		JSON.stringify(page, null, 2).length < 24_000,
		"each page fits the gateway's default result budget",
	);
	return { result: JSON.stringify(page) };
});
assert.ok(stored.length > 24_000, "the replay result is over budget");
assert.ok(pagedCalls.length > 2, "the stored result is paged back");
assert.deepEqual(
	paged.map((schema) => JSON.parse(schema).callable),
	draftPlan.allowedToolIds,
);
// A handle whose stored value expired cannot be verified and says so.
await assert.rejects(
	preflightDelegationTools(draftPlan, async (code) => {
		if (code.includes("discover.describe")) return handleEnvelope;
		throw new Error("Result handle exec-f762cb53 is unavailable");
	}),
	/^Error: Delegation preflight failed: tool authority result could not be read \(Result handle exec-f762cb53 is unavailable\)/,
);
// A page that is itself kept or clipped never stands in for the rows.
for (const page of [
	{ ...handleEnvelope, handle: "exec-page" },
	{ __tedix_truncated: true, preview: "[" },
	{ handle: "exec-f762cb53", text: stored.slice(0, 100), nextOffset: 0 },
])
	await assert.rejects(
		preflightDelegationTools(draftPlan, async (code) =>
			code.includes("discover.describe") ? handleEnvelope : page,
		),
		/tool authority could not be verified/,
	);
// Unauthorized rows behind a handle still fail on authority, not on paging.
const deniedRows = largeRows.map((value) => ({ ...value, authorized: false }));
const deniedStored = serializeCodeModeResultForHandle(deniedRows);
await assert.rejects(
	preflightDelegationTools(draftPlan, async (code) => {
		if (code.includes("discover.describe"))
			return buildCodeModeResultHandle(deniedRows, deniedStored, {
				handle: "exec-denied",
				expiresAt: "2026-10-26T13:00:00.000Z",
			});
		const input = JSON.parse(
			/discover\.read_result\((.+)\)$/.exec(code)![1]!,
		) as { handle: string; offset: number; limit: number };
		return readCodeModeResultPage(input.handle, deniedStored, input);
	}),
	/docs\.create_document is unavailable or unauthorized/,
);
// A tenant connection reachable only through the provider's embedded
// assistant is refused before inference instead of failing after rounds.
let embeddedOnlyModelCalls = 0;
await assert.rejects(
	preflightDelegationTools(
		{ ...plan, allowedToolIds: ["acme_staging.orders_status_summary"] },
		async (code) => {
			assert.match(
				code,
				/requiresEmbeddedSession: row\.requiresEmbeddedSession/,
			);
			return [
				{
					callable: "acme_staging.orders_status_summary",
					authorized: true,
					requiresEmbeddedSession: true,
					parameters: { type: "object" },
				},
			];
		},
	).then(() => embeddedOnlyModelCalls++),
	/orders_status_summary reaches its tenant connection only through the provider's embedded assistant.*no rounds were run/,
);
assert.equal(embeddedOnlyModelCalls, 0);
console.log(
	"PASS delegated tool authority and checkout preflight replay before inference",
);
// Replay (tenant runs 30ba6932, 22f5429b): the gateway's create_os_output
// input schema is 16,704 characters, over the 16,000-character prompt cap, and
// the preflight failed the whole turn after ten minutes with no tool run. An
// oversized schema is now compacted, never fatal.
const deepNode = (depth: number): Record<string, unknown> =>
	depth === 0
		? { type: "string", description: "leaf ".repeat(40), pattern: "^x+$" }
		: {
				type: "object",
				description: "level ".repeat(60),
				properties: { child: deepNode(depth - 1), note: { type: "string" } },
			};
const hugeParameters = {
	type: "object",
	required: ["kind", "title"],
	$defs: { richText: deepNode(6) },
	properties: {
		kind: { type: "string", enum: ["document", "sheet"] },
		title: { type: "string", maxLength: 200 },
		content: {
			oneOf: Array.from({ length: 12 }, (_, index) => ({
				type: "object",
				properties: { [`branch${index}`]: deepNode(5) },
				richText: { $ref: "#/$defs/richText" },
			})),
		},
	},
};
assert.ok(
	JSON.stringify(hugeParameters).length > TOOL_SCHEMA_CHAR_CAP,
	"the fixture is over the cap",
);
const compacted = compactToolSchema("os.create_os_output", hugeParameters);
assert.ok(compacted.length <= TOOL_SCHEMA_CHAR_CAP, "compacted under the cap");
const parsedCompact = JSON.parse(compacted) as {
	callable: string;
	parameters: { required?: string[]; properties: Record<string, unknown> };
};
assert.equal(parsedCompact.callable, "os.create_os_output");
assert.deepEqual(parsedCompact.parameters.required, ["kind", "title"]);
assert.ok("content" in parsedCompact.parameters.properties);
assert.doesNotMatch(compacted, /leaf leaf/, "annotations are dropped first");
const osPlan = { ...plan, allowedToolIds: ["os.create_os_output"] };
const [osSchema] = await preflightDelegationTools(osPlan, async () => [
	{
		callable: "os.create_os_output",
		authorized: true,
		missingScopes: [],
		parameters: hugeParameters,
	},
]);
assert.ok(osSchema!.length <= TOOL_SCHEMA_CHAR_CAP);
// A schema under the cap is passed through byte for byte.
assert.equal(
	compactToolSchema("work.add_comment", { type: "object" }),
	JSON.stringify({
		callable: "work.add_comment",
		parameters: { type: "object" },
	}),
);
// The last resort keeps the top-level shape and says where the rest is.
const wide = {
	type: "object",
	required: ["a"],
	properties: Object.fromEntries(
		Array.from({ length: 400 }, (_, index) => [
			`field${index}`,
			{ type: "string", enum: Array.from({ length: 20 }, (_, j) => `v${j}`) },
		]),
	),
};
const lastResort = JSON.parse(compactToolSchema("wide.tool", wide, 9_000)) as {
	parameters: { note?: string; properties: Record<string, { type?: string }> };
};
assert.match(lastResort.parameters.note ?? "", /tedix_mcp_search_tools/);
assert.equal(lastResort.parameters.properties.field0?.type, "string");
// Replay (cto run coding-native-apply-…-v4, 4 Nov 2026): a raw transport error
// from the describe read is a preflight failure the workflow seals at once,
// not an error it retries for twelve silent minutes.
await assert.rejects(
	preflightDelegationTools(plan, async () => {
		throw new Error("No assigned MCP servers connected");
	}),
	/^Error: Delegation preflight failed: the tedi's tool connection could not be read \(No assigned MCP servers connected\); return to Home and retry$/,
);
