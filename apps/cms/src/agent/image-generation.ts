import type { McpServer } from "@tedix/mcp-shared/server";
import * as z from "zod";
import type {
	ImageGenerationStatusSnapshot,
	ImageGenerationWorkflowParams,
} from "./image-generation-workflow";

// MCP SDK 1.29 supports Zod v4 at runtime but TS overload resolution
// can't match v4's ZodObject against the SDK's AnySchema union.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const schema = (s: z.ZodType): any => s;

const AttachTargetInput = z.object({
	collection: z.string().describe("Collection slug, e.g. posts"),
	id: z.string().describe("Content item ID or slug to update"),
	fieldName: z
		.string()
		.optional()
		.describe("Image field to update; defaults to featured_image"),
	locale: z
		.string()
		.optional()
		.describe("Locale for localized content updates"),
	updateSeoOgImage: z
		.boolean()
		.optional()
		.describe("Also write the uploaded media storage key to seo.ogImage"),
});

const ImageGenerationInput = z.object({
	prompt: z
		.string()
		.optional()
		.describe("Direct visual prompt. If omitted, title/description are used."),
	title: z.string().optional().describe("Article or asset title"),
	description: z
		.string()
		.optional()
		.describe("Short article summary, brief, or image context"),
	role: z
		.string()
		.default("featured editorial article image")
		.describe("Generic image role: featured, hero, card, og, inline, etc."),
	aspectRatio: z
		.string()
		.optional()
		.describe("Desired ratio such as 16:9, 4:3, 1:1, 1200x630"),
	width: z.number().int().min(256).max(4096).optional(),
	height: z.number().int().min(256).max(4096).optional(),
	style: z
		.string()
		.optional()
		.describe("Optional visual style override for this image"),
	brandContext: z
		.string()
		.optional()
		.describe("Optional tenant/brand context override for this image"),
	constraints: z
		.array(z.string())
		.optional()
		.describe("Required visual constraints to include in the generated prompt"),
	avoid: z
		.array(z.string())
		.optional()
		.describe("Things to avoid, e.g. text, logos, faces, medical scenes"),
	allowPeople: z
		.boolean()
		.optional()
		.describe(
			"Allow visible people/faces. Defaults to tenant config, otherwise false.",
		),
	locale: z.string().optional().describe("Locale/market context"),
	alt: z.string().optional().describe("Alt text to store on the media item"),
	caption: z.string().optional().describe("Optional media caption"),
	filename: z.string().optional().describe("Optional output filename"),
	model: z
		.string()
		.optional()
		.describe(
			"Optional Gemini image model override; defaults to tenant/platform config",
		),
	seed: z
		.number()
		.int()
		.optional()
		.describe("Optional stable seed hint included in the prompt"),
	attachTo: AttachTargetInput.optional().describe(
		"Optional content update target. When set, the generated local media value is written to data[fieldName].",
	),
});

const ImageGenerationStatusInput = z.object({
	jobId: z.string().describe("Job ID returned by media_generate_image"),
});

const ImageGenerationPhaseEventSchema = z
	.object({
		phase: z.string(),
		status: z.string(),
		message: z.string().optional(),
		timestamp: z.string(),
		details: z.record(z.string(), z.unknown()).optional(),
	})
	.catchall(z.unknown());

const ImageGenerationResultSchema = z
	.object({
		model: z.string(),
		prompt: z.string(),
		mimeType: z.string(),
		filename: z.string(),
		width: z.number().int().optional(),
		height: z.number().int().optional(),
		media: z.record(z.string(), z.unknown()),
		mediaValue: z.record(z.string(), z.unknown()),
		attached: z
			.object({
				collection: z.string(),
				id: z.string(),
				fieldName: z.string(),
				updateSeoOgImage: z.boolean(),
			})
			.optional(),
	})
	.catchall(z.unknown());

const ImageGenerationStatusOutput = z
	.object({
		jobId: z.string(),
		status: z.string(),
		orgSlug: z.string().optional(),
		phase: z.string().optional(),
		message: z.string().optional(),
		updatedAt: z.string().optional(),
		history: z.array(ImageGenerationPhaseEventSchema).optional(),
		details: z.record(z.string(), z.unknown()).optional(),
		result: ImageGenerationResultSchema.optional(),
		error: z.string().optional(),
	})
	.catchall(z.unknown());

export interface ImageGenerationToolContext {
	orgSlug: string;
	startImageGeneration(
		params: ImageGenerationWorkflowParams,
	): Promise<{ jobId: string }>;
	getImageGenerationStatus(
		jobId: string,
	): Promise<
		| ImageGenerationStatusSnapshot
		| { status: string; jobId: string; error?: string }
	>;
}

function isStructuredObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function jsonToolResult(value: unknown, isError?: true) {
	const result = {
		content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
	};
	if (isError) {
		return {
			...result,
			isError,
			...(isStructuredObject(value) ? { structuredContent: value } : {}),
		};
	}
	return {
		...result,
		...(isStructuredObject(value) ? { structuredContent: value } : {}),
	};
}

export function registerImageGenerationTools(
	server: McpServer,
	ctx: ImageGenerationToolContext,
): void {
	server.registerTool(
		"media_generate_image",
		{
			title: "Generate Image",
			description:
				"Generate a tenant-branded image for CMS content, store it in Emdash media, and optionally attach it to a content field. " +
				"The input is generic across tenants: describe intent, role, ratio, style, constraints, and optional content target. " +
				"Returns immediately with a jobId; poll media_generation_status for completion.",
			inputSchema: schema(ImageGenerationInput),
			// Mutating: writes media and may attach it to content.
			annotations: { readOnlyHint: false, destructiveHint: false },
		},
		async (rawArgs: any) => {
			const args = ImageGenerationInput.parse(rawArgs);
			if (!args.prompt && !args.title && !args.description) {
				return jsonToolResult(
					{
						ok: false,
						error: "At least one of prompt, title, or description is required.",
					},
					true,
				);
			}

			const { jobId } = await ctx.startImageGeneration({
				orgSlug: ctx.orgSlug,
				...args,
			});
			return jsonToolResult({
				status: "queued",
				jobId,
				orgSlug: ctx.orgSlug,
				hint: "Call media_generation_status with this jobId to check progress.",
			});
		},
	);

	server.registerTool(
		"media_generation_status",
		{
			title: "Get Image Generation Status",
			description:
				"Check a media_generate_image job. On complete, returns generated media, a ready-to-use MediaValue, and attachment details when requested.",
			inputSchema: schema(ImageGenerationStatusInput),
			outputSchema: schema(ImageGenerationStatusOutput),
			annotations: { readOnlyHint: true },
		},
		async (rawArgs: any) => {
			const args = ImageGenerationStatusInput.parse(rawArgs);
			const status = await ctx.getImageGenerationStatus(args.jobId);
			return jsonToolResult(
				status,
				status.status === "failed" || status.status === "errored"
					? true
					: undefined,
			);
		},
	);
}
