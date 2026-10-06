import * as z from "zod";

/**
 * Derive a WebMCP tool's input JSON Schema from the owning zod contract in
 * `@tedix/api-contract`, per the doctrine in docs/product/tedix-os.md ("One
 * backend contract, two thin adapters"): tool schemas are adapters over the
 * canonical contract, never a second contract. What the contract owns —
 * required fields, enum vocabularies, string/array caps, formats — is
 * CONVERTED (zod v4's native `z.toJSONSchema`); what the tool deliberately
 * adds — extra strictness (a required `expectedRevision`), tool-only fields
 * (`tediSlug`, `confirm`), pinned limits, surface descriptions — stays an
 * EXPLICIT per-tool overlay in the options below.
 *
 * Contract schema modules are pure zod (no window/app-bootstrap reads), so
 * tool modules may import them and this helper at module scope; the
 * `lint:os` WebMCP import-inertness gate bans only the app-bootstrap
 * modules (`@/lib/api`, `@/router`, …).
 *
 * A conversion failure (an unrepresentable picked field, a picked key the
 * contract no longer has) throws at build time — loudly, in every tool-module
 * test — instead of registering a wrong schema.
 */

/** One JSON Schema node; nested nodes stay `unknown` and are walked structurally. */
export type JsonSchemaObject = Record<string, unknown>;

export interface DeriveToolSchemaOptions {
	/** Contract shape keys the tool exposes. Everything else stays server-side. */
	pick: readonly string[];
	/**
	 * Overlay strictness: keys (picked or extra) the TOOL requires beyond the
	 * contract's own required set — e.g. the CAS tools' `expectedRevision`,
	 * which the contract keeps optional on purpose. Contract-required picked
	 * keys are required automatically and need not be repeated here.
	 */
	require?: readonly string[];
	/**
	 * Per-field JSON Schema overlay, shallow-merged over the derived property
	 * (overlay keys win). Use it for tool-facing descriptions and deliberate
	 * tool-side tightening; a full replacement simply supplies `type` too.
	 */
	override?: Readonly<Record<string, JsonSchemaObject>>;
	/**
	 * Tool-only fields that do NOT exist on the contract (`tediSlug`,
	 * `confirm`, a markdown `content` remap). Hand-written by design — they are
	 * the adapter's own surface. Optional unless listed in `require`.
	 */
	extra?: Readonly<Record<string, JsonSchemaObject>>;
	/**
	 * Explicit `additionalProperties` for the tool schema. Omitted keeps
	 * whatever the contract derives (`.strict()` contracts derive `false`).
	 */
	additionalProperties?: boolean;
}

/**
 * Unwrap optional/default/nullable wrappers to the underlying schema — oRPC
 * list inputs are commonly `z.object({...}).optional()`.
 */
function unwrapZod(schema: z.ZodType): z.ZodType {
	let current = schema;
	for (;;) {
		const def = current.def as { type?: string; innerType?: z.ZodType };
		if (
			(def.type === "optional" ||
				def.type === "default" ||
				def.type === "nullable") &&
			def.innerType
		) {
			current = def.innerType;
			continue;
		}
		return current;
	}
}

interface ContractProcedure {
	"~orpc": { inputSchemas?: readonly unknown[] };
}

/**
 * The input zod object of an oRPC contract procedure, for inputs defined
 * inline in the contract rather than as a named schema export (e.g.
 * `workItemsContract.list`, `skillsContract.runWorkflow`).
 */
export function contractInputSchema(
	procedure: ContractProcedure,
): z.ZodObject<z.ZodRawShape> {
	const first = procedure["~orpc"].inputSchemas?.[0];
	if (first === undefined) {
		throw new Error("contract procedure declares no input schema");
	}
	const unwrapped = unwrapZod(first as z.ZodType);
	if (!(unwrapped instanceof z.ZodObject)) {
		throw new Error("contract procedure input is not a zod object");
	}
	return unwrapped;
}

/**
 * Normalize a derived node for a browser-agent audience without changing what
 * validates: drop the redundant `pattern` next to a declared `format` (uuid /
 * date-time regexes are enormous), drop the meaningless
 * `maximum: MAX_SAFE_INTEGER` zod emits for plain `.int()`, and state integer
 * `exclusiveMinimum` as the equivalent inclusive `minimum`.
 */
function sanitizeNode(node: JsonSchemaObject): void {
	if (typeof node["format"] === "string" && "pattern" in node) {
		delete node["pattern"];
	}
	if (node["maximum"] === Number.MAX_SAFE_INTEGER) {
		delete node["maximum"];
	}
	if (
		node["type"] === "integer" &&
		typeof node["exclusiveMinimum"] === "number"
	) {
		node["minimum"] = node["exclusiveMinimum"] + 1;
		delete node["exclusiveMinimum"];
	}
}

function sanitizeTree(value: unknown): void {
	if (Array.isArray(value)) {
		for (const entry of value) sanitizeTree(entry);
		return;
	}
	if (typeof value !== "object" || value === null) return;
	sanitizeNode(value as JsonSchemaObject);
	for (const entry of Object.values(value)) sanitizeTree(entry);
}

/**
 * Build a WebMCP tool input schema from the owning contract object plus the
 * tool's explicit overlay. See the module docblock for the division of
 * ownership; see `DeriveToolSchemaOptions` for each overlay knob.
 */
export function deriveToolSchema(
	contract: z.ZodObject<z.ZodRawShape>,
	options: DeriveToolSchemaOptions,
): JsonSchemaObject {
	const mask = Object.fromEntries(
		options.pick.map((key) => [key, true as const]),
	);
	// `io: "input"` derives what a CALLER may send (defaults optional).
	const derived = z.toJSONSchema(contract.pick(mask), {
		io: "input",
	}) as JsonSchemaObject;
	delete derived["$schema"];
	sanitizeTree(derived);

	const properties = (derived["properties"] ?? {}) as Record<
		string,
		JsonSchemaObject
	>;
	for (const [key, overlay] of Object.entries(options.override ?? {})) {
		const base = properties[key];
		if (base === undefined) {
			throw new Error(`override key "${key}" is not a picked contract field`);
		}
		properties[key] = { ...base, ...overlay };
	}
	for (const [key, extraSchema] of Object.entries(options.extra ?? {})) {
		if (key in properties) {
			throw new Error(`extra key "${key}" collides with a picked field`);
		}
		properties[key] = { ...extraSchema };
	}
	derived["properties"] = properties;

	const required = new Set<string>(
		(derived["required"] as readonly string[] | undefined) ?? [],
	);
	for (const key of options.require ?? []) {
		if (!(key in properties)) {
			throw new Error(`required key "${key}" is not a tool field`);
		}
		required.add(key);
	}
	if (required.size > 0) {
		// Stable order: declaration order of the final property set.
		derived["required"] = Object.keys(properties).filter((key) =>
			required.has(key),
		);
	} else {
		delete derived["required"];
	}

	if (options.additionalProperties !== undefined) {
		derived["additionalProperties"] = options.additionalProperties;
	}
	return derived;
}
