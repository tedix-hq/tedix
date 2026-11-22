import * as z from "zod";

export const SiteVersionCheckConfigSchema = z.object({
	enabled: z.literal(true),
	/** Existing upgrade Work, keyed by package, takes precedence over filing. */
	upgradeWorkItems: z.record(z.string(), z.uuid()).optional(),
});
export const SiteVersionAlertSchema = z.object({
	message: z.string(),
	workItemId: z.uuid(),
});
export const SiteVersionReportSchema = z.object({
	checkedAt: z.string(),
	productRevision: z.string(),
	sites: z.array(
		z.object({
			siteId: z.string(),
			slug: z.string(),
			themeRevision: z.string().optional(),
			packages: z.array(
				z.object({
					package: z.string(),
					source: z.enum(["runtime", "theme", "docs image"]),
					installed: z.string(),
					latest: z.string().nullable(),
					behind: z.boolean().nullable(),
				}),
			),
			errors: z.array(z.string()),
		}),
	),
	alerts: z.array(SiteVersionAlertSchema),
});
export type SiteVersionReport = z.infer<typeof SiteVersionReportSchema>;
