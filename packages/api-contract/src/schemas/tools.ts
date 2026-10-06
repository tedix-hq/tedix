/**
 * MCP Tool Configuration Types
 *
 * Types for the unified multi-tenant MCP engine where apps configure
 * MCP tools dynamically via D1 database.
 */

import * as z from "zod";
import { type JsonValue, JsonValueSchema } from "./common";

export const EMPTY_TOOL_INPUT_SCHEMA = {
	type: "object",
	properties: {},
	additionalProperties: false,
} as const;

const JSON_SCHEMA_TYPE_VALUES = [
	"array",
	"boolean",
	"integer",
	"null",
	"number",
	"object",
	"string",
] as const;

const JsonSchemaTypeSchema = z.union([
	z.enum(JSON_SCHEMA_TYPE_VALUES),
	z.array(z.enum(JSON_SCHEMA_TYPE_VALUES)).min(1),
]);

/**
 * MCP JSON Schema object.
 *
 * Inputs use `ToolInputJsonSchemaSchema` below because MCP tool arguments are a
 * named-parameter object. Outputs intentionally use the broader schema here:
 * MCP structuredContent can be any JSON value, including arrays and scalars.
 */
export const ToolJsonSchemaSchema = z
	.object({
		type: JsonSchemaTypeSchema.optional(),
		properties: z.record(z.string(), JsonValueSchema).optional(),
		required: z.array(z.string().min(1)).optional(),
		items: JsonValueSchema.optional(),
		additionalProperties: z.union([z.boolean(), JsonValueSchema]).optional(),
	})
	.catchall(JsonValueSchema);

export type ToolJsonSchema = z.infer<typeof ToolJsonSchemaSchema>;

export const ToolInputJsonSchemaSchema = ToolJsonSchemaSchema.refine(
	(schema) => schema.type === "object" || schema.properties !== undefined,
	{
		message: "MCP tool inputSchema must be a root object JSON Schema.",
	},
).transform((schema) => ({
	...schema,
	type: "object" as const,
	properties: schema.properties ?? {},
}));

export type ToolInputJsonSchema = z.infer<typeof ToolInputJsonSchemaSchema>;

// =============================================================================
// NORMALIZED TOOL SCHEMA FIELD DEFINITION
// =============================================================================

/**
 * Primitive types supported in tool input schemas
 */
export type ToolSchemaFieldType =
	| "string"
	| "number"
	| "boolean"
	| "array"
	| "object";

/**
 * Normalized field definition derived from MCP JSON Schema at runtime.
 */
export interface ToolSchemaField {
	/** Field type */
	type: ToolSchemaFieldType;

	/** Whether the field is optional (default: false = required) */
	optional?: boolean;

	/** Default value when not provided */
	default?: unknown;

	/** Human-readable description for MCP tool documentation */
	description?: string;

	/** Enum values (for string type with fixed options) */
	enum?: string[];

	/** Minimum value (for number) or min length (for string/array) */
	min?: number;

	/** Maximum value (for number) or max length (for string/array) */
	max?: number;

	/** Array item schema (required when type is 'array') */
	items?: ToolSchemaField;

	/** Object properties (required when type is 'object') */
	properties?: Record<string, ToolSchemaField>;

	/**
	 * Pattern for string validation (regex)
	 * E.g., "^[A-Z]{2}$" for country codes
	 */
	pattern?: string;

	/**
	 * Format hint for string fields
	 * Used for UI rendering and validation
	 */
	format?: "email" | "url" | "date" | "datetime" | "uuid" | "currency";
}

/**
 * Complete input schema for a tool
 * Maps parameter names to their field definitions
 */
export interface ToolInputSchema {
	[key: string]: ToolSchemaField;
}

export const ToolInvocationStatusSchema = z.object({
	invoking: z.string().max(64).optional(),
	invoked: z.string().max(64).optional(),
});
export type ToolInvocationStatus = z.infer<typeof ToolInvocationStatusSchema>;

export const ToolAnnotationsSchema = z.object({
	title: z.string().optional(),
	readOnlyHint: z.boolean().optional(),
	destructiveHint: z.boolean().optional(),
	idempotentHint: z.boolean().optional(),
	openWorldHint: z.boolean().optional(),
});
export type ToolAnnotations = z.infer<typeof ToolAnnotationsSchema>;

/**
 * DECLARED write capability of a tool — the classification that decides whether
 * a call must be gated behind approval.
 *
 * Persisted on `app_tools.write_capability`, where the column is deliberately
 * NULLABLE and the three states are:
 *
 *   "read"        — DECLARED read-only. Safe to leave ungated.
 *   "write"       — DECLARED mutating, non-destructive.
 *   "destructive" — DECLARED mutating and irreversible.
 *   NULL          — UNDECLARED. NOT the same as "read": nobody has stated what
 *                   this tool does, so it must be treated as write-capable
 *                   (gated) and listed in the unclassified report.
 *
 * Conflating UNDECLARED with "read" is the exact defect this vocabulary exists
 * to prevent — never write a `?? "read"` or `?? false` against these values.
 */
export const TOOL_WRITE_CAPABILITY_VALUES = [
	"read",
	"write",
	"destructive",
] as const;
export type ToolWriteCapability = (typeof TOOL_WRITE_CAPABILITY_VALUES)[number];
export const ToolWriteCapabilitySchema = z.enum(TOOL_WRITE_CAPABILITY_VALUES);

/**
 * Operator-intent kind for first-party platform tools. Mirrors the in-memory
 * `kind` field on `PLATFORM_OPERATOR_TOOL_DEFINITIONS` and is the canonical
 * source for derived MCP `annotations` on those rows.
 *
 * Same vocabulary as {@link ToolWriteCapability} by construction — the operator
 * `kind` IS a declaration of write capability, so the persisted column and the
 * in-memory kind must never drift into two parallel spellings.
 */
export type OperatorToolKind = ToolWriteCapability;

/**
 * Derive the declared write capability from MCP annotations, preserving the
 * absent/false distinction.
 *
 * Returns `null` when the annotations do not state the answer — an annotation
 * object carrying only `idempotentHint`/`openWorldHint` classifies NOTHING and
 * must stay UNDECLARED rather than defaulting to read.
 *
 * `destructiveHint` wins over a contradictory `readOnlyHint:true` (fail closed).
 * Per the MCP spec `destructiveHint` is only meaningful when the tool is not
 * read-only, so an explicit `destructiveHint:false` on its own still declares a
 * write.
 */
export function deriveToolWriteCapability(
	annotations: ToolAnnotations | null | undefined,
): ToolWriteCapability | null {
	if (!annotations) return null;
	if (annotations.destructiveHint === true) return "destructive";
	if (annotations.readOnlyHint === true) return "read";
	if (
		annotations.readOnlyHint === false ||
		annotations.destructiveHint === false
	)
		return "write";
	return null;
}

/** The MCP hints a declared capability implies. Inverse of {@link deriveToolWriteCapability}. */
export function writeCapabilityToAnnotations(
	capability: ToolWriteCapability,
): Required<Pick<ToolAnnotations, "readOnlyHint" | "destructiveHint">> {
	return {
		readOnlyHint: capability === "read",
		destructiveHint: capability === "destructive",
	};
}

/**
 * Effective wire annotations for a stored tool row.
 *
 * `app_tools.write_capability` is a D1 column; every consumer that classifies a
 * tool (the Kernel write planner, the apps/mcp destructive gate, Code Mode)
 * reads MCP `annotations` off the wire instead. This projects the declaration
 * onto that wire shape so a manually declared tool — the ~52 third-party rows
 * whose upstream server simply never sends annotations — reaches those gates.
 *
 * Stored hints win where present (they are the provider's own statement); the
 * declared column only FILLS IN hints that are absent. A row with neither stays
 * `undefined`, which is what keeps UNDECLARED distinguishable downstream.
 */
export function resolveToolAnnotations(tool: {
	annotations?: ToolAnnotations | null;
	writeCapability?: ToolWriteCapability | null;
	meta?: Record<string, unknown> | null;
}): ToolAnnotations | undefined {
	const stored = tool.annotations ?? undefined;
	const policy = parseToolPolicyMetadata(tool.meta);
	if (policy?.riskTier) {
		return {
			...stored,
			readOnlyHint: policy.riskTier === "read",
			destructiveHint:
				policy.riskTier === "high_impact_write" ||
				policy.riskTier === "external_side_effect",
			...(policy.riskTier === "external_side_effect"
				? { openWorldHint: true }
				: {}),
		};
	}
	if (!tool.writeCapability) return stored;
	const declared = writeCapabilityToAnnotations(tool.writeCapability);
	return {
		...stored,
		...(stored?.readOnlyHint === undefined
			? { readOnlyHint: declared.readOnlyHint }
			: {}),
		...(stored?.destructiveHint === undefined
			? { destructiveHint: declared.destructiveHint }
			: {}),
	};
}

/**
 * Derive MCP tool annotations from a platform-operator `kind`.
 *
 * The destructive gate in `apps/mcp/src/mcp/governance.ts` keys off
 * `annotations.destructiveHint`. Without this mapping, the `kind` field on
 * `PLATFORM_OPERATOR_TOOL_DEFINITIONS` is in-memory only and the gate never
 * fires for first-party operator tools (e.g. `delete_app`, `delete_tedi`).
 *
 * Mapping:
 *   read        → { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false }
 *   write       → { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
 *   destructive → { readOnlyHint: false, destructiveHint: true,  idempotentHint: false, openWorldHint: false }
 */
export function operatorKindToAnnotations(
	kind: OperatorToolKind,
): Required<
	Pick<
		ToolAnnotations,
		"readOnlyHint" | "destructiveHint" | "idempotentHint" | "openWorldHint"
	>
> {
	return {
		readOnlyHint: kind === "read",
		destructiveHint: kind === "destructive",
		idempotentHint: kind === "read",
		openWorldHint: false,
	};
}

export const TOOL_POLICY_RISK_VALUES = [
	"low",
	"medium",
	"high",
	"critical",
] as const;
export type ToolPolicyRisk = (typeof TOOL_POLICY_RISK_VALUES)[number];

export const TOOL_OPERATIONAL_RISK_TIER_VALUES = [
	"read",
	"bounded_write",
	"high_impact_write",
	"external_side_effect",
] as const;
export type ToolOperationalRiskTier =
	(typeof TOOL_OPERATIONAL_RISK_TIER_VALUES)[number];

export const TOOL_BLAST_RADIUS_VALUES = [
	"none",
	"single_resource",
	"tenant",
	"multi_tenant",
	"external_system",
] as const;
export type ToolBlastRadius = (typeof TOOL_BLAST_RADIUS_VALUES)[number];

export const TOOL_POLICY_SENSITIVITY_VALUES = [
	"public",
	"internal",
	"confidential",
	"restricted",
] as const;
export type ToolPolicySensitivity =
	(typeof TOOL_POLICY_SENSITIVITY_VALUES)[number];

const Sha256DigestSchema = z
	.string()
	.regex(/^sha256:[a-f0-9]{64}$/, "Expected sha256:<64 lowercase hex chars>");

/**
 * Tedix governance metadata carried in app_tools.meta["com.tedix/policy"].
 * This intentionally lives inside existing MCP _meta storage so generated tools
 * can become policy-checkable without a D1 migration.
 */
export const ToolPolicyMetadataSchema = z
	.object({
		owner: z.string().min(1).max(160).optional(),
		risk: z.enum(TOOL_POLICY_RISK_VALUES).optional(),
		riskTier: z
			.enum(TOOL_OPERATIONAL_RISK_TIER_VALUES)
			.optional()
			.describe(
				"Operational enforcement tier. Optional only for pre-rollout or genuinely unclassified rows; absence is reported as unclassified and never treated as read.",
			),
		blastRadius: z
			.enum(TOOL_BLAST_RADIUS_VALUES)
			.optional()
			.describe(
				"Maximum side-effect boundary. Optional only while riskTier is also absent; a declared tier requires a compatible blast radius.",
			),
		sensitivity: z.enum(TOOL_POLICY_SENSITIVITY_VALUES).optional(),
		evidenceHash: Sha256DigestSchema.optional(),
		attestationHash: Sha256DigestSchema.optional(),
		policyChecks: z.array(z.string().min(1).max(160)).max(100).optional(),
	})
	.superRefine((policy, ctx) => {
		if (policy.riskTier === undefined && policy.blastRadius === undefined)
			return;
		if (policy.riskTier === undefined) {
			ctx.addIssue({
				code: "custom",
				path: ["riskTier"],
				message: "riskTier is required when blastRadius is declared",
			});
			return;
		}
		if (policy.blastRadius === undefined) {
			ctx.addIssue({
				code: "custom",
				path: ["blastRadius"],
				message: "blastRadius is required when riskTier is declared",
			});
			return;
		}
		const allowed: Record<ToolOperationalRiskTier, ToolBlastRadius[]> = {
			read: ["none"],
			bounded_write: ["single_resource", "tenant"],
			high_impact_write: ["tenant", "multi_tenant"],
			external_side_effect: ["external_system"],
		};
		if (!allowed[policy.riskTier].includes(policy.blastRadius)) {
			ctx.addIssue({
				code: "custom",
				path: ["blastRadius"],
				message: `${policy.blastRadius} is not valid for ${policy.riskTier}`,
			});
		}
	})
	.catchall(JsonValueSchema);
export type ToolPolicyMetadata = z.infer<typeof ToolPolicyMetadataSchema>;

export const TEDIX_TOOL_POLICY_META_KEY = "com.tedix/policy";

export function parseToolPolicyMetadata(
	meta: Record<string, unknown> | null | undefined,
): ToolPolicyMetadata | null {
	const raw = meta?.[TEDIX_TOOL_POLICY_META_KEY];
	if (raw === undefined) return null;
	const parsed = ToolPolicyMetadataSchema.safeParse(raw);
	return parsed.success ? parsed.data : null;
}

/** Persist the conservative operational baseline for a newly written D1 row. */
export function withDerivedToolOperationalRiskPolicy(input: {
	meta?: Record<string, JsonValue> | null;
	config?: Record<string, JsonValue> | null;
	writeCapability?: ToolWriteCapability | null;
}): Record<string, JsonValue> | null | undefined {
	if (!input.writeCapability) return input.meta;
	const existing = parseToolPolicyMetadata(input.meta);
	if (existing?.riskTier && existing.blastRadius) return input.meta;

	const transport = input.config?.transport;
	const external =
		input.writeCapability !== "read" &&
		(transport === "external" || transport === "mcp");
	const riskTier: ToolOperationalRiskTier = external
		? "external_side_effect"
		: input.writeCapability === "destructive"
			? "high_impact_write"
			: input.writeCapability === "write"
				? "bounded_write"
				: "read";
	const blastRadius: ToolBlastRadius = external
		? "external_system"
		: input.writeCapability === "destructive"
			? "tenant"
			: input.writeCapability === "write"
				? "single_resource"
				: "none";
	const rawPolicy = input.meta?.[TEDIX_TOOL_POLICY_META_KEY];
	const policy =
		typeof rawPolicy === "object" &&
		rawPolicy !== null &&
		!Array.isArray(rawPolicy)
			? rawPolicy
			: {};
	return {
		...input.meta,
		[TEDIX_TOOL_POLICY_META_KEY]: {
			...policy,
			riskTier,
			blastRadius,
		},
	};
}

export const TOOL_SKILL_COVERAGE_STATUS_VALUES = [
	"required",
	"excluded",
] as const;
export type ToolSkillCoverageStatus =
	(typeof TOOL_SKILL_COVERAGE_STATUS_VALUES)[number];

/**
 * Tedix skill coverage metadata carried in
 * app_tools.meta["com.tedix/skillCoverage"].
 *
 * `excluded` means the tool remains callable through MCP, but is not a direct
 * skill-coverage obligation because it is internal plumbing or an implementation
 * helper behind a broader operator workflow.
 */
export const ToolSkillCoverageMetadataSchema = z
	.object({
		status: z.enum(TOOL_SKILL_COVERAGE_STATUS_VALUES),
		reason: z.string().min(1).max(240).optional(),
		category: z.string().min(1).max(120).optional(),
		source: z.string().min(1).max(120).optional(),
		updatedAt: z.string().min(1).max(80).optional(),
	})
	.catchall(JsonValueSchema);
export type ToolSkillCoverageMetadata = z.infer<
	typeof ToolSkillCoverageMetadataSchema
>;

export const TEDIX_TOOL_SKILL_COVERAGE_META_KEY = "com.tedix/skillCoverage";

export function parseToolSkillCoverageMetadata(
	meta: Record<string, unknown> | null | undefined,
): ToolSkillCoverageMetadata | null {
	const raw = meta?.[TEDIX_TOOL_SKILL_COVERAGE_META_KEY];
	if (raw === undefined) return null;
	const parsed = ToolSkillCoverageMetadataSchema.safeParse(raw);
	return parsed.success ? parsed.data : null;
}

export function isToolExcludedFromSkillCoverage(
	meta: Record<string, unknown> | null | undefined,
): boolean {
	return parseToolSkillCoverageMetadata(meta)?.status === "excluded";
}

export const ToolMetaSchema = z
	.record(z.string(), JsonValueSchema)
	.superRefine((meta, ctx) => {
		const policyMeta = meta[TEDIX_TOOL_POLICY_META_KEY];
		if (policyMeta !== undefined) {
			const parsed = ToolPolicyMetadataSchema.safeParse(policyMeta);
			if (!parsed.success) {
				for (const issue of parsed.error.issues) {
					ctx.addIssue({
						...issue,
						path: [TEDIX_TOOL_POLICY_META_KEY, ...issue.path],
					});
				}
			}
		}

		const skillCoverageMeta = meta[TEDIX_TOOL_SKILL_COVERAGE_META_KEY];
		if (skillCoverageMeta !== undefined) {
			const skillCoverageParsed =
				ToolSkillCoverageMetadataSchema.safeParse(skillCoverageMeta);
			if (!skillCoverageParsed.success) {
				for (const issue of skillCoverageParsed.error.issues) {
					ctx.addIssue({
						...issue,
						path: [TEDIX_TOOL_SKILL_COVERAGE_META_KEY, ...issue.path],
					});
				}
			}
		}
	});
export type ToolMeta = z.infer<typeof ToolMetaSchema>;

export const ToolIconSchema = z.object({
	src: z.string().min(1),
	mimeType: z.string().optional(),
	sizes: z.array(z.string().min(1)).optional(),
	theme: z.enum(["light", "dark"]).optional(),
});
export type ToolIcon = z.infer<typeof ToolIconSchema>;

/**
 * Stored upstream/catalog execution.taskSupport values. Tedix does not
 * advertise these as runtime MCP Tasks support.
 */
export const TOOL_EXECUTION_TASK_SUPPORT_VALUES = [
	"forbidden",
	"optional",
	"required",
] as const;
export type ToolExecutionTaskSupport =
	(typeof TOOL_EXECUTION_TASK_SUPPORT_VALUES)[number];

/**
 * Tool schema storage dialect. All app_tools schemas are MCP JSON Schema.
 */
export const TOOL_SCHEMA_DIALECT_VALUES = ["json-schema-2020-12"] as const;
export type ToolSchemaDialect = (typeof TOOL_SCHEMA_DIALECT_VALUES)[number];

/**
 * System that generated or owns the stored tool schemas.
 */
export const TOOL_SCHEMA_SOURCE_VALUES = [
	"orpc",
	"openapi",
	"google-discovery",
	"mcp",
	"manual",
] as const;
export type ToolSchemaSource = (typeof TOOL_SCHEMA_SOURCE_VALUES)[number];

// =============================================================================
// TOOL ID NAMING
// =============================================================================

/**
 * All `app_tools.tool_id` names are verb-first snake_case (CLAUDE.md
 * "MCP Tool Naming"): `list_skills`, `run_skill_workflow`. tool_id is a D1
 * row, so no static lint can see it — this is the single source of truth for
 * the naming rule, reused by the state-aware `apps/api` write validation.
 * A schema cannot decide whether a non-conforming id is a grandfathered D1
 * row, so `ToolIdSchema` expresses the rule while the router decides whether
 * to enforce or warn after checking the existing app/tool key.
 */
export const TOOL_ID_SNAKE_CASE_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

/**
 * Approved leading verbs, derived from the surveyed well-named tools across
 * `apps/mcp` tool definitions, the platform-operator tool map, and the oRPC
 * projection surface. Extend deliberately when a genuinely new verb is needed
 * — never by renaming a noun into this list.
 */
export const TOOL_ID_LEADING_VERBS: ReadonlySet<string> = new Set([
	"activate",
	"analyze",
	"apply",
	"approve",
	"archive",
	"ask",
	"assign",
	"attach",
	"attribute",
	"audit",
	"backfill",
	"cancel",
	"capture",
	"check",
	"claim",
	"clone",
	"compare",
	"compose",
	"configure",
	"create",
	"decommission",
	"delete",
	"diff",
	"disable",
	"discover",
	"echo",
	"enable",
	"end",
	"evaluate",
	"execute",
	"export",
	"fetch",
	"find",
	"generate",
	"get",
	"greet",
	"improve",
	"initiate",
	"inspect",
	"install",
	"instantiate",
	"join",
	"link",
	"list",
	"load",
	"mine",
	"open",
	"patch",
	"pause",
	"pin",
	"preflight",
	"preview",
	"promote",
	"propagate",
	"propose",
	"provision",
	"publish",
	"quarantine",
	"query",
	"read",
	"reconcile",
	"record",
	"register",
	"reject",
	"release",
	"rename",
	"reorder",
	"repair",
	"replace",
	"request",
	"research",
	"reset",
	"respond",
	"restart",
	"resume",
	"retry",
	"review",
	"revise",
	"revoke",
	"rotate",
	"run",
	"save",
	"search",
	"send",
	"set",
	"steer",
	"store",
	"submit",
	"summarize",
	"sweep",
	"sync",
	"synthesize",
	"touch",
	"trigger",
	"unlink",
	"update",
	"upload",
	"upsert",
	"validate",
	"verify",
	"wake",
	"write",
]);

/**
 * Noun prefixes allowed ONLY for multi-product disambiguation (CLAUDE.md
 * "MCP Tool Naming": `gmail_send`, `workers_builds_list_builds`). An id may
 * lead with one of these when the remainder is itself verb-first
 * (`gmail_send`, `workers_builds_list_builds`). This is an exact allowlist —
 * a new product namespace gets added here deliberately, never inferred — so
 * plain noun-first ids (`apps_list`) stay rejected.
 */
export const TOOL_ID_NAMESPACE_PREFIXES: ReadonlySet<string> = new Set([
	"gmail",
	"workers_builds",
]);

/**
 * Returns the human-readable naming violation for a tool id, or null when the
 * id conforms. Kept as a plain function so non-zod layers share the exact same
 * verdict. Grandfathering is deliberately state-aware in apps/api: production
 * contains generated upstream ids, and a static exception list would reject
 * an existing row as soon as a later import introduced another upstream id.
 */
export function getToolIdNamingViolation(toolId: string): string | null {
	if (!TOOL_ID_SNAKE_CASE_RE.test(toolId)) {
		return `"${toolId}" is not snake_case — tool ids are lowercase letters, digits, and single underscores, like list_skills or run_skill_workflow (CLAUDE.md "MCP Tool Naming")`;
	}
	const leadingToken = toolId.split("_", 1)[0] ?? toolId;
	if (TOOL_ID_LEADING_VERBS.has(leadingToken)) return null;
	for (const prefix of TOOL_ID_NAMESPACE_PREFIXES) {
		if (!toolId.startsWith(`${prefix}_`)) continue;
		const remainder = toolId.slice(prefix.length + 1);
		const remainderVerb = remainder.split("_", 1)[0] ?? remainder;
		if (TOOL_ID_LEADING_VERBS.has(remainderVerb)) return null;
	}
	return `"${toolId}" is not verb-first — lead with an approved verb (list, get, create, update, delete, record, run, ...) like list_skills or run_skill_workflow. Noun prefixes are reserved for multi-product disambiguation (gmail_send) via TOOL_ID_NAMESPACE_PREFIXES; a genuinely new verb or product namespace belongs in the allowlists in @tedix/api-contract/schemas/tools, added deliberately (CLAUDE.md "MCP Tool Naming")`;
}

/**
 * Strict schema for a newly named `app_tools.tool_id`. Create/upsert contracts
 * keep the transport shape as a bounded string because only the API router can
 * distinguish a new id from an existing grandfathered D1 row.
 */
export const ToolIdSchema = z
	.string()
	.min(1)
	.max(100)
	.superRefine((toolId, ctx) => {
		const violation = getToolIdNamingViolation(toolId);
		if (violation) {
			ctx.addIssue({ code: "custom", message: violation });
		}
	});

// =============================================================================
// ADAPTER CONFIGURATION
// =============================================================================

/**
 * Which adapters should be queried for a tool
 * - "all": Query all available adapters for the app
 * - "primary": Query only the app's primary adapter
 * - string[]: Query specific adapter IDs
 */
export type AdapterScope = "all" | "primary" | string[];

export type ParsedAdapterScope = {
	mode: "all" | "primary" | "ids";
	adapterIds: string[];
	raw: string | null;
};

export type AdapterScopeParseResult =
	| { success: true; value: ParsedAdapterScope }
	| { success: false; error: string };

/**
 * How to combine results from multiple adapters
 * - parallel_all: Query all adapters in parallel, combine all results
 * - first_success: Query adapters in order, return first non-empty result
 * - merge: Query all, deduplicate and merge results
 */
export type ResultStrategy = "parallel_all" | "first_success" | "merge";

/**
 * Strict parser for adapter scope strings stored in D1.
 * Accepts "primary", "all", null/undefined, or a JSON array of non-empty string adapter IDs.
 */
export function parseAdapterScopeStrict(
	value: string | null | undefined,
): AdapterScopeParseResult {
	if (value === undefined || value === null) {
		return {
			success: true,
			value: { mode: "primary", adapterIds: [], raw: null },
		};
	}
	if (value === "primary" || value === "all") {
		return {
			success: true,
			value: { mode: value, adapterIds: [], raw: value },
		};
	}

	try {
		const parsed = JSON.parse(value);
		if (!Array.isArray(parsed)) {
			return {
				success: false,
				error:
					"adapterScope JSON must be an array of adapter IDs when not using 'primary' or 'all'.",
			};
		}

		const adapterIds = parsed.filter(
			(item): item is string =>
				typeof item === "string" && item.trim().length > 0,
		);
		if (adapterIds.length !== parsed.length) {
			return {
				success: false,
				error: "adapterScope array values must all be non-empty strings.",
			};
		}

		const deduped = [...new Set(adapterIds)];
		if (deduped.length === 0) {
			return {
				success: false,
				error: "adapterScope array must contain at least one adapter ID.",
			};
		}

		return {
			success: true,
			value: { mode: "ids", adapterIds: deduped, raw: value },
		};
	} catch {
		return {
			success: false,
			error:
				"adapterScope must be 'primary', 'all', or a JSON string array of adapter IDs.",
		};
	}
}

/**
 * Parse adapter scope from database string to typed value.
 */
export function parseAdapterScope(value: string | null): AdapterScope {
	const parsed = parseAdapterScopeStrict(value);
	if (!parsed.success) {
		throw new Error(parsed.error);
	}
	if (parsed.value.mode === "ids") return parsed.value.adapterIds;
	return parsed.value.mode;
}

/**
 * Serialize adapter scope for database storage
 */
export function serializeAdapterScope(scope: AdapterScope): string {
	if (scope === "all" || scope === "primary") return scope;
	return JSON.stringify(scope);
}

// =============================================================================
// TOOL TYPE CONFIGURATIONS
// =============================================================================

/**
 * Built-in tool type identifiers
 * - search: Product/listing search with adapters (SearchToolHandler)
 * - content: Content search with AI answers (ContentToolHandler)
 * - checkout: Checkout flows (CheckoutToolHandler)
 * - trading: Crypto/stock trading (TradingToolHandler)
 * - booking: Appointment/reservation booking (BookingToolHandler)
 * - memory: Tedi memory graph tools (MemoryToolHandler)
 * - adapter: Generic config-driven adapter execution (AdapterToolHandler)
 */
export type ToolTypeId =
	| "search"
	| "content"
	| "checkout"
	| "trading"
	| "booking"
	| "memory"
	| "adapter"
	| "rpc";

export const TOOL_TYPE_IDS = [
	"search",
	"content",
	"checkout",
	"trading",
	"booking",
	"memory",
	"adapter",
	"rpc",
] as const;

/**
 * Configuration for search-type tools
 * Passed to SearchToolHandler at runtime
 */
export interface SearchToolConfig {
	/** Enable batch mode for multi-product comparison */
	batchMode?: boolean;

	/** Maximum listings in batch mode (default: 8) */
	maxBatchSize?: number;

	/**
	 * Primary input key for batch queries (default: "listings")
	 * Example: "queries" to accept queries[] as batch input
	 */
	batchInputKey?: string;

	/**
	 * Additional input keys to accept for batch queries
	 * Example: ["queries", "items"]
	 */
	batchInputKeys?: string[];

	/** Enable natural language price/filter extraction */
	queryParsing?: boolean;

	/** Supported markets (e.g., ["DE", "AT", "SE"]) */
	markets?: string[];

	/** Default market when not specified */
	defaultMarket?: string;

	/** Default result limit */
	defaultLimit?: number;

	/** Default sort order */
	defaultSort?: "relevance" | "price" | "rating" | "popularity";

	/** Enable result deduplication across adapters */
	deduplication?: boolean;

	/** Similarity threshold for deduplication (0-1, default: 0.7) */
	deduplicationThreshold?: number;

	/** Vertical hint for query parsing (e.g., "automotive") */
	vertical?: string;

	/** Optional enrichment via external scrapers (e.g., Firecrawl) */
	enrichment?: {
		/** Provider identifier */
		provider?: "firecrawl";
		/** Enrichment mode */
		mode?: "none" | "top_n";
		/** Max items to enrich when mode=top_n */
		maxItems?: number;
		/** Scrape method */
		method?: "extract" | "agent";
		/** Scrape timeout in ms */
		timeoutMs?: number;
		/** Vertical hint for extraction prompts */
		vertical?: string;
		/** Price format hint */
		priceFormat?: "german" | "english";
	};
}

/**
 * Configuration for content-type tools
 * Passed to ContentToolHandler at runtime
 */
export interface ContentToolConfig {
	/** AI Search appId for tenant filtering */
	namespace?: string;

	/** Enable AI reranking (default: true) */
	reranking?: boolean;

	/** Semantic vs keyword weight (0-1, default: 0.75) */
	semanticWeight?: number;

	/** Enable AI query enrichment (default: true) */
	inputEnrichment?: boolean;

	/** Default result limit */
	defaultLimit?: number;

	/** Filter by content category */
	category?: "blog" | "docs" | "guide" | "faq" | "news" | "product";

	/** Enable AI-generated answers (requires Workers AI) */
	generateAnswers?: boolean;

	/** AI model for answer generation (default: "@cf/meta/llama-3.3-70b-instruct-fp8-fast") */
	aiModel?: string;

	/** AI temperature for answer generation (default: 0.7) */
	temperature?: number;

	/** Maximum tokens for AI responses (default: 500) */
	maxTokens?: number;

	/** Custom system prompt for AI answer generation */
	systemPrompt?: string;
}

/**
 * Configuration for checkout-type tools
 */
export interface CheckoutToolConfig {
	/** Supported checkout methods */
	methods?: ("native" | "redirect" | "deeplink" | "modal")[];

	/** Currency code (e.g., "EUR", "USD") */
	currency?: string;

	/** Minimum order value for checkout */
	minOrderValue?: number;

	/** Enable Apple Pay / Google Pay */
	nativePayments?: boolean;
}

/**
 * Configuration for trading-type tools (crypto, stocks)
 */
export interface TradingToolConfig {
	/** Supported assets/symbols */
	assets?: string[];

	/** Fiat currency for pricing */
	fiatCurrency?: string;

	/** Enable price history */
	priceHistory?: boolean;

	/** Real-time price updates */
	realtime?: boolean;

	/** Trading API provider */
	provider?: string;
}

/**
 * Configuration for booking-type tools
 */
export interface BookingToolConfig {
	/** Booking types supported */
	bookingTypes?: ("appointment" | "reservation" | "ticket" | "rental")[];

	/** Timezone for availability */
	timezone?: string;

	/** Advance booking limit in days */
	maxAdvanceDays?: number;

	/** Minimum notice in hours */
	minNoticeHours?: number;
}

/**
 * Configuration for memory-type tools (tedi memory graph)
 * Passed to MemoryToolHandler at runtime
 */
export interface MemoryToolConfig {
	/** Which memory operation this tool performs */
	operation?:
		| "search"
		| "learn"
		| "reflect"
		| "expertise"
		| "promote"
		| "gaps_detect"
		| "gaps_list"
		| "gaps_resolve"
		| "gaps_report"
		| "health"
		| "link"
		| "synthesize"
		| "opine"
		| "curiosity_queue"
		| "curiosity_next"
		| "curiosity_complete"
		| "curiosity_list"
		| "curiosity_suggest"
		| "optimize_scan"
		| "optimize_backlog"
		| "optimize_execute"
		| "optimize_review"
		| "synthesize_knowledge"
		| "opine_knowledge"
		| "list_knowledge"
		| "get_knowledge"
		| "record_skill"
		| "improve_skill"
		| "promote_skill"
		| "delete_skill"
		| "list_skills"
		| "list_skills_by_app"
		| "find_skills"
		| "get_skill"
		| "track_skill_usage"
		| "list_muscle_memories"
		| "register_muscle_memory"
		| "crystallize_muscle_memory"
		| "track_muscle_usage";

	/** Default topK for search queries (default: 10) */
	defaultTopK?: number;

	/** Minimum confidence threshold for search results (0-1, default: 0.3) */
	minConfidence?: number;

	/** Filter to a specific knowledge domain */
	domain?: string;

	/** Default confidence for new facts (0-1, default: 0.8) */
	defaultLearnConfidence?: number;

	/** Default reflection scope */
	defaultReflectScope?: "full" | "recent" | "domain";
}

/**
 * Configuration for generic adapter-type tools
 * Passed to AdapterToolHandler at runtime
 *
 * Enables tedis to create arbitrary API-backed tools via D1 config
 * without modifying source code.
 */
export interface AdapterToolConfig {
	/** Endpoint path (relative to API_URL) or absolute URL */
	endpoint: string;

	/** HTTP method (default: "POST") */
	method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

	/**
	 * Map tool input fields to request fields
	 * Key = input param name, Value = request body/query field name
	 * Example: { "query": "q", "maxResults": "limit" }
	 * If not set, input is passed through as-is.
	 */
	paramMap?: Record<string, string>;

	/**
	 * Constant params merged into every request
	 * Example: { "includeOffers": true }
	 */
	staticParams?: Record<string, unknown>;

	/**
	 * Map response fields to output fields
	 * Key = response field path (dot notation), Value = output field name
	 * Example: { "data.items": "results", "data.total": "totalResults" }
	 * If not set, response is passed through as-is.
	 */
	responseMap?: Record<string, string>;

	/** Request timeout in milliseconds (default: 30000) */
	timeout?: number;

	/** Extra headers to send with the request */
	headers?: Record<string, string>;

	/** Whether to use the service token for auth (default: true for relative endpoints) */
	useServiceAuth?: boolean;

	/** Text template for buildTextContent — interpolates {fieldName} from result */
	textTemplate?: string;
}

/**
 * Configuration for rpc-type tools (direct oRPC/REST endpoint calls)
 * Passed to ToolHandler at runtime
 *
 * Enables fully config-driven MCP tools that call any API endpoint
 * without code changes. Input/output shape controlled entirely from D1.
 */
/** Server-reviewed provider argument locations for a delegated resource operation. */
export const PersonalResourceToolBindingSchema = z
	.object({
		operation: z.string().trim().min(1).max(160),
		resourceType: z.string().trim().min(1).max(160),
		paths: z
			.array(z.array(z.string().min(1).max(100)).min(1).max(12))
			.min(1)
			.max(20),
	})
	.strict();
export type PersonalResourceToolBinding = z.infer<
	typeof PersonalResourceToolBindingSchema
>;

export interface ToolConfig {
	personalResourceBinding?: PersonalResourceToolBinding;
	/**
	 * Server-owned review of this exact connected tool's read-only execution.
	 * Required together with writeCapability: read for connections.read access.
	 * Upstream MCP hints do not establish this declaration. Catalog re-sync may
	 * invalidate it; review again before restoring read-only access.
	 */
	connectionReadOnly?: boolean;

	/** RPC procedure path (e.g., "apps/list") or REST path (e.g., "apps") */
	endpoint: string;

	/**
	 * Transport protocol (default: "rpc")
	 * - "rpc": POST to /rpc/{endpoint} with oRPC body format (internal API)
	 * - "rest": HTTP method to /v1/{endpoint} (internal API)
	 * - "external": HTTP call to {baseUrl}/{endpoint} with credential injection
	 * - "mcp": Materialized per-tool call to an upstream MCP server
	 * - "code": Execute stored JavaScript in a Dynamic Worker sandbox
	 */
	transport?: "rpc" | "rest" | "external" | "mcp" | "code";

	/** HTTP method for REST/external transport (default: "POST") */
	method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

	/**
	 * Map tool input fields to API request fields
	 * Key = tool input param name, Value = request body/query field name
	 * Example: { "appId": "appId", "searchQuery": "q" }
	 * If not set, input is passed through as-is.
	 */
	paramMap?: Record<string, string>;

	/**
	 * Constant params merged into every request
	 * Example: { "limit": 50, "includeInactive": false }
	 */
	staticParams?: Record<string, unknown>;

	/**
	 * Dot-path to extract from response (default: "json" for rpc, root for rest)
	 * Example: "data.items" extracts response.data.items
	 */
	responsePath?: string;

	/** Request timeout in milliseconds (default: 15000) */
	timeout?: number;

	/** json-render layout spec for genUI widgets (widgetKey: "render") */
	layoutSpec?: Record<string, unknown>;

	/**
	 * Map response fields to output fields for widget consumption
	 * Key = response field path (dot notation), Value = output field name
	 * Example: { "data": "items", "source": "sources" }
	 * Applied in buildStructuredContent after responsePath extraction.
	 * If not set, response is passed through as-is.
	 */
	responseMap?: Record<string, string>;

	/**
	 * Constant fields merged into structured output
	 * Example: { "layout": "comparison", "vertical": "ecommerce" }
	 * Merged after responseMap. Does not overwrite API response fields.
	 */
	staticOutput?: Record<string, unknown>;

	/**
	 * Compute derived fields on array items in the structured output.
	 * Runs after responseMap, before staticOutput.
	 *
	 * Each rule iterates the array at `arrayPath` and sets a new field
	 * on each item using a template with `{field.path}` placeholders.
	 *
	 * Example: format price from amount + currency
	 * ```json
	 * [{ "arrayPath": "items", "set": "price.formatted", "template": "{price.currency} {price.amount}" }]
	 * ```
	 */
	responseTransforms?: Array<{
		/** Dot-path to array of objects to transform (e.g., "items") */
		arrayPath: string;
		/** Dot-path within each item to set the computed value */
		set: string;
		/** Template string — `{field.path}` placeholders resolved from each item */
		template: string;
	}>;

	/**
	 * Remove fields from structured output before returning to the LLM.
	 * Supports dot-path with `[]` for array iteration.
	 *
	 * Example: strip payment methods and GTINs from each item's offers
	 * ```json
	 * ["items[].offers[].paymentMethods", "items[].metadata.gtins"]
	 * ```
	 */
	stripFields?: string[];

	/**
	 * Truncate nested arrays to a max length.
	 * Key = dot-path with `[]` for parent arrays, Value = max items to keep.
	 *
	 * Example: keep only top 5 offers per item
	 * ```json
	 * { "items[].offers": 5 }
	 * ```
	 */
	arrayLimits?: Record<string, number>;

	/**
	 * Model-facing text projection for dual-audience tool results.
	 * When set, the model-visible text content becomes this rendered template
	 * (still truncated at the standard max text length) while
	 * `structuredContent` keeps the full shaped payload for widgets/hosts.
	 * When absent, text content stays the full pretty-printed JSON payload.
	 *
	 * Same `{field.path}` placeholder syntax as responseTransforms, resolved
	 * against the shaped structured output, plus `{count:field.path}` which
	 * renders the length of the array at that path.
	 *
	 * Example:
	 * ```json
	 * "Found {count:items} of {meta.total} results. Full data in structuredContent."
	 * ```
	 */
	modelSummaryTemplate?: string;

	/**
	 * Declarative override for the MCP gateway's destructive-tool approval gate
	 * (`requireDestructiveToolApproval` in `apps/mcp/src/mcp/governance.ts`).
	 * Only consulted for tools whose `annotations.destructiveHint` is `true` —
	 * it has no effect on a non-destructive tool.
	 *
	 * - absent (default) / `"never"` — TODAY'S BEHAVIOR, unchanged. Every
	 *   destructive call is re-prompted (stateless `confirmDestructive`, agent
	 *   sync-MRTR round-trip, or human `elicitInput()`), no grant lookup runs.
	 *   This is the safe default for the overwhelming majority of tools, which
	 *   never set this field.
	 *   Exception: when the calling tedi's policy pack enables
	 *   `requireExplicitThirdPartyApprovalPolicy`, an autonomous Code Mode call
	 *   to a destructive third-party `external` or non-Tedix-managed `mcp`
	 *   transport must declare this field explicitly. Absence then fails closed
	 *   before agent self-confirmation. First-party RPC/REST/code tools and
	 *   Tedix-managed MCP hosts retain today's default.
	 * - `"once"` — before falling through to elicitation, the gate looks up a
	 *   durable single-use grant (`mcp_tool_approval_grants`, `grantKind:
	 *   "once"`) for the calling subject + this tool's scope. A matching,
	 *   unexpired, unconsumed grant is atomically consumed and satisfies
	 *   exactly this one call; a second call re-elicits like normal.
	 * - `"always"` — same lookup against a `grantKind: "always"` grant, but the
	 *   grant is never consumed — it satisfies every call until `expiresAt`.
	 * - `"work_item"` — autonomous agent calls must resolve a current,
	 *   user-authored authorization receipt on the exact active Work Item
	 *   claimed by that tedi. A missing, malformed, expired, or scope-mismatched
	 *   receipt denies before agent self-confirmation. User principals retain the
	 *   normal explicit confirmation/elicitation path.
	 *
	 * Setting this field does NOT itself create a grant. A grant only exists
	 * once a human/operator issues one via the `packages/db/src/queries/
	 * mcp-governance.ts` `createGrant` helper — there is no creation RPC/UI as
	 * of this field's introduction (see docs/mcp/runtime.md). A tool declaring
	 * `"once"`/`"always"` with zero matching grants behaves exactly like
	 * `"never"` — it always falls through to elicitation.
	 */
	approvalPolicy?: "always" | "once" | "never" | "work_item";
	/**
	 * Exact aggregate-bound overrides keyed by `{gatewayAppSlug}:{toolId}`.
	 * Use this when a source proxy tool is inherited by several tenant
	 * aggregates and only one tenant/tool pair has a special policy.
	 */
	approvalPolicies?: Record<string, "always" | "once" | "never" | "work_item">;

	// -- Identity override flags --

	/**
	 * Allow caller to pass explicit appId (don't force-override to ctx.appId).
	 * Use for tools that operate across apps within the same org (e.g., assignments, catalog).
	 * The API layer still enforces org-scoped access — this is defense-in-depth.
	 */
	allowExplicitAppId?: boolean;

	/**
	 * Allow caller to pass explicit tediId (don't force-override to callerIdentity.tediId).
	 * Use for tools that manage other tedis within the same org (e.g., tedi CRUD, assignments).
	 * The API layer still enforces org-scoped access — this is defense-in-depth.
	 */
	allowExplicitTediId?: boolean;

	/**
	 * Inject the caller's organization into `params.organizationId` from context
	 * (callerIdentity.organizationId ?? app.organizationId), overriding any
	 * caller-supplied value. Opt-in for RPC tools whose oRPC procedure takes a
	 * REQUIRED `organizationId` input (e.g. the members tools, modelled on the
	 * REST path `/{organizationId}/members`) so a forwarded MCP user does not
	 * have to pass — or be able to spoof — their own org UUID. The API layer's
	 * requireOrganizationAccess still backstops this.
	 */
	injectOrganizationId?: boolean;

	// -- External transport fields --

	/** Base URL for external API (required for transport: "external") */
	baseUrl?: string;

	/**
	 * Opt-in source attribution for read-only external research tools.
	 *
	 * The gateway attaches the exact requested URL and authenticated Tedix
	 * execution lineage to successful structured results. Credentials are never
	 * included: connection tokens live only in request headers.
	 */
	sourceProvenance?: {
		/** Canonical provider documentation describing the queried dataset. */
		documentationUrl?: string;
		/** Human-readable provider or dataset label. */
		provider?: string;
		/** Declared per-app edge budget projected into the result for audit. */
		rateBudget?: {
			requestsPerMinute: number;
			retryAfterSeconds: number;
		};
	};

	/**
	 * Static headers merged into every request for this tool.
	 * Keys are header names, values can be literal strings or `{paramName}`
	 * placeholders resolved from tool input (consumed from params like path params).
	 * Example: `{ "customer-client-id": "{customerClientId}" }`
	 */
	staticHeaders?: Record<string, string>;

	/**
	 * OpenAPI parameter names that must be sent as HTTP headers for external
	 * transport. Values are consumed from tool input before the request body is
	 * encoded.
	 */
	headerParams?: string[];

	/**
	 * OpenAPI parameter names that must be sent in the URL query string for
	 * external transport, including non-GET methods.
	 */
	queryParams?: string[];

	/** OpenAPI array query serialization; omitted fields keep repeated parameters. */
	queryArrayFormats?: Record<string, "comma" | "space" | "pipe">;

	/**
	 * Tool input fields used only by Tedix runtime policy and never forwarded to
	 * an external HTTP provider request.
	 */
	runtimeOnlyParams?: string[];

	/** Declarative case normalization for interpolated external path params. */
	pathParamCase?: Record<string, "lower" | "upper">;

	/**
	 * Request body content type for external transport.
	 * OpenAPI-generated tools use this to preserve multipart/form-data and
	 * application/x-www-form-urlencoded request bodies instead of defaulting to JSON.
	 */
	requestContentType?:
		| "application/json"
		| "application/vnd.olrapi.jsonlogic+json"
		| "application/x-www-form-urlencoded"
		| "multipart/form-data"
		| "text/markdown"
		| "text/plain";

	/**
	 * Input property to use as the HTTP request body for external transport.
	 * Remaining non-path parameters are sent as query parameters. This is needed
	 * for APIs such as Google Discovery where methods often combine path/query
	 * parameters with a JSON resource body.
	 */
	requestBodyParam?: string;

	/**
	 * Trusted JSON body template for external POST/PUT/PATCH tools.
	 *
	 * A template may contain scalar placeholders such as `{startDate}`. The
	 * runtime substitutes only values from `requestBodyTemplateParams`, consumes
	 * those inputs, and then sends the resulting object as `requestBodyParam`.
	 * This keeps fixed provider constraints (for example a GA4 path filter) out
	 * of model-controlled request bodies while preserving a small dynamic input
	 * surface such as a date range.
	 */
	requestBodyTemplate?: Record<string, unknown>;
	/** Input fields consumed while expanding `requestBodyTemplate`. */
	requestBodyTemplateParams?: string[];

	/**
	 * Response parser override for external transport.
	 * "base64" returns binary responses as { filename, mimeType, base64encoded, content }.
	 */
	responseMode?: "auto" | "json" | "text" | "base64";

	/**
	 * Body encoding transform for external transport.
	 * - "gmail-rfc2822": Encodes {to, subject, body, cc, bcc, draft, threadId, replyToMessageId}
	 * - "gmail-draft-send": Sends draft {id} — POSTs {id} in body to /drafts/{id}/send
	 *   into a base64url-encoded RFC 5322 message. Switches endpoint to drafts API when draft=true.
	 */
	bodyEncoding?: "gmail-rfc2822" | "gmail-draft-send";

	/**
	 * Credential resolution config for external transport.
	 * - "connection": Fetch token from Descope Token Vault via connectionId
	 * - "header": Static header value from config (for dev/testing)
	 */
	auth?: {
		type: "connection" | "header";
		/** Descope outbound app ID (required for type: "connection") */
		connectionId?: string;
		/** Exact authorized personal account slot. Never a label or credential. */
		connectionInstanceId?: string;
		/**
		 * Token scope for connection credentials.
		 * - "tenant": Org-level shared credential (default). All tedis share the same token.
		 * - "user": Per-user credential. Uses the tedi owner's Descope userId to fetch their personal token.
		 */
		scope?: "tenant" | "user" | "hybrid";
		/**
		 * Credential ownership resolution mode. Prefer this over `scope` for new tools.
		 * - "tenant": Org-level shared credential.
		 * - "user": Owner personal credential; an org owner may use their own.
		 * - "hybrid": Org owners default user-first; other members default tenant-first.
		 */
		credentialScope?: "tenant" | "user" | "hybrid";
		/**
		 * Resolution order when credentialScope is "hybrid". Explicit "user-first"
		 * opts a tenant workspace into using the acting member's personal credential.
		 */
		credentialPreference?: "user-first" | "tenant-first";
		/**
		 * Descope Token Vault scope labels for scope-filtered token retrieval.
		 * When set, uses fetchTenantTokenByScopes() instead of fetchTenantToken()
		 * to retrieve the specific API key matching these scopes.
		 * Example: ["project:tedix"] to select the tedix-specific Promptwatch key.
		 */
		scopes?: string[];
		/** Header name for the credential (default: "Authorization") */
		header?: string;
		/** Header value template — use {token} placeholder. Default: "Bearer {token}" */
		template?: string;
		/** Encode the token before applying the template. "base64" for Basic auth with raw credentials. */
		encoding?: "base64";
		/** Static header value (for type: "header") */
		value?: string;
		/**
		 * OAuth2 client credentials exchange config.
		 * When set, the stored credential (base64-encoded client_id:client_secret) is
		 * exchanged for a bearer token via the tokenUrl before injecting into the request.
		 * The resulting bearer token is cached using the server-reported expires_in.
		 */
		clientCredentials?: {
			/** Token endpoint URL (e.g. "https://api.neo4j.io/oauth/token") */
			tokenUrl: string;
			/** OAuth2 grant type (default: "client_credentials") */
			grantType?: string;
		};
	};

	// -- MCP transport fields --

	/** Full URL to upstream MCP server (e.g., "https://mcp.firecrawl.dev/v2/mcp-oauth") */
	mcpServerUrl?: string;

	/** Upstream MCP server identifier from catalog import/sync metadata */
	mcpServerId?: string;

	/** Original tool name on the remote MCP server (required for transport: "mcp") */
	mcpToolName?: string;

	// -- Code transport fields --

	/**
	 * JavaScript code module to execute in a Dynamic Worker sandbox.
	 * Required for transport: "code". The code receives tool input as `args`
	 * and has access to all app tool namespaces via the Code Mode executor.
	 *
	 * Can be a function body (receives `args`) or a module with default export.
	 */
	codeModule?: string;
}

/**
 * Config for toolTypeId="prompt" rows.
 * Defines a reusable prompt template with {{argName}} placeholders.
 */
export interface PromptToolConfig {
	/** Prompt template with {{argName}} substitution placeholders */
	template: string;
}

/**
 * Union of all tool configuration types
 */
export type AnyToolConfig =
	| SearchToolConfig
	| ContentToolConfig
	| CheckoutToolConfig
	| TradingToolConfig
	| BookingToolConfig
	| MemoryToolConfig
	| AdapterToolConfig
	| PromptToolConfig
	| ToolConfig;
