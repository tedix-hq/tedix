/**
 * Generated widget artifact schemas.
 *
 * These are durable records for GenUI surfaces created from MCP tool output:
 * json-render layouts, MCP UI resources, QA reports, and chat visuals.
 */

import * as z from "zod";
import { TediArtifactSchema } from "./cognitive-runtime";
import { JsonValueSchema, PaginationSchema } from "./common";

export const GeneratedWidgetArtifactStatusSchema = z.enum([
	"draft",
	"qa_queued",
	"qa_running",
	"qa_passed",
	"qa_failed",
	"publishing",
	"published",
	"archived",
]);
export type GeneratedWidgetArtifactStatus = z.infer<
	typeof GeneratedWidgetArtifactStatusSchema
>;

export const GeneratedWidgetArtifactProgressStatusSchema = z.enum([
	"draft",
	"qa_queued",
	"qa_running",
	"qa_failed",
	"publishing",
	"archived",
]);

export const GeneratedWidgetArtifactKindSchema = z.enum([
	"json_render_layout",
	"mcp_ui_resource",
	"browser_qa_report",
	"chat_visual",
]);
export type GeneratedWidgetArtifactKind = z.infer<
	typeof GeneratedWidgetArtifactKindSchema
>;

export const GeneratedWidgetArtifactSourceSchema = z.enum([
	"tedi_generated",
	"openapi_import",
	"catalog_sync",
	"manual",
]);
export type GeneratedWidgetArtifactSource = z.infer<
	typeof GeneratedWidgetArtifactSourceSchema
>;

export const GeneratedWidgetArtifactSchema = z.object({
	id: z.string(),
	organizationId: z.string(),
	appId: z.string(),
	appSlug: z.string(),
	appToolId: z.string().nullable(),
	toolId: z.string().nullable(),
	toolName: z.string().nullable(),
	kind: GeneratedWidgetArtifactKindSchema,
	source: GeneratedWidgetArtifactSourceSchema,
	status: GeneratedWidgetArtifactStatusSchema,
	title: z.string(),
	description: z.string().nullable(),
	layoutSpec: z.record(z.string(), JsonValueSchema).nullable(),
	inputSnapshot: z.record(z.string(), JsonValueSchema).nullable(),
	outputSnapshot: z.record(z.string(), JsonValueSchema).nullable(),
	resourceUri: z.string().nullable(),
	widgetUrl: z.string().nullable(),
	previewUrl: z.string().nullable(),
	screenshotUrl: z.string().nullable(),
	widgetTestRunId: z.string().nullable(),
	workflowId: z.string().nullable(),
	progressMessage: z.string().nullable(),
	qaSummary: z.record(z.string(), JsonValueSchema).nullable(),
	metadata: z.record(z.string(), JsonValueSchema).nullable(),
	tediArtifact: TediArtifactSchema.optional(),
	createdBy: z.string().nullable(),
	publishedAt: z.string().nullable(),
	createdAt: z.string(),
	updatedAt: z.string(),
});

export type GeneratedWidgetArtifact = z.infer<
	typeof GeneratedWidgetArtifactSchema
>;

const GeneratedWidgetArtifactPayloadSchema = z.object({
	appId: z.string().uuid("App ID must be a valid UUID"),
	appToolId: z.string().uuid().optional(),
	toolId: z.string().min(1).optional(),
	toolName: z.string().min(1).optional(),
	kind: GeneratedWidgetArtifactKindSchema.default("json_render_layout"),
	source: GeneratedWidgetArtifactSourceSchema.default("tedi_generated"),
	title: z.string().min(1).max(160),
	description: z.string().max(1000).optional(),
	layoutSpec: z.record(z.string(), JsonValueSchema).optional(),
	inputSnapshot: z.record(z.string(), JsonValueSchema).optional(),
	outputSnapshot: z.record(z.string(), JsonValueSchema).optional(),
	resourceUri: z.string().min(1).optional(),
	widgetUrl: z.string().url().optional(),
	previewUrl: z.string().url().optional(),
	metadata: z.record(z.string(), JsonValueSchema).optional(),
});

export const CreateGeneratedWidgetArtifactInputSchema =
	GeneratedWidgetArtifactPayloadSchema;

export const CreateGeneratedWidgetArtifactOutputSchema = z.object({
	artifact: GeneratedWidgetArtifactSchema,
});

export const ListGeneratedWidgetArtifactsInputSchema = PaginationSchema.extend({
	appId: z.string().uuid().optional(),
	appSlug: z.string().min(1).optional(),
	status: GeneratedWidgetArtifactStatusSchema.optional(),
	kind: GeneratedWidgetArtifactKindSchema.optional(),
	source: GeneratedWidgetArtifactSourceSchema.optional(),
	toolId: z.string().min(1).optional(),
});

export const ListGeneratedWidgetArtifactsOutputSchema = z.object({
	artifacts: z.array(GeneratedWidgetArtifactSchema),
});

export const GetGeneratedWidgetArtifactInputSchema = z.object({
	id: z.string().min(1),
});

export const GetGeneratedWidgetArtifactOutputSchema = z.object({
	artifact: GeneratedWidgetArtifactSchema,
});

export const RecordGeneratedWidgetArtifactProgressInputSchema = z.object({
	id: z.string().min(1),
	status: GeneratedWidgetArtifactProgressStatusSchema,
	workflowId: z.string().min(1).optional(),
	progressMessage: z.string().max(1000).optional(),
	qaSummary: z.record(z.string(), JsonValueSchema).optional(),
	screenshotUrl: z.string().url().optional(),
	previewUrl: z.string().url().optional(),
	metadata: z.record(z.string(), JsonValueSchema).optional(),
});

export const AttachGeneratedWidgetQaRunInputSchema = z.object({
	id: z.string().min(1),
	widgetTestRunId: z.string().min(1),
	progressMessage: z.string().max(1000).optional(),
});

export const PublishGeneratedWidgetArtifactInputSchema = z.object({
	id: z.string().min(1),
	resourceUri: z.string().min(1).optional(),
	widgetUrl: z.string().url().optional(),
	previewUrl: z.string().url().optional(),
	progressMessage: z.string().max(1000).optional(),
	metadata: z.record(z.string(), JsonValueSchema).optional(),
});

export const GeneratedWidgetArtifactMutationOutputSchema = z.object({
	artifact: GeneratedWidgetArtifactSchema,
});

export type CreateGeneratedWidgetArtifactInput = z.infer<
	typeof CreateGeneratedWidgetArtifactInputSchema
>;
export type ListGeneratedWidgetArtifactsInput = z.infer<
	typeof ListGeneratedWidgetArtifactsInputSchema
>;
export type RecordGeneratedWidgetArtifactProgressInput = z.infer<
	typeof RecordGeneratedWidgetArtifactProgressInputSchema
>;
export type AttachGeneratedWidgetQaRunInput = z.infer<
	typeof AttachGeneratedWidgetQaRunInputSchema
>;
export type PublishGeneratedWidgetArtifactInput = z.infer<
	typeof PublishGeneratedWidgetArtifactInputSchema
>;
