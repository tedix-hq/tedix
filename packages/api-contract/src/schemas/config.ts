/**
 * App Configuration Schemas for oRPC Contracts
 * Zod schemas for app configuration validation
 *
 * Note: Some schemas (AppCapabilitiesSchema, McpConfigSchema, AppMetadataSchema)
 * are duplicated from app.ts with runtime-config specific passthrough behavior.
 */

import * as z from "zod";
import { JsonValueSchema } from "./common";
import {
	ToolAnnotationsSchema,
	ToolInputJsonSchemaSchema,
	ToolInvocationStatusSchema,
} from "./tools";

// =============================================================================
// CONSTANTS
// =============================================================================

export const APP_CONFIG_SCHEMA_VERSION = 1;

/**
 * Vertical values (single source of truth)
 * Also exported from @tedix/db/schema for DB column type
 */
export const VERTICAL_VALUES = [
	"ecommerce",
	"marketplace",
	"automotive",
	"real_estate",
	"jobs",
	"travel",
	"crypto",
	"content",
	"services",
] as const;

export type VerticalValue = (typeof VERTICAL_VALUES)[number];

/**
 * Widget route registry
 * Defines all valid widget route segments
 */
export const WIDGET_REGISTRY = {
	render: {
		segment: "r",
		displayName: "Dynamic Widget",
	},
} as const;

export type WidgetRouteId = keyof typeof WIDGET_REGISTRY;
export type WidgetRouteSegment =
	(typeof WIDGET_REGISTRY)[WidgetRouteId]["segment"];

export const WIDGET_ROUTE_SEGMENTS = Object.fromEntries(
	Object.entries(WIDGET_REGISTRY).map(([key, value]) => [key, value.segment]),
) as { [K in WidgetRouteId]: (typeof WIDGET_REGISTRY)[K]["segment"] };

// =============================================================================
// BASE ENUMS & SIMPLE SCHEMAS
// =============================================================================

const widgetKeys = Object.keys(WIDGET_ROUTE_SEGMENTS) as [
	WidgetRouteId,
	...WidgetRouteId[],
];

export const WidgetKeySchema = z.enum(widgetKeys);
export type WidgetKey = z.infer<typeof WidgetKeySchema>;

export const SnapshotDomainTypeSchema = z.enum([
	"connect",
	"resource",
	"img",
	"script",
	"style",
	"frame",
	"redirect",
]);
export type SnapshotDomainType = z.infer<typeof SnapshotDomainTypeSchema>;

// =============================================================================
// TOOL SCHEMAS
// =============================================================================

export const AppConfigToolSchema = z.object({
	toolId: z.string(),
	title: z.string(),
	description: z.string().nullable().optional(),
	toolTypeId: z.string().min(1),
	inputSchema: ToolInputJsonSchemaSchema.optional(),
	adapterScope: JsonValueSchema.nullable().optional(),
	resultStrategy: JsonValueSchema.nullable().optional(),
	outputTemplate: z.string().nullable().optional(),
	widgetKey: WidgetKeySchema,
	widgetRoute: z.string().nullable().optional(),
	widgetAccessible: z.boolean().optional(),
	visibility: z.enum(["public", "private"]).nullable().optional(),
	annotations: ToolAnnotationsSchema.nullable().optional(),
	invocationStatus: ToolInvocationStatusSchema.nullable().optional(),
	fileParams: z.array(z.string()).nullable().optional(),
	widgetDescription: z.string().nullable().optional(),
	widgetPrefersBorder: z.boolean().nullable().optional(),
	widgetDomain: z.string().nullable().optional(),
	config: JsonValueSchema.nullable().optional(),
	sortOrder: z.number().int().optional(),
	enabled: z.boolean().optional(),
});
export type AppConfigTool = z.infer<typeof AppConfigToolSchema>;

// =============================================================================
// ADAPTER SCHEMA
// =============================================================================

export const AppConfigAdapterSchema = z.object({
	name: z.string(),
	displayName: z.string().nullable().optional(),
	adapterType: z.string(),
	config: JsonValueSchema.nullable().optional(),
	fieldMappings: z.record(z.string(), z.string()).nullable().optional(),
	verticals: z.array(z.string()).nullable().optional(),
	enabled: z.boolean().optional(),
	priority: z.number().int().optional(),
	requiredPlaceholders: z.array(z.string()).optional().nullable(),
});
export type AppConfigAdapter = z.infer<typeof AppConfigAdapterSchema>;

// =============================================================================
// CSP DOMAIN SCHEMAS
// =============================================================================

export const AppToolCspDomainSchema = z.object({
	toolId: z.string(),
	domainType: SnapshotDomainTypeSchema,
	domainUrl: z.string(),
	active: z.boolean().optional(),
});
export type AppToolCspDomain = z.infer<typeof AppToolCspDomainSchema>;

// =============================================================================
// CAPABILITIES SCHEMA (with passthrough for extensibility)
// =============================================================================

/**
 * App capabilities schema
 * Note: Uses .passthrough() to allow additional fields
 */
export const AppCapabilitiesConfigSchema = z
	.object({
		vertical: z.enum(VERTICAL_VALUES).optional(),
		checkout: z
			.object({
				enabled: z.boolean(),
				methods: z
					.array(z.enum(["native", "redirect", "deeplink", "modal"]))
					.optional(),
				nativePayments: z.boolean().optional(),
				minOrderValue: z.number().optional(),
				currency: z.string().optional(),
			})
			.optional(),
		cart: z
			.object({
				enabled: z.boolean(),
				persistCart: z.boolean().optional(),
				maxItems: z.number().optional(),
				expirationHours: z.number().optional(),
			})
			.optional(),
		wishlist: z
			.object({
				enabled: z.boolean(),
				maxItems: z.number().optional(),
			})
			.optional(),
		compare: z
			.object({
				enabled: z.boolean(),
				maxItems: z.number().optional(),
			})
			.optional(),
		map: z
			.object({
				enabled: z.boolean().optional(),
				defaultCenter: z
					.object({
						lat: z.number(),
						lng: z.number(),
					})
					.optional(),
				defaultZoom: z.number().optional(),
			})
			.optional(),
		externalCta: z
			.object({
				enabled: z.boolean(),
				ctaText: z.string().optional(),
				ctaUrl: z.string().optional(),
				openInNewTab: z.boolean().optional(),
				utmParams: z
					.object({
						source: z.string().optional(),
						medium: z.string().optional(),
						campaign: z.string().optional(),
					})
					.optional(),
			})
			.optional(),
	})
	.passthrough();
export type AppCapabilitiesConfig = z.infer<typeof AppCapabilitiesConfigSchema>;

// =============================================================================
// APP SNAPSHOT SCHEMA
// =============================================================================

export const AppSnapshotSchema = z.object({
	schemaVersion: z.number().int(),
	createdAt: z.string(),
	app: z.object({
		name: z.string(),
		slug: z.string(),
		description: z.string().nullable().optional(),
		primaryDomain: z.string().nullable().optional(),
		visibility: z.enum(["public", "private", "disabled"]).optional(),
		logoUrl: z.string().nullable().optional(),
		customMcpDomain: z.string().nullable().optional(),
		openaiChallengeToken: z.string().nullable().optional(),
		openaiAppId: z.string().nullable().optional(),
		appStoreStatus: z.string().nullable().optional(),
		metadata: JsonValueSchema.nullable().optional(),
	}),
	adapters: z.array(AppConfigAdapterSchema),
	tools: z.array(AppConfigToolSchema),
	toolCspDomains: z.array(AppToolCspDomainSchema),
});
export type AppSnapshot = z.infer<typeof AppSnapshotSchema>;

// =============================================================================
// APP TEMPLATE SCHEMAS
// =============================================================================

export const AppTemplateMetaSchema = z.object({
	name: z.string(),
	slug: z.string(),
	version: z.string().optional(),
	vertical: z.enum(VERTICAL_VALUES),
	description: z.string().optional(),
	author: z.string().optional(),
	license: z.string().optional(),
	tags: z.array(z.string()).optional(),
	demoUrl: z.url().optional(),
});
export type AppTemplateMeta = z.infer<typeof AppTemplateMetaSchema>;

export const AppTemplateSchema = z.object({
	$schema: z.string().optional(),
	meta: AppTemplateMetaSchema,
	app: z
		.object({
			name: z.string().optional(),
			slug: z.string().optional(),
			primaryDomain: z.string().optional(),
			description: z.string().optional(),
			visibility: z.enum(["public", "private", "disabled"]).optional(),
		})
		.optional(),
	capabilities: AppCapabilitiesConfigSchema.optional(),
	adapters: z.array(AppConfigAdapterSchema).optional(),
	tools: z.array(AppConfigToolSchema).optional(),
	branding: z
		.object({
			logo: z.string().optional(),
			colors: z
				.object({
					primary: z.string().optional(),
					secondary: z.string().optional(),
					accent: z.string().optional(),
				})
				.optional(),
			fonts: z
				.object({
					heading: z.string().optional(),
					body: z.string().optional(),
				})
				.optional(),
		})
		.optional(),
	widgetConfig: z.record(z.string(), JsonValueSchema).optional(),
	toolCspDomains: z.array(AppToolCspDomainSchema).optional(),
	requiredFields: z.array(z.string()).optional(),
	optionalFields: z.array(z.string()).optional(),
	installation: z
		.object({
			description: z.string().optional(),
			requirements: z.array(z.string()).optional(),
			steps: z.array(z.string()).optional(),
			estimatedTime: z.string().optional(),
			nextSteps: z.array(z.string()).optional(),
		})
		.optional(),
});
export type AppTemplate = z.infer<typeof AppTemplateSchema>;
