export const TEDIX_KERNEL_RUN_META_KEY = "io.tedix/kernelRunId";
export const TEDIX_WORK_ITEM_META_KEY = "io.tedix/workItemId";
export const TEDIX_TRACE_BUNDLE_META_KEY = "io.tedix/traceBundleId";

export function metaString(
	meta: Record<string, unknown> | undefined,
	key: string,
): string | undefined {
	const value = meta?.[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Gateway attestation of operator consent.
 *
 * Returns the JSON envelope for `X-Tedix-Operator-Consent` on internal
 * tedi-bound dispatches, or null when no attestation is warranted. The rule is
 * deliberately narrow: only a skill-workflow caller whose admission row says a
 * human started the run (`createdBy: "user:<descopeUserId>"`) attests.
 * Agent-, tedi-, schedule-, and M2M-started runs return null — the fail-closed
 * negative control — and prompt text claiming consent never reaches this
 * function at all: the inputs come from service-binding headers the bridge
 * builds from host-side props.
 */
export function buildOperatorConsentHeader(
	caller:
		| { skillRunId?: string; skillRunCreatedBy?: string; skillId?: string }
		| undefined
		| null,
): string | null {
	if (!caller?.skillRunId) return null;
	if (!caller.skillRunCreatedBy?.startsWith("user:")) return null;
	return JSON.stringify({
		v: 1,
		runId: caller.skillRunId,
		...(caller.skillId ? { skillId: caller.skillId } : {}),
		createdBy: caller.skillRunCreatedBy,
		attestedBy: "tedix-mcp-gateway",
	});
}
