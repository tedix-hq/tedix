/**
 * Common Zod Schemas for oRPC Contracts
 * Shared validation schemas used across all API contracts
 *
 * This file contains foundational schemas used by other schema modules.
 * Import order matters - other schemas may depend on these.
 */

import * as z from "zod";

// =============================================================================
// ENUM SCHEMAS (used by layout and other schemas)
// =============================================================================

/**
 * Badge variant schema
 * Matches @tedix/db BadgeVariant type
 */
export const BadgeVariantSchema = z.enum([
	"default",
	"secondary",
	"destructive",
	"success",
	"warning",
	"outline",
]);
export type BadgeVariant = z.infer<typeof BadgeVariantSchema>;

/**
 * Stock status schema
 * Matches @tedix/db StockStatus type
 */
export const StockStatusSchema = z.enum([
	"in_stock",
	"out_of_stock",
	"limited",
	"preorder",
	"unknown",
]);
export type StockStatus = z.infer<typeof StockStatusSchema>;

// =============================================================================
// PAGINATION SCHEMAS
// =============================================================================

/**
 * Pagination input parameters
 * Standard pagination for list endpoints
 */
export const PaginationSchema = z.object({
	limit: z.coerce.number().min(1).max(100).default(50),
	offset: z.coerce.number().min(0).default(0),
});

export type PaginationInput = z.infer<typeof PaginationSchema>;

/**
 * Pagination metadata for responses
 */
export const PaginationMetaSchema = z.object({
	limit: z.number(),
	offset: z.number(),
	total: z.number(),
	hasMore: z.boolean(),
});

export type PaginationMeta = z.infer<typeof PaginationMetaSchema>;

/**
 * Generic paginated response schema factory
 * Creates a paginated response schema for any data type
 *
 * @example
 * const PaginatedAppsSchema = createPaginatedResponseSchema(AppSchema);
 */
export function createPaginatedResponseSchema<T extends z.ZodTypeAny>(
	itemSchema: T,
) {
	return z.object({
		data: z.array(itemSchema),
		pagination: PaginationMetaSchema,
	});
}

// =============================================================================
// ID PARAMETER SCHEMAS
// =============================================================================

/**
 * Generic UUID parameter
 */
export const UuidParamSchema = z.object({
	id: z.uuid("Invalid ID format"),
});

export type UuidParam = z.infer<typeof UuidParamSchema>;

/**
 * App ID path parameter
 */
export const AppIdParamSchema = z.object({
	appId: z.uuid("App ID must be a valid UUID"),
});

export type AppIdParam = z.infer<typeof AppIdParamSchema>;

/**
 * App ID or slug parameter — accepts either a UUID or a human-readable slug.
 * Used by MCP tools so tedis can reference apps by name or ID interchangeably.
 */
export const AppIdOrSlugParamSchema = z.object({
	appIdOrSlug: z
		.string()
		.min(1, "App ID or slug is required")
		.describe("App UUID or slug (e.g. '4d156152-...' or 'cloudflare')"),
});

export type AppIdOrSlugParam = z.infer<typeof AppIdOrSlugParamSchema>;

/**
 * Organization ID path parameter
 */
export const OrgIdParamSchema = z.object({
	organizationId: z.uuid("Organization ID must be a valid UUID"),
});

export type OrgIdParam = z.infer<typeof OrgIdParamSchema>;

/**
 * Member ID path parameter
 */
export const MemberIdParamSchema = z.object({
	memberId: z.uuid("Member ID must be a valid UUID"),
});

export type MemberIdParam = z.infer<typeof MemberIdParamSchema>;

// =============================================================================
// SLUG SCHEMAS
// =============================================================================

/**
 * Generic slug parameter
 */
export const SlugParamSchema = z.object({
	slug: z.string().min(1).max(100),
});

export type SlugParam = z.infer<typeof SlugParamSchema>;

// =============================================================================
// COMMON RESPONSE SCHEMAS
// =============================================================================

/**
 * Generic success response
 */
export const SuccessResponseSchema = z.object({
	success: z.literal(true),
	message: z.string().optional(),
});

export type SuccessResponse = z.infer<typeof SuccessResponseSchema>;

/**
 * Generic delete response with deleted resource ID
 */
export const DeleteResponseSchema = z.object({
	success: z.literal(true),
	deletedId: z.uuid(),
});

export type DeleteResponse = z.infer<typeof DeleteResponseSchema>;

// =============================================================================
// TIMESTAMP SCHEMAS
// =============================================================================

/**
 * ISO 8601 timestamp string
 */
export const TimestampSchema = z.iso.datetime().nullable();

/**
 * Common timestamp fields for entities
 */
export const TimestampsSchema = z.object({
	createdAt: TimestampSchema,
	updatedAt: TimestampSchema,
});

export type Timestamps = z.infer<typeof TimestampsSchema>;

// =============================================================================
// JSON VALUE SCHEMAS
// =============================================================================

/**
 * Recursive JSON value type
 * Represents any valid JSON value
 */
export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue };

/**
 * Recursive JSON value schema
 * Validates any valid JSON value structure
 */
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
	z.union([
		z.string(),
		z.number(),
		z.boolean(),
		z.null(),
		z.array(JsonValueSchema),
		z.record(z.string(), JsonValueSchema),
	]),
);

/** Cloudflare Workflows accepts only ASCII letters, digits, hyphens, and underscores. */
export const WorkflowEventTypeSchema = z
	.string()
	.trim()
	.min(1)
	.max(100)
	.regex(
		/^[A-Za-z0-9_-]+$/,
		"Workflow event types may contain only letters, digits, hyphens, and underscores",
	);
