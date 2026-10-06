import { isRecord } from "@tedix/api-contract/utils/is-record";

/**
 * Deterministic resolver for 2026-07-28 MRTR `inputRequests` — used by the
 * `apps/mcp` upstream proxy to answer an UPSTREAM MCP server's `input_required`
 * round-trip agent-in-the-loop, without a human and without a model seam.
 *
 * The proxy runs at the edge with no model, so this is a schema-driven,
 * fail-closed fill (mirroring `@tedix/mcp-client-core`'s
 * `deterministicElicitationAnswer`, kept separate to avoid a heavy client
 * dependency in the edge and to stay clear of in-flight elicitation-schema
 * work). Each response is the spec-shaped result for the request's method:
 *
 * - `elicitation/create` → `ElicitResult` `{ action: "accept", content }` where
 *   `content` fills `requestedSchema` defaults/zeros. Booleans with no default
 *   resolve to `false` — so an upstream destructive CONFIRM is auto-DECLINED,
 *   never auto-confirmed (Tedix's own destructive gate already ran before the
 *   proxy dispatched the tool, so this second, upstream-side confirm is a
 *   secondary UX prompt that fails closed).
 * Returns `null` when it cannot confidently fulfil every outstanding request;
 * the caller then surfaces the `input_required` to its own caller instead.
 */

const ELICITATION_METHOD = "elicitation/create";

interface FillSchema {
	type?: string;
	default?: unknown;
	enum?: unknown[];
	properties?: Record<string, unknown>;
	required?: unknown[];
	items?: { enum?: unknown[] };
	minItems?: number;
}

/** Zero value for a primitive schema type. Booleans → `false` (fail closed). */
function typedZero(schema: FillSchema): unknown {
	switch (schema.type) {
		case "number":
		case "integer":
			return 0;
		case "boolean":
			return false;
		case "array":
			return [];
		case "object":
			return {};
		default:
			return "";
	}
}

/** A single property's deterministic value, or `undefined` to omit it. */
function deterministicValue(schema: FillSchema): unknown {
	// SEP-1034: an explicit per-type default always wins.
	if (schema.default !== undefined) return schema.default;
	// SEP-1330 multi-select: array of enum members; pick the first `minItems`.
	if (schema.type === "array") {
		const itemEnum = schema.items?.enum;
		if (Array.isArray(itemEnum) && itemEnum.length > 0) {
			const minItems =
				typeof schema.minItems === "number" && schema.minItems > 0
					? schema.minItems
					: 0;
			if (minItems > 0)
				return itemEnum.slice(0, Math.min(minItems, itemEnum.length));
		}
		return undefined;
	}
	// Scalar enum: first member.
	if (Array.isArray(schema.enum) && schema.enum.length > 0)
		return schema.enum[0];
	return undefined;
}

/** Fill an elicitation `requestedSchema` deterministically. */
export function deterministicElicitationContent(
	requestedSchema: unknown,
): Record<string, unknown> {
	const schema = isRecord(requestedSchema)
		? (requestedSchema as FillSchema)
		: {};
	const out: Record<string, unknown> = {};
	const properties = isRecord(schema.properties) ? schema.properties : {};
	const required = new Set(
		(schema.required ?? []).filter(
			(name): name is string => typeof name === "string",
		),
	);
	for (const [name, raw] of Object.entries(properties)) {
		const prop = isRecord(raw) ? (raw as FillSchema) : {};
		const value = deterministicValue(prop);
		if (value !== undefined) {
			out[name] = value;
		} else if (required.has(name)) {
			out[name] = typedZero(prop);
		}
	}
	for (const name of required) {
		if (!(name in out)) out[name] = "";
	}
	return out;
}

/**
 * Resolve every outstanding MRTR `inputRequests` entry to its spec-shaped
 * response. Returns the `inputResponses` map to echo on the retry, or `null`
 * when any request is not the supported elicitation request type.
 */
export function resolveInputRequestsDeterministic(
	inputRequests: Record<string, unknown>,
): Record<string, unknown> | null {
	const entries = Object.entries(inputRequests ?? {});
	if (entries.length === 0) return null;

	const responses: Record<string, unknown> = {};
	for (const [key, rawRequest] of entries) {
		const request = isRecord(rawRequest) ? rawRequest : {};
		const method =
			typeof request.method === "string" ? request.method : ELICITATION_METHOD;
		const params = isRecord(request.params) ? request.params : {};

		if (method === ELICITATION_METHOD) {
			responses[key] = {
				action: "accept",
				content: deterministicElicitationContent(params.requestedSchema),
			};
			continue;
		}
		// Tedix only supports the current elicitation MRTR request type. Roots and
		// Sampling are not part of the gateway capability surface.
		return null;
	}
	return responses;
}
