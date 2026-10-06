/**
 * Which model an embedded quick-chat session routes at when the user picks
 * nothing.
 *
 * Kept as a pure rule, separate from the session mint, because it is the part
 * with a policy consequence: a default is applied to every turn nobody thinks
 * about, so it must not be able to name a model the tedi may not route at.
 * The hardcoded Workers AI pin this replaced did exactly that — the catalog
 * denied it as `runtime_provider_unsupported` while every unpicked turn used
 * it, which is how a surface default outran the picker's own policy.
 *
 * Precedence: the operator's configured default, then the tedi's own resolved
 * chat model. Either is kept ONLY if it survives the catalog's allow-list, and
 * `null` (no default, tedi's model stands) is preferred over routing at
 * something denied.
 */
export function resolveQuickChatDefaultRef(input: {
	/** Refs the model catalog marked allowed for this tedi. */
	allowedRefs: readonly string[];
	/** `organizations.metadata.tediWidget.defaultModelRef`, when configured. */
	configuredRef?: string | null;
	/** The tedi's own resolved chat-slot routing, when one resolves. */
	routedRef?: string | null;
}): string | null {
	const allowed = new Set(input.allowedRefs);
	for (const candidate of [input.configuredRef, input.routedRef]) {
		if (typeof candidate === "string" && allowed.has(candidate))
			return candidate;
	}
	return null;
}
