import * as z from "zod";
import { JsonValueSchema } from "./common";

export const CmsEditorDraftSchema = z
	.strictObject({
		collection: z.string().min(1).max(80),
		entryId: z.string().min(1).max(128),
		locale: z.string().min(1).max(64).nullable(),
		baseRevision: z.string().min(1).max(256),
		invocationId: z.string().min(16).max(128),
		fields: z.record(z.string().min(1).max(80), JsonValueSchema),
	})
	.superRefine((value, ctx) => {
		if (
			Object.keys(value.fields).length > 32 ||
			new TextEncoder().encode(JSON.stringify(value)).byteLength > 48 * 1024
		)
			ctx.addIssue({
				code: "custom",
				message: "Editor draft exceeds the proposal limit",
			});
	});
export const CmsEditorProposalInputSchema = z
	.strictObject({
		siteId: z.uuid(),
		action: z.enum(["rewrite", "translate", "seo"]),
		draft: CmsEditorDraftSchema,
		targetLocale: z
			.string()
			.min(1)
			.max(64)
			.regex(/^[A-Za-z][A-Za-z0-9_-]*$/)
			.optional(),
	})
	.superRefine((input, ctx) => {
		if (input.action === "translate" && !input.targetLocale)
			ctx.addIssue({
				code: "custom",
				message: "Translation needs a target locale",
			});
	});
export const CmsEditorSeoSuggestionSchema = z.strictObject({
	title: z.string().max(160),
	description: z.string().max(320),
});
export const CmsEditorProposalOutputSchema = z.strictObject({
	invocationId: z.string(),
	entryId: z.string(),
	locale: z.string().nullable(),
	baseRevision: z.string(),
	values: z.record(z.string(), JsonValueSchema),
	seo: CmsEditorSeoSuggestionSchema.optional(),
});
export type CmsEditorProposalInput = z.infer<
	typeof CmsEditorProposalInputSchema
>;
export type CmsEditorProposalOutput = z.infer<
	typeof CmsEditorProposalOutputSchema
>;
