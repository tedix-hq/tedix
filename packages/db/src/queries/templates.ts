/**
 * App Template Query Helpers
 * Database queries for app template management
 *
 * Templates enable rapid app onboarding by providing pre-configured
 * adapters, tools, and capabilities that can be applied to new apps.
 */

import type { AppCapabilities } from "@tedix/api-contract/schemas/app";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	ExtractionConfigExpandedSchema,
	type ExtractionConfigExpanded,
} from "@tedix/api-contract/schemas/extraction-config";
import {
	deriveToolWriteCapability,
	EMPTY_TOOL_INPUT_SCHEMA,
} from "@tedix/api-contract/schemas/tools";
import { asc, eq, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { DbClient } from "../client";
import { appAdapters } from "../schema/adapters";
import { apps } from "../schema/apps";
import { organizations } from "../schema/organizations";
import {
	type AppTemplate,
	appTemplates,
	type NewAppTemplate,
	type TemplateAdapter,
	type TemplateTool,
} from "../schema/templates";
import { appTools, serializeAdapterScope } from "../schema/tools";
import { parseJsonField, toJsonRecord } from "../utils/json";

// ============================================================================
// Read Operations
// ============================================================================

/**
 * Get all active templates
 * Ordered by name for consistent display
 *
 * @param db - Database client
 * @returns Array of active templates
 */
export async function getTemplates(db: DbClient): Promise<AppTemplate[]> {
	return db
		.select()
		.from(appTemplates)
		.where(eq(appTemplates.isActive, true))
		.orderBy(asc(appTemplates.name));
}

/**
 * Get a single template by ID
 *
 * @param db - Database client
 * @param id - Template ID
 * @returns Template or undefined if not found
 */
export async function getTemplateById(
	db: DbClient,
	id: string,
): Promise<AppTemplate | undefined> {
	return db.query.appTemplates.findFirst({ where: { id } });
}

/**
 * Get a template by slug
 *
 * @param db - Database client
 * @param slug - Template slug (e.g., "ecommerce-basic", "crypto-trading")
 * @returns Template or undefined if not found
 */
export async function getTemplateBySlug(
	db: DbClient,
	slug: string,
): Promise<AppTemplate | undefined> {
	return db.query.appTemplates.findFirst({
		where: { slug: slug.toLowerCase() },
	});
}

// ============================================================================
// Write Operations
// ============================================================================

/**
 * Create a new template
 *
 * @param db - Database client
 * @param template - Template data
 * @returns Created template
 */
export async function createTemplate(
	db: DbClient,
	template: Omit<NewAppTemplate, "id" | "createdAt" | "updatedAt">,
): Promise<AppTemplate> {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();

	await db.insert(appTemplates).values({
		...template,
		id,
		slug: template.slug.toLowerCase(),
		createdAt: now,
		updatedAt: now,
	});

	const created = await getTemplateById(db, id);
	if (!created) {
		throw new Error(`Failed to create template: ${id}`);
	}
	return created;
}

/**
 * Update an existing template
 * Performs a partial update - only provided fields are updated
 *
 * @param db - Database client
 * @param id - Template ID
 * @param updates - Partial template data to update
 * @returns Updated template or undefined if not found
 */
export async function updateTemplate(
	db: DbClient,
	id: string,
	updates: Partial<Omit<NewAppTemplate, "id" | "createdAt">>,
): Promise<AppTemplate | undefined> {
	const now = new Date().toISOString();

	// Normalize slug if provided
	const normalizedUpdates = {
		...updates,
		...(updates.slug && { slug: updates.slug.toLowerCase() }),
		updatedAt: now,
	};

	await db
		.update(appTemplates)
		.set(normalizedUpdates)
		.where(eq(appTemplates.id, id));

	return getTemplateById(db, id);
}

/**
 * Soft delete a template (set isActive = false)
 * Templates are not hard-deleted to preserve history
 *
 * @param db - Database client
 * @param id - Template ID
 */
export async function deleteTemplate(db: DbClient, id: string): Promise<void> {
	const now = new Date().toISOString();

	await db
		.update(appTemplates)
		.set({
			isActive: false,
			updatedAt: now,
		})
		.where(eq(appTemplates.id, id));
}

// ============================================================================
// Template Application
// ============================================================================

/**
 * App customization data for template application
 * These are the app-specific fields that replace template placeholders
 */
export interface AppCustomization {
	/** Organization ID that will own the app */
	organizationId: string;
	/** App name */
	name: string;
	/** App slug (used for subdomain routing) */
	slug: string;
	/** Primary domain */
	primaryDomain: string;
	/** App description */
	description?: string;
	/** Logo URL */
	logoUrl?: string;
	/** App visibility */
	visibility?: "public" | "private" | "disabled";
	/** Override or extend template metadata */
	metadataOverrides?: Record<string, JsonValue>;
	/** Override or extend template capabilities */
	capabilitiesOverrides?: Partial<AppCapabilities>;
	/** Override or extend template extractionConfig (replaces placeholders like {siteName}) */
	extractionConfigOverrides?: Partial<ExtractionConfigExpanded>;
	/** Adapter-specific overrides keyed by adapter name */
	adapterOverrides?: Record<string, JsonValue>;
	/** Tool config overrides keyed by tool ID */
	toolConfigOverrides?: Record<string, JsonValue>;
}

/**
 * Result of applying a template to create an app
 */
export interface ApplyTemplateResult {
	app: typeof apps.$inferSelect;
	adapters: Array<typeof appAdapters.$inferSelect>;
	tools: Array<typeof appTools.$inferSelect>;
}

/**
 * Apply a template to create a new app with pre-configured adapters and tools
 *
 * This is the key function for rapid app onboarding:
 * 1. Creates app record from template + customization
 * 2. Creates adapters from template (replacing placeholders like {appId})
 * 3. Creates tools from template
 *
 * @param db - Database client
 * @param templateId - ID of the template to apply
 * @param appData - App-specific customization data
 * @returns Created app, adapters, and tools
 *
 * @example
 * const result = await applyTemplate(db, templateId, {
 *   name: "My Store",
 *   slug: "my-store",
 *   primaryDomain: "mystore.com",
 *   description: "My awesome store",
 *   logoUrl: "https://mystore.com/logo.png",
 * });
 * // result.app = App record
 * // result.adapters = AppAdapter[] (from template)
 * // result.tools = AppTool[] (from template)
 */
export async function applyTemplate(
	db: DbClient,
	templateId: string,
	appData: AppCustomization,
): Promise<ApplyTemplateResult> {
	// 1. Fetch the template
	const template = await getTemplateById(db, templateId);
	if (!template) {
		throw new Error(`Template not found: ${templateId}`);
	}

	if (!template.isActive) {
		throw new Error(`Template is not active: ${templateId}`);
	}

	const now = new Date().toISOString();
	const appId = crypto.randomUUID();

	// 2. Merge template capabilities and extractionConfig with app overrides into app metadata
	const metadataBeforePlaceholders = mergeMetadata(
		template.capabilities,
		template.extractionConfig,
		appData.metadataOverrides,
		appData.capabilitiesOverrides,
		appData.extractionConfigOverrides,
	);

	// 2b. Replace placeholders in metadata (including extractionConfig)
	const metadata = replacePlaceholders(
		metadataBeforePlaceholders,
		appId,
		appData,
	) as Record<string, unknown>;

	// Validate the effective persisted configuration after merging and interpolation.
	// Keep the original object: validation must never sanitize unrelated metadata.
	if (metadata.extractionConfig !== undefined)
		ExtractionConfigExpandedSchema.parse(metadata.extractionConfig);

	// 3. Shape every row before touching the database. Placeholder expansion and
	// the plaintext-secret gate are pure, so a rejected template fails before any
	// write is queued.
	const templateAdapters = (template.adapters ?? []) as TemplateAdapter[];
	const adapterValues = templateAdapters.map((templateAdapter) => {
		// Replace placeholders in config
		const adapterConfig = replacePlaceholders(
			templateAdapter.config,
			appId,
			appData,
		);

		// Apply adapter-specific overrides if provided
		const adapterOverrideValue =
			appData.adapterOverrides?.[templateAdapter.name];
		const adapterOverride = isPlainObject(adapterOverrideValue)
			? adapterOverrideValue
			: undefined;
		const finalConfig = adapterOverride
			? deepMerge(adapterConfig, adapterOverride)
			: adapterConfig;

		return {
			id: crypto.randomUUID(),
			appId,
			name: templateAdapter.name,
			displayName: templateAdapter.name,
			adapterType: templateAdapter.adapterType,
			config: finalConfig == null ? finalConfig : toJsonRecord(finalConfig),
			fieldMappings: templateAdapter.fieldMappings,
			verticals: templateAdapter.verticals as string[] | undefined,
			enabled: templateAdapter.enabled ?? true,
			priority: templateAdapter.priority ?? 0,
			createdAt: now,
			updatedAt: now,
		};
	});

	const templateTools = (template.tools ?? []) as TemplateTool[];
	const toolValues = templateTools.map((templateTool) => {
		// Replace placeholders in tool config
		const toolConfig = replacePlaceholders(templateTool.config, appId, appData);

		// Apply tool config overrides if provided
		const toolConfigOverrideValue =
			appData.toolConfigOverrides?.[templateTool.toolId];
		const toolConfigOverride = isPlainObject(toolConfigOverrideValue)
			? toolConfigOverrideValue
			: undefined;
		const finalConfig = toolConfigOverride
			? deepMerge(toolConfig, toolConfigOverride)
			: toolConfig;

		// Replace placeholders in output template
		const outputTemplate = templateTool.outputTemplate
			? replacePlaceholderString(templateTool.outputTemplate, appId, appData)
			: null;

		const layoutId = (
			templateTool.config as Record<string, unknown> | undefined
		)?.layoutId as string | undefined;
		const widgetRoute = `/r/${layoutId ?? templateTool.toolId}`;

		const adapterScope = serializeAdapterScope(
			templateTool.adapterScope ?? "primary",
		);

		// Enforce: no plaintext secrets in tool configs
		if (finalConfig && typeof finalConfig === "object") {
			const auth = (finalConfig as Record<string, unknown>).auth as
				| Record<string, unknown>
				| undefined;
			if (
				auth?.type === "header" &&
				typeof auth.value === "string" &&
				auth.value.length > 0
			) {
				throw new Error(
					"Plaintext API keys in tool config are not allowed. Use Descope Token Vault (auth.type: 'connection').",
				);
			}
		}

		return {
			id: crypto.randomUUID(),
			appId,
			toolTypeId: templateTool.toolTypeId,
			toolId: templateTool.toolId,
			title: templateTool.title,
			description: templateTool.description,
			inputSchema: templateTool.inputSchema ?? EMPTY_TOOL_INPUT_SCHEMA,
			// Templates declare MCP annotations but the insert used to drop them,
			// so every template-instantiated tool landed unclassified (and, under
			// the old name-inference, silently ungated). Carry both the hints and
			// the derived declaration.
			annotations: templateTool.annotations ?? null,
			writeCapability: deriveToolWriteCapability(templateTool.annotations),
			adapterScope,
			resultStrategy: templateTool.resultStrategy ?? "merge",
			outputTemplate,
			widgetKey: templateTool.widgetKey,
			widgetRoute,
			widgetAccessible: templateTool.widgetAccessible ?? true,
			config: finalConfig == null ? finalConfig : toJsonRecord(finalConfig),
			enabled: templateTool.enabled ?? true,
			sortOrder: templateTool.sortOrder ?? 0,
			createdAt: now,
			updatedAt: now,
		};
	});

	// 4. Submit the whole template as one write set. D1 rejects `BEGIN TRANSACTION`
	// (Cloudflare error 7500), so `db.transaction()` throws against a real database
	// even though it passes under Miniflare's in-memory SQLite. `db.batch()` is
	// D1's atomicity primitive — Cloudflare wraps the batch in an implicit
	// transaction — and it also collapses the old insert-then-select-back-by-id
	// pattern into `.returning()`, taking this from 2 + 2N round trips to one.
	//
	// One statement per row keeps every statement far below D1's ~100 bound-param
	// ceiling, which a bulk multi-row insert of these wide tables would breach.
	const writes = [
		db
			.insert(apps)
			.values({
				id: appId,
				organizationId: appData.organizationId,
				name: appData.name,
				slug: appData.slug.toLowerCase(),
				primaryDomain: appData.primaryDomain.toLowerCase(),
				description: appData.description ?? template.description,
				logoUrl: appData.logoUrl,
				visibility: appData.visibility ?? "private",
				metadata,
				discoveryStatus: "pending",
				appStoreStatus: "draft",
				createdAt: now,
				updatedAt: now,
			})
			.returning(),
		...adapterValues.map((values) =>
			db.insert(appAdapters).values(values).returning(),
		),
		...toolValues.map((values) =>
			db.insert(appTools).values(values).returning(),
		),
		db
			.update(organizations)
			.set({
				appsCount: sql`${organizations.appsCount} + 1`,
				updatedAt: now,
			})
			.where(eq(organizations.id, appData.organizationId)),
	] as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]];

	const results = await db.batch(writes);

	const adapterOffset = 1;
	const toolOffset = adapterOffset + adapterValues.length;

	const app = (results[0] as Array<typeof apps.$inferSelect>)[0];
	if (!app) {
		throw new Error(`Failed to create app from template: ${appId}`);
	}

	const createdAdapters = adapterValues
		.map(
			(_, index) =>
				(
					results[adapterOffset + index] as Array<
						typeof appAdapters.$inferSelect
					>
				)[0],
		)
		.filter((adapter): adapter is typeof appAdapters.$inferSelect =>
			Boolean(adapter),
		);

	const createdTools = toolValues
		.map(
			(_, index) =>
				(results[toolOffset + index] as Array<typeof appTools.$inferSelect>)[0],
		)
		.filter((tool): tool is typeof appTools.$inferSelect => Boolean(tool));

	return {
		app,
		adapters: createdAdapters,
		tools: createdTools,
	};
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Merge template capabilities with app overrides into app metadata
 * The app metadata stores capabilities under the 'capabilities' key
 */
function mergeMetadata(
	templateCapabilities: unknown,
	templateExtractionConfig: unknown,
	metadataOverrides?: Record<string, JsonValue>,
	capabilitiesOverrides?: Partial<AppCapabilities>,
	extractionConfigOverrides?: Partial<ExtractionConfigExpanded>,
): Record<string, unknown> {
	// Start with any metadata overrides
	const merged: Record<string, unknown> = { ...metadataOverrides };

	// Merge capabilities from template with any overrides
	const baseCapabilities =
		typeof templateCapabilities === "object" && templateCapabilities !== null
			? (templateCapabilities as Record<string, unknown>)
			: {};

	merged.capabilities = capabilitiesOverrides
		? deepMerge(
				baseCapabilities,
				capabilitiesOverrides as Record<string, unknown>,
			)
		: baseCapabilities;

	// Merge extractionConfig from template with any overrides
	if (templateExtractionConfig) {
		const baseExtraction =
			typeof templateExtractionConfig === "object" &&
			templateExtractionConfig !== null
				? (templateExtractionConfig as Record<string, unknown>)
				: {};

		merged.extractionConfig = extractionConfigOverrides
			? deepMerge(
					baseExtraction,
					extractionConfigOverrides as Record<string, unknown>,
				)
			: baseExtraction;
	}

	return merged;
}

/**
 * Replace placeholders in a config object
 * Supported placeholders:
 * - {appId} → app UUID
 * - {appSlug} → app slug
 * - {appDomain} → app primary domain
 * - {appName} → app name
 * - {siteName} → extractionConfigOverrides.siteName
 * - {siteContext} → extractionConfigOverrides.siteContext
 * - {siteSearchInstructions} → extractionConfigOverrides.siteSearchInstructions
 */
function replacePlaceholders(
	config: unknown,
	appId: string,
	appData: AppCustomization,
): Record<string, unknown> | null {
	if (!config || typeof config !== "object") {
		return null;
	}

	const configStr = JSON.stringify(config);
	let replaced = configStr
		.replace(/\{appId\}/g, appId)
		.replace(/\{appSlug\}/g, appData.slug)
		.replace(/\{appDomain\}/g, appData.primaryDomain)
		.replace(/\{appName\}/g, appData.name);

	// Replace extraction config placeholders if provided
	if (appData.extractionConfigOverrides) {
		const extractionOverrides = appData.extractionConfigOverrides;
		const siteName =
			typeof extractionOverrides.siteName === "string"
				? extractionOverrides.siteName
				: "";
		const siteContext =
			typeof extractionOverrides.siteContext === "string"
				? extractionOverrides.siteContext
				: "";
		const siteSearchInstructions =
			typeof extractionOverrides.siteSearchInstructions === "string"
				? extractionOverrides.siteSearchInstructions
				: "";

		replaced = replaced
			.replace(/\{siteName\}/g, siteName)
			.replace(/\{siteContext\}/g, siteContext)
			.replace(/\{siteSearchInstructions\}/g, siteSearchInstructions);
	}

	return (
		parseJsonField<Record<string, unknown>>(replaced) ??
		(config as Record<string, unknown>)
	);
}

/**
 * Replace placeholders in a string
 */
function replacePlaceholderString(
	str: string,
	appId: string,
	appData: AppCustomization,
): string {
	let replaced = str
		.replace(/\{appId\}/g, appId)
		.replace(/\{appSlug\}/g, appData.slug)
		.replace(/\{appDomain\}/g, appData.primaryDomain)
		.replace(/\{appName\}/g, appData.name);

	// Replace extraction config placeholders if provided
	if (appData.extractionConfigOverrides) {
		const extractionOverrides = appData.extractionConfigOverrides;
		const siteName =
			typeof extractionOverrides.siteName === "string"
				? extractionOverrides.siteName
				: "";
		const siteContext =
			typeof extractionOverrides.siteContext === "string"
				? extractionOverrides.siteContext
				: "";
		const siteSearchInstructions =
			typeof extractionOverrides.siteSearchInstructions === "string"
				? extractionOverrides.siteSearchInstructions
				: "";

		replaced = replaced
			.replace(/\{siteName\}/g, siteName)
			.replace(/\{siteContext\}/g, siteContext)
			.replace(/\{siteSearchInstructions\}/g, siteSearchInstructions);
	}

	return replaced;
}

/**
 * Deep merge two objects
 */
function deepMerge(
	target: Record<string, unknown> | null,
	source: Record<string, unknown>,
): Record<string, unknown> {
	const output = { ...target };

	for (const key of Object.keys(source)) {
		const sourceValue = source[key];
		const targetValue = output[key];

		if (isPlainObject(sourceValue) && isPlainObject(targetValue)) {
			output[key] = deepMerge(
				targetValue as Record<string, unknown>,
				sourceValue as Record<string, unknown>,
			);
		} else {
			output[key] = sourceValue;
		}
	}

	return output;
}

/**
 * Check if value is a plain object
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}
