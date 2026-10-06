/**
 * Agent-to-agent elicitation / MRTR resolution.
 *
 * When a tedi/kernel calls another server's tool and that server answers with
 * `input_required` (synchronous MRTR `resultType: "input_required"`, or a Tasks
 * `tasks/get` state with `inputRequests`), an interactive client would surface a
 * human prompt. A tedi has no human in the loop — it answers the elicitation by
 * REASONING over the requested schema, exactly as if it were filling the form.
 *
 * This module owns the runtime-neutral resolver: it parses each
 * `elicitation/create`-shaped request, asks an injected model seam (the isolate's
 * own LLM) to produce values matching `requestedSchema`, and falls back to a
 * deterministic schema-default fill when no model seam is wired. The result is
 * the `inputResponses` map mcp-client-core echoes back via `tasks/update` or the
 * synchronous retry.
 *
 * The model seam is intentionally an interface, not a hard dependency: runtime
 * packages (apps/tedi-runtime) inject their existing JSON-generation call so the
 * core package stays free of any model SDK.
 */

import { isRecord } from "@tedix/api-contract/utils/is-record";

/** JSON-schema fragment for an elicitation form (subset we understand). */
export interface ElicitationSchema {
	type?: string;
	properties?: Record<string, ElicitationSchema>;
	required?: string[];
	enum?: unknown[];
	/**
	 * SEP-1330: human-readable labels parallel to `enum` (same index, same
	 * length). Display-only metadata — the answer still carries the raw `enum`
	 * VALUE, never the label — but carried through so the model seam can reason
	 * over titled choices.
	 */
	enumNames?: unknown[];
	default?: unknown;
	title?: string;
	description?: string;
	items?: ElicitationSchema;
	/** SEP-1330 multi-select array constraints. */
	minItems?: number;
	maxItems?: number;
	uniqueItems?: boolean;
}

/**
 * A single `input_required` request as carried in `inputRequests[key]`. The MRTR
 * envelope wraps an `elicitation/create` request; the schema may live at
 * `params.requestedSchema` (spec shape) or directly on `requestedSchema`.
 */
export interface ElicitationRequest {
	method?: string;
	message?: string;
	requestedSchema?: ElicitationSchema;
	params?: {
		message?: string;
		requestedSchema?: ElicitationSchema;
		[key: string]: unknown;
	};
	[key: string]: unknown;
}

/** Context handed to the model seam so it can reason about the answer. */
export interface ElicitationModelRequest {
	/** The `inputRequests` key this request was filed under. */
	key: string;
	/** Human-readable prompt the upstream server attached, if any. */
	message?: string;
	/** The JSON schema the answer must satisfy. */
	requestedSchema: ElicitationSchema;
	/** The originating task id (empty for synchronous MRTR). */
	taskId: string;
}

/**
 * Model seam: given an elicitation request, return an object matching
 * `requestedSchema`. Implementations call the agent's own LLM in JSON mode.
 * Returning `null`/`undefined` (or throwing) falls back to the deterministic
 * resolver for that request so a model hiccup never strands the round-trip.
 */
export type ElicitationModel = (
	request: ElicitationModelRequest,
) => Promise<Record<string, unknown> | null | undefined>;

export interface AgentElicitationResolverOptions {
	/**
	 * The agent's LLM seam. When omitted, the resolver is fully deterministic
	 * (schema defaults / typed zero-values for required fields).
	 *
	 * LLM-SEAM HOOKUP POINT: apps/tedi-runtime injects a function that calls
	 * `observerCompletion` (Azure JSON mode) with the schema + message, parses the
	 * JSON object, and returns it. See `AgentMcpRuntime`.
	 */
	model?: ElicitationModel;
	/** Optional warn-level logger for fallback diagnostics. */
	logger?: Pick<Console, "warn">;
}

function resolveSchema(request: ElicitationRequest): ElicitationSchema {
	return (
		request.requestedSchema ??
		request.params?.requestedSchema ?? { type: "object" }
	);
}

function resolveMessage(request: ElicitationRequest): string | undefined {
	return request.message ?? request.params?.message;
}

/**
 * Deterministic, model-free answer: echo each property's `default`, the first
 * `enum` member, or a typed zero-value. Only `required` fields are guaranteed to
 * be present; optional fields are included when they carry a usable default.
 * This keeps a tedi from deadlocking on an elicitation even with no model wired.
 */
export function deterministicElicitationAnswer(
	schema: ElicitationSchema,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	const properties = isRecord(schema.properties) ? schema.properties : {};
	const required = new Set(
		(schema.required ?? []).filter(
			(name): name is string => typeof name === "string",
		),
	);
	for (const [name, raw] of Object.entries(properties)) {
		const prop = isRecord(raw) ? (raw as ElicitationSchema) : {};
		const value = deterministicValue(prop);
		if (value !== undefined) {
			out[name] = value;
			continue;
		}
		if (required.has(name)) out[name] = typedZero(prop);
	}
	// Ensure required fields without a property definition still appear.
	for (const name of required) {
		if (!(name in out)) out[name] = "";
	}
	return out;
}

function deterministicValue(schema: ElicitationSchema): unknown {
	// SEP-1034: an explicit per-type `default` always wins, for every primitive
	// (string/number/boolean) AND for array-level multi-select defaults.
	if (schema.default !== undefined) return schema.default;
	// SEP-1330 multi-select: `type: "array"` with `items.enum`. With no default,
	// pick the first `minItems` enum members (a deterministic minimal valid
	// selection). When `minItems` is 0/undefined there is no forced pick — fall
	// through so an optional field is omitted and a required one gets `[]`.
	if (schema.type === "array") {
		const itemEnum = schema.items?.enum;
		if (Array.isArray(itemEnum) && itemEnum.length > 0) {
			const minItems =
				typeof schema.minItems === "number" && schema.minItems > 0
					? schema.minItems
					: 0;
			if (minItems > 0) {
				// Enum members are distinct, so the first N honor `uniqueItems`.
				return itemEnum.slice(0, Math.min(minItems, itemEnum.length));
			}
		}
		return undefined;
	}
	// Scalar enum: first member (SEP-1330 titled labels don't change the value).
	if (Array.isArray(schema.enum) && schema.enum.length > 0)
		return schema.enum[0];
	return undefined;
}

function typedZero(schema: ElicitationSchema): unknown {
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

/**
 * Coerce a model-produced object to the schema so an over- or under-eager model
 * answer still satisfies required fields. Missing required keys are backfilled
 * deterministically; unknown keys are preserved (servers ignore extras).
 */
function reconcileWithSchema(
	answer: Record<string, unknown>,
	schema: ElicitationSchema,
): Record<string, unknown> {
	const fallback = deterministicElicitationAnswer(schema);
	const required = new Set(
		(schema.required ?? []).filter(
			(name): name is string => typeof name === "string",
		),
	);
	const out: Record<string, unknown> = { ...answer };
	for (const name of required) {
		if (out[name] === undefined) out[name] = fallback[name] ?? "";
	}
	return out;
}

/**
 * Build the `onTaskInputRequired` resolver mcp-client-core invokes for both the
 * synchronous MRTR retry and the async `tasks/update` round-trip. Iterates every
 * pending request, asks the model seam (falling back to deterministic fills),
 * and returns the `inputResponses` map keyed identically to `inputRequests`.
 *
 * Each response is a spec-shaped `ElicitResult` — `{ action: "accept",
 * content: {...} }` — matching what the SDK-path elicitation handler returns.
 * The bare content map this used to emit was rejected by strict servers
 * validating `ElicitResult` (MRTR spec, elicitation §responses); Tedix's own
 * consumers (governance approval extraction) unwrap `.content` recursively, so
 * both shapes stay accepted server-side.
 */
export function createAgentElicitationResolver(
	options: AgentElicitationResolverOptions = {},
): (input: {
	taskId: string;
	inputRequests: Record<string, unknown>;
}) => Promise<Record<string, unknown> | null> {
	const { model, logger } = options;
	return async ({ taskId, inputRequests }) => {
		const entries = Object.entries(inputRequests ?? {});
		if (entries.length === 0) return null;

		const responses: Record<string, unknown> = {};
		for (const [key, rawRequest] of entries) {
			const request = isRecord(rawRequest)
				? (rawRequest as ElicitationRequest)
				: ({} as ElicitationRequest);
			const schema = resolveSchema(request);
			const message = resolveMessage(request);

			let answer: Record<string, unknown> | null | undefined;
			if (model) {
				try {
					answer = await model({
						key,
						message,
						requestedSchema: schema,
						taskId,
					});
				} catch (err) {
					logger?.warn(
						`[mcp-elicitation] model seam failed for "${key}"; using deterministic fill:`,
						err,
					);
					answer = null;
				}
			}

			const content = answer
				? reconcileWithSchema(answer, schema)
				: deterministicElicitationAnswer(schema);
			responses[key] = { action: "accept", content };
		}
		return responses;
	};
}
