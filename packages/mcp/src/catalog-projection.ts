import { isRecord } from "@tedix/api-contract/utils/is-record";

const DISCOVERY_DESCRIPTION_BUDGET = 280;

/**
 * Project a catalog entry for the discovery wire: strip the heavy
 * `parameters` (full input JSON Schema) and `outputSchema` blobs unless the
 * caller explicitly opted into each. Both default off so casual discovery
 * stays compact and survives client-side truncation — callers add
 * { includeParameters: true } / { includeOutputSchema: true } when they need
 * exact schemas to plan a call or downstream composition. Native descriptors,
 * schema freshness and match evidence require includeMetadata; describe keeps
 * the complete definition.
 */
export function projectCatalogMeta(
	meta: unknown,
	includeParameters: boolean,
	includeOutputSchema: boolean,
	fullDescription = false,
	includeMetadata = false,
): unknown {
	if (!isRecord(meta)) return meta;
	const { parameters, outputSchema, ...rest } = meta;
	const {
		native: _native,
		wire: _wire,
		schemaFreshness: _freshness,
		_match,
		...compact
	} = rest;
	const compacted =
		!fullDescription && typeof rest.description === "string"
			? compactDiscoveryDescription(rest.description)
			: null;
	return {
		...(fullDescription || includeMetadata ? rest : compact),
		...(compacted ? compacted : {}),
		...(includeParameters ? { parameters } : {}),
		...(includeOutputSchema ? { outputSchema } : {}),
	};
}

/**
 * Search rows carry a bounded description: the full text (vendor tools ship
 * multi-KB REST doc dumps) is one discover.describe(callable) away, and
 * ranking already ran against the full text. The paid-tool notice appended by
 * buildCatalogProvider survives truncation in full — it changes how the call
 * must be made, so it must never be cut.
 */
function compactDiscoveryDescription(description: string): {
	description: string;
	descriptionTruncated?: true;
} {
	const paidIndex = description.indexOf("\n\nPaid tool: ");
	const head = (paidIndex >= 0 ? description.slice(0, paidIndex) : description)
		.replace(/\s+/g, " ")
		.trim();
	const tail =
		paidIndex >= 0 ? description.slice(paidIndex).replace(/\s+/g, " ") : "";
	if (head.length <= DISCOVERY_DESCRIPTION_BUDGET)
		return { description: `${head}${tail}` };
	const cut = head.slice(0, DISCOVERY_DESCRIPTION_BUDGET);
	const lastSpace = cut.lastIndexOf(" ");
	const trimmed = (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd();
	return {
		description: `${trimmed}…${tail}`,
		descriptionTruncated: true,
	};
}
