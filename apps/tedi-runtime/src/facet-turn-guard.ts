/** A lost parent registry cannot produce a successful conversational result. */
export function assertFacetToolRegistryAvailable(result: unknown): void {
	if (
		result !== null &&
		typeof result === "object" &&
		"code" in result &&
		result.code === "facet_tool_unavailable"
	) {
		throw new Error(
			"FACET_TOOL_REGISTRY_UNAVAILABLE: the parent must rebuild this turn before tools can execute",
		);
	}
}
