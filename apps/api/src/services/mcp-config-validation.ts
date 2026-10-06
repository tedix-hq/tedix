import {
	type AdapterType,
	CustomAdapterConfigSchema,
	InternalAdapterConfigSchema,
	KlarnaAdapterConfigSchema,
	McpAdapterConfigSchema,
	ShopifyAdapterConfigSchema,
	WebhookAdapterConfigSchema,
} from "@tedix/api-contract/schemas/adapters";
import {
	getToolIdNamingViolation,
	parseAdapterScopeStrict,
	ToolInputJsonSchemaSchema,
	ToolJsonSchemaSchema,
} from "@tedix/api-contract/schemas/tools";
import * as z from "zod";

export type ValidationIssue = {
	path: string;
	message: string;
};

export type ValidationResult = {
	valid: boolean;
	errors: ValidationIssue[];
	warnings: ValidationIssue[];
};

function fromZodIssues(issues: z.ZodIssue[]): ValidationIssue[] {
	return issues.map((issue) => ({
		path: issue.path.length > 0 ? issue.path.join(".") : "$",
		message: issue.message,
	}));
}

const AdapterConfigByType = {
	klarna: KlarnaAdapterConfigSchema.strict(),
	shopify: ShopifyAdapterConfigSchema.strict(),
	custom: CustomAdapterConfigSchema.strict(),
	webhook: WebhookAdapterConfigSchema.strict(),
	mcp: McpAdapterConfigSchema.strict(),
	internal: InternalAdapterConfigSchema.strict(),
} as const;

export function validateAdapterConfig(
	adapterType: AdapterType,
	config: unknown,
): ValidationResult {
	if (config == null) {
		return {
			valid: true,
			errors: [],
			warnings: [
				{
					path: "config",
					message:
						"Adapter config is empty; runtime may rely on defaults or secret bindings.",
				},
			],
		};
	}

	const parser = AdapterConfigByType[adapterType];
	const parsed = parser.safeParse(config);
	if (!parsed.success) {
		return {
			valid: false,
			errors: fromZodIssues(parsed.error.issues),
			warnings: [],
		};
	}

	return { valid: true, errors: [], warnings: [] };
}

export function validateToolSchema(
	schema: unknown,
	fieldName: string,
): ValidationResult {
	if (schema == null) {
		if (fieldName === "outputSchema") {
			return { valid: true, errors: [], warnings: [] };
		}
		return {
			valid: false,
			errors: [
				{
					path: fieldName,
					message: "inputSchema must be a non-null MCP JSON Schema object.",
				},
			],
			warnings: [],
		};
	}

	const parser =
		fieldName === "inputSchema"
			? ToolInputJsonSchemaSchema
			: ToolJsonSchemaSchema;
	const asJsonSchema = parser.safeParse(schema);
	if (asJsonSchema.success) {
		return { valid: true, errors: [], warnings: [] };
	}

	const issues = asJsonSchema.error.issues.map((issue) => ({
		...issue,
		path: [fieldName, ...issue.path],
	}));

	return {
		valid: false,
		errors: fromZodIssues(issues),
		warnings: [],
	};
}

export function validateAdapterScopeString(
	adapterScope: string | null | undefined,
): ValidationResult {
	const parsed = parseAdapterScopeStrict(adapterScope);
	if (!parsed.success) {
		return {
			valid: false,
			errors: [{ path: "adapterScope", message: parsed.error }],
			warnings: [],
		};
	}
	return { valid: true, errors: [], warnings: [] };
}

/**
 * MCP tool ids follow the verb-first snake_case convention from CLAUDE.md
 * "MCP Tool Naming" (`list_skills`, `run_skill_workflow`). The rule itself —
 * regex, verb allowlist, and the grandfather set for pre-convention D1 rows —
 * lives in `@tedix/api-contract/schemas/tools` (`getToolIdNamingViolation`),
 * the same source of truth `ToolIdSchema` enforces on the create contract.
 *
 * `enforce: true` (default) returns violations as errors, matching the
 * contract. Pass `enforce: false` on advisory paths where a violation must
 * not block (preflight of an `update`, whose toolId is immutable anyway).
 */
export function validateToolIdStyle(
	toolId: string,
	options: { enforce?: boolean } = {},
): ValidationResult {
	const { enforce = true } = options;
	const violation = getToolIdNamingViolation(toolId);
	if (!violation) {
		return { valid: true, errors: [], warnings: [] };
	}
	const issue: ValidationIssue = { path: "toolId", message: violation };
	if (enforce) {
		return { valid: false, errors: [issue], warnings: [] };
	}
	return { valid: true, errors: [], warnings: [issue] };
}

/**
 * Apply the strict naming verdict with the state only the write router knows.
 * Existing logical ids are grandfathered dynamically; update never renames the
 * logical id, so it is advisory as well.
 */
export function validateToolIdWriteState(
	toolId: string,
	options: { operation: "create" | "update"; exists: boolean },
): ValidationResult {
	const strict = validateToolIdStyle(toolId);
	if (strict.valid) return strict;
	return options.operation === "create" && !options.exists
		? strict
		: validateToolIdStyle(toolId, { enforce: false });
}

export function mergeValidationResults(
	...results: ValidationResult[]
): ValidationResult {
	const errors = results.flatMap((r) => r.errors);
	const warnings = results.flatMap((r) => r.warnings);
	return {
		valid: errors.length === 0,
		errors,
		warnings,
	};
}
