/**
 * Plugin Zod Schemas
 * Validation schemas for plugin API contracts
 */

import * as z from "zod";
import { JsonValueSchema } from "./common";

// =============================================================================
// ENUMS
// =============================================================================

export const PluginTypeSchema = z.enum([
	"mcp_server",
	"tool",
	"channel",
	"workflow",
]);

export const PluginStatusSchema = z.enum(["draft", "published", "suspended"]);

export const PluginInstallStatusSchema = z.enum([
	"installed",
	"active",
	"disabled",
	"error",
]);

export const PluginEventStatusSchema = z.enum([
	"pending",
	"processing",
	"completed",
	"failed",
]);

// =============================================================================
// CORE SCHEMAS
// =============================================================================

export const PluginSchema = z.object({
	id: z.string(),
	slug: z.string(),
	name: z.string(),
	description: z.string().nullable(),
	type: PluginTypeSchema,
	version: z.string(),
	manifest: z.record(z.string(), JsonValueSchema).nullable(),
	status: PluginStatusSchema.nullable(),
	authorOrgId: z.string().nullable(),
	createdAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
});

export const PluginInstallSchema = z.object({
	id: z.string(),
	orgId: z.string(),
	pluginId: z.string(),
	tediId: z.string().nullable(),
	config: z.record(z.string(), JsonValueSchema).nullable(),
	permissionsGranted: z.array(z.string()).nullable(),
	status: PluginInstallStatusSchema.nullable(),
	installedAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
});

export const PluginEventSchema = z.object({
	id: z.string(),
	pluginId: z.string(),
	tediId: z.string().nullable(),
	eventType: z.string(),
	payload: z.record(z.string(), JsonValueSchema).nullable(),
	status: PluginEventStatusSchema.nullable(),
	createdAt: z.string().nullable(),
	processedAt: z.string().nullable(),
});

// =============================================================================
// INPUT SCHEMAS
// =============================================================================

export const PluginIdParamSchema = z.object({
	pluginId: z.string().min(1, "Plugin ID is required"),
});

export const InstallPluginInputSchema = z.object({
	pluginId: z.string().min(1),
	tediId: z.string().optional(),
	config: z.record(z.string(), JsonValueSchema).optional(),
	permissionsGranted: z.array(z.string()).optional(),
});

export const ConfigurePluginInputSchema = z.object({
	installId: z.string().min(1),
	config: z.record(z.string(), JsonValueSchema).optional(),
	permissionsGranted: z.array(z.string()).optional(),
});

export const ActivatePluginInputSchema = z.object({
	installId: z.string().min(1),
	tediId: z.string().min(1),
});

export const DeactivatePluginInputSchema = z.object({
	installId: z.string().min(1),
	tediId: z.string().min(1),
});

export const EmitPluginEventInputSchema = z.object({
	pluginId: z.string().min(1),
	tediId: z.string().optional(),
	eventType: z.string().min(1),
	payload: z.record(z.string(), JsonValueSchema).optional(),
});

export const ListPluginEventsInputSchema = z.object({
	pluginId: z.string().optional(),
	tediId: z.string().optional(),
	eventType: z.string().optional(),
	status: PluginEventStatusSchema.optional(),
	limit: z.number().min(1).max(100).optional(),
	offset: z.number().min(0).optional(),
});

export const ListPluginsInputSchema = z.object({
	type: PluginTypeSchema.optional(),
	status: PluginStatusSchema.optional(),
	query: z.string().optional(),
	limit: z.number().min(1).max(100).optional(),
	offset: z.number().min(0).optional(),
});
