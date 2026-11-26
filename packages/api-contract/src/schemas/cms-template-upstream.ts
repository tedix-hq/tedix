import { z } from "zod";

export const CmsTemplateUpstreamStarterSchema = z.object({
	slug: z.string(),
	folder: z.string(),
	recordedCommit: z.string(),
	behind: z.boolean(),
	recordedTree: z.string().nullable(),
	upstreamTree: z.string().nullable(),
});

export const CmsTemplateUpstreamFiledSchema = z.object({
	kind: z.enum(["behind", "missing"]),
	key: z.string(),
	workItemId: z.uuid(),
	reused: z.boolean(),
});

export const CmsTemplateUpstreamReportSchema = z.object({
	checkedAt: z.string(),
	upstreamRevision: z.string(),
	projects: z.array(
		z.object({
			projectId: z.uuid(),
			starters: z.array(CmsTemplateUpstreamStarterSchema),
			missing: z.array(z.string()),
			filed: z.array(CmsTemplateUpstreamFiledSchema),
		}),
	),
});
export type CmsTemplateUpstreamReport = z.infer<
	typeof CmsTemplateUpstreamReportSchema
>;
