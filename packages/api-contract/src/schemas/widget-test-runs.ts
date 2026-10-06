/**
 * Widget Test Run Schemas
 * Zod schemas for widget test run API endpoints
 */

import * as z from "zod";
import { JsonValueSchema } from "./common";

export const WidgetVisualDiffBaselineSchema = z.object({
	source: z.enum(["published_artifact", "qa_passed_artifact", "passed_run"]),
	runId: z.string(),
	artifactId: z.string().nullable(),
	artifactStatus: z.string().nullable(),
	screenshotUrl: z.string(),
	createdAt: z.string().nullable(),
	publishedAt: z.string().nullable(),
});

export const WidgetVisualDiffImageDimensionsSchema = z.object({
	width: z.number(),
	height: z.number(),
});

export const WidgetVisualDiffSchema = z.object({
	status: z.enum(["compared", "skipped", "failed"]),
	baseline: WidgetVisualDiffBaselineSchema.nullable(),
	currentScreenshotUrl: z.string().nullable(),
	dimensions: z
		.object({
			baseline: WidgetVisualDiffImageDimensionsSchema,
			current: WidgetVisualDiffImageDimensionsSchema,
		})
		.nullable(),
	pixelsCompared: z.number().nullable(),
	differentPixels: z.number().nullable(),
	diffRatio: z.number().nullable(),
	averageDelta: z.number().nullable(),
	threshold: z.object({
		pixelDelta: z.number(),
		diffRatio: z.number(),
	}),
	passed: z.boolean().nullable(),
	reason: z.string().nullable(),
});

export type WidgetVisualDiffOutput = z.infer<typeof WidgetVisualDiffSchema>;

export const WidgetBrowserQaConsoleMessageSchema = z.object({
	type: z.string(),
	text: z.string(),
	location: z.record(z.string(), JsonValueSchema).optional(),
});

export const WidgetBrowserQaNetworkEventSchema = z.object({
	url: z.string(),
	method: z.string().optional(),
	resourceType: z.string().optional(),
	status: z.number().optional(),
	statusText: z.string().optional(),
	errorText: z.string().optional(),
});

export const WidgetBrowserQaEvidenceSchema = z.object({
	capturedAt: z.string(),
	screenshot: z.object({
		url: z.string(),
		mimeType: z.string(),
		label: z.string(),
	}),
	console: z.object({
		captured: z.boolean(),
		errorCount: z.number(),
		errors: z.array(WidgetBrowserQaConsoleMessageSchema),
		messages: z.array(WidgetBrowserQaConsoleMessageSchema),
	}),
	network: z.object({
		captured: z.boolean(),
		errorCount: z.number(),
		failureCount: z.number(),
		responseErrorCount: z.number(),
		failures: z.array(WidgetBrowserQaNetworkEventSchema),
		responseErrors: z.array(WidgetBrowserQaNetworkEventSchema),
	}),
	layout: z.object({
		viewport: z.object({
			width: z.number(),
			height: z.number(),
		}),
		document: z.object({
			width: z.number(),
			height: z.number(),
		}),
		widget: z
			.object({
				width: z.number(),
				height: z.number(),
				x: z.number(),
				y: z.number(),
			})
			.nullable(),
	}),
});

export type WidgetBrowserQaEvidence = z.infer<
	typeof WidgetBrowserQaEvidenceSchema
>;

export const WidgetTestRunSchema = z.object({
	id: z.string(),
	appId: z.string().nullable(),
	appSlug: z.string(),
	organizationId: z.string().nullable(),
	toolName: z.string(),
	toolArgs: JsonValueSchema.nullable(),
	mode: z.string(),
	passed: z.boolean(),
	stepCount: z.number().nullable(),
	stepsPassedCount: z.number().nullable(),
	stepResults: JsonValueSchema.nullable(),
	screenshots: JsonValueSchema.nullable(),
	toolResult: JsonValueSchema.nullable(),
	domSummary: JsonValueSchema.nullable(),
	widgetAnalysis: JsonValueSchema.nullable(),
	visualDiff: WidgetVisualDiffSchema.nullable(),
	previewUrl: z.string().nullable(),
	durationMs: z.number().nullable(),
	error: z.string().nullable(),
	createdAt: z.string(),
});

export type WidgetTestRunOutput = z.infer<typeof WidgetTestRunSchema>;

export const WidgetTestRunListInputSchema = z.object({
	appSlug: z.string().optional().describe("Filter by app slug"),
	limit: z.number().min(1).max(100).default(50),
});

export const WidgetTestRunListOutputSchema = z.object({
	runs: z.array(WidgetTestRunSchema),
});

export const WidgetTestRunGetInputSchema = z.object({
	id: z.string().describe("Widget test run ID"),
});
