import assert from "node:assert/strict";
import { assertFacetToolRegistryAvailable } from "./facet-turn-guard";

// Only the parent's typed registry-loss result interrupts a turn.
for (const result of [
	undefined,
	null,
	"error",
	{},
	{ error: "tool failed" },
	{ code: "permission_denied" },
]) {
	assert.doesNotThrow(() => assertFacetToolRegistryAvailable(result));
}
assert.throws(
	() =>
		assertFacetToolRegistryAvailable({
			code: "facet_tool_unavailable",
			error: "registry lost",
		}),
	/FACET_TOOL_REGISTRY_UNAVAILABLE/,
);

console.log("facet-turn-guard OK");
