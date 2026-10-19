import assert from "node:assert/strict";
import {
	assertNativeResearchCheckout,
	preflightDelegationTools,
} from "./delegation-preflight";
import type { DelegationCapabilityPlan } from "@tedix/api-contract/schemas/kernel-runtime";

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
await assert.rejects(
	preflightDelegationTools(plan, async () => ({ partial: true })),
	/could not be verified/,
);
await assert.rejects(
	preflightDelegationTools(
		{ ...plan, missingCapabilities: ["work.comment"] },
		async () => {
			throw new Error("must not discover");
		},
	),
	/missing capabilities/,
);
const repo = { ...plan, requiredCapabilities: ["repository.read"] };
assert.throws(
	() => assertNativeResearchCheckout(repo, undefined),
	/empty or unready.*too_large_for_native/,
);
assert.throws(
	() =>
		assertNativeResearchCheckout(repo, { ready: true, preparation: "shell" }),
	/empty or unready/,
);
assertNativeResearchCheckout(repo, { ready: true, preparation: "repository" });
await assert.rejects(
	preflightDelegationTools(undefined, async () => {
		throw new Error("must not discover");
	}),
	/exact source\/tool mappings/,
);
console.log(
	"PASS delegated tool authority and checkout preflight replay before inference",
);
