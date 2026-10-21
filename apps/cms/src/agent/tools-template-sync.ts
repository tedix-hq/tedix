import type { McpServer } from "@tedix/mcp-shared/server";
import * as z from "zod";
import { normalizeCmsTemplateSlug } from "../template-policy";
import { listCmsFleetBundles } from "./storage";
import { diffTemplate, resyncTemplate } from "./template-sync";
import {
	schema,
	withSandboxTimeout,
	requirePlatformAdminForOrg,
	type SiteBuilderToolContext,
} from "./tools-shared";

export function registerTemplateSyncTools(
	server: McpServer,
	ctx: SiteBuilderToolContext,
): void {
	server.registerTool(
		"theme_resync_template",
		{
			title: "Resync Theme Template",
			description:
				"Copy the in-repo canonical starter template back into the Site Builder sandbox. " +
				"Use this when the Site Builder Worker bundle is newer than the seeded sandbox " +
				"(e.g. after a locked-file fix or new SEO route). " +
				"Default scope 'locked' overwrites only LOCKED files — the legitimate way " +
				"to update CMS infrastructure without touching vibe-coded theme work. " +
				"scope='all' overwrites ALL snapshot files (locked + editable scaffolds) and " +
				"requires confirm:true. It removes absent files only if they still match a known starter; custom files are preserved. scope='files' targets a specific list of paths.",
			inputSchema: schema(
				z.object({
					scope: z
						.enum(["locked", "all", "files"])
						.optional()
						.describe(
							"Default 'locked'. 'all' wipes editable files too — destructive. 'files' = per-path.",
						),
					paths: z
						.array(z.string())
						.optional()
						.describe(
							"Required when scope='files'. Paths must exist in the bundled template snapshot.",
						),
					confirm: z
						.boolean()
						.optional()
						.describe(
							"Required when scope='all'. Acknowledges editable file overwrite.",
						),
				}),
			),
			annotations: { destructiveHint: true },
		},
		async (args: any) => {
			try {
				const result = await resyncTemplate(ctx.sandbox, {
					scope: args.scope,
					paths: args.paths,
					confirm: args.confirm,
					templateSlug: ctx.templateSlug,
				});
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(
								{ ...result, sandboxId: ctx.orgSlug },
								null,
								2,
							),
						},
					],
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: `[ERROR] ${msg}` }],
					isError: true as const,
				};
			}
		},
	);

	server.registerTool(
		"theme_diff_template",
		{
			title: "Diff Sandbox vs Template",
			description:
				"Compare files in the Site Builder sandbox against the in-repo canonical starter. " +
				"Returns paths whose SHA-256 hashes differ. Default scope 'locked' only — " +
				"editable files drift by design (vibe-coded). Use scope='all' to see every " +
				"snapshot path (noisier, but useful for full audits). " +
				"clean=true means no drift in the requested scope. " +
				"Pre-deploy preflight calls this with scope='locked' and refuses to deploy if drift is found.",
			inputSchema: schema(
				z.object({
					scope: z
						.enum(["locked", "all"])
						.optional()
						.describe(
							"Default 'locked'. 'all' includes editable scaffolds too.",
						),
				}),
			),
			outputSchema: schema(
				z
					.object({
						drifted: z.array(
							z.object({
								path: z.string(),
								locked: z.boolean(),
								sandboxHash: z.string(),
								repoHash: z.string(),
							}),
						),
						clean: z.boolean(),
						scope: z.enum(["locked", "all"]),
						checked: z.number().int(),
					})
					.passthrough(),
			),
			annotations: { readOnlyHint: true },
		},
		async (args: any) => {
			const result = await withSandboxTimeout(
				ctx,
				`theme_diff_template ${args.scope ?? "locked"}`,
				diffTemplate(ctx.sandbox, args.scope ?? "locked", ctx.templateSlug),
			);
			const output = { ...result };
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(output, null, 2) },
				],
				structuredContent: output,
			};
		},
	);

	server.registerTool(
		"theme_fleet_status",
		{
			title: "Inspect CMS Fleet Status",
			description:
				"Report active bundle versions, stale-version drift, routing metadata, and optional " +
				"locked-template drift for the CMS tenant fleet. Platform admins can omit orgs to scan " +
				"all active tenants; non-admin callers scan only their current org unless orgs contains only that org.",
			inputSchema: schema(
				z.object({
					orgs: z
						.array(z.string())
						.optional()
						.describe(
							"Org slugs to inspect. Omit for all active orgs when platform admin, otherwise current org only.",
						),
					scope: z
						.enum(["locked", "all"])
						.optional()
						.describe("Template diff scope. Default 'locked'."),
					includeTemplateDiff: z
						.boolean()
						.optional()
						.describe(
							"Whether to diff each sandbox against its selected template snapshot. Default true.",
						),
				}),
			),
			outputSchema: schema(
				z
					.object({
						generatedAt: z.string(),
						scope: z.enum(["locked", "all"]),
						includeTemplateDiff: z.boolean(),
						summary: z.object({
							targetCount: z.number().int(),
							reportedCount: z.number().int(),
							missingOrInactive: z.array(z.string()),
							staleActiveCount: z.number().int(),
							templateDriftCount: z.number().int(),
							errorCount: z.number().int(),
						}),
						tenants: z.array(
							z.object({
								slug: z.string(),
								activeVersion: z.number().int().nullable(),
								latestVersion: z.number().int().nullable(),
								staleActive: z.boolean(),
								deployedAt: z.string().nullable(),
								promptSummary: z.string().nullable(),
								routing: z.object({
									defaultLocale: z.string().nullable(),
									cmsDomain: z.string().nullable(),
									publicSiteUrl: z.string().nullable(),
								}),
								template: z
									.object({
										scope: z.enum(["locked", "all"]),
										clean: z.boolean(),
										checked: z.number().int(),
										driftedCount: z.number().int(),
										drifted: z.array(
											z.object({
												path: z.string(),
												locked: z.boolean(),
											}),
										),
									})
									.optional(),
								error: z.string().optional(),
							}),
						),
					})
					.passthrough(),
			),
			annotations: { readOnlyHint: true },
		},
		async (args: {
			orgs?: string[];
			scope?: "locked" | "all";
			includeTemplateDiff?: boolean;
		}) => {
			const scope = args.scope ?? "locked";
			const includeTemplateDiff = args.includeTemplateDiff !== false;
			const allRows = await listCmsFleetBundles(ctx.db);
			const targetSlugs =
				args.orgs && args.orgs.length > 0
					? Array.from(new Set(args.orgs))
					: ctx.isPlatformAdmin
						? allRows.map((row) => row.slug)
						: [ctx.orgSlug];

			const crossOrgSlug = targetSlugs.find((slug) => slug !== ctx.orgSlug);
			if (crossOrgSlug) {
				const guard = requirePlatformAdminForOrg(
					ctx,
					crossOrgSlug,
					"inspect CMS fleet status for",
				);
				if (guard) return guard;
			}

			const rowBySlug = new Map(allRows.map((row) => [row.slug, row]));
			const missingOrInactive = targetSlugs.filter(
				(slug) => !rowBySlug.has(slug),
			);
			const tenants: Array<{
				slug: string;
				activeVersion: number | null;
				latestVersion: number | null;
				staleActive: boolean;
				deployedAt: string | null;
				promptSummary: string | null;
				routing: {
					defaultLocale: string | null;
					cmsDomain: string | null;
					publicSiteUrl: string | null;
				};
				template?: {
					scope: "locked" | "all";
					clean: boolean;
					checked: number;
					driftedCount: number;
					drifted: Array<{ path: string; locked: boolean }>;
				};
				error?: string;
			}> = [];

			for (const slug of targetSlugs) {
				const row = rowBySlug.get(slug);
				if (!row) continue;

				const tenant = {
					slug,
					activeVersion: row.activeVersion,
					latestVersion: row.latestVersion,
					staleActive:
						row.activeVersion !== null &&
						row.latestVersion !== null &&
						row.activeVersion < row.latestVersion,
					deployedAt: row.deployedAt,
					promptSummary: row.promptSummary,
					routing: {
						defaultLocale: row.defaultLocale,
						cmsDomain: row.cmsDomain,
						publicSiteUrl: row.publicSiteUrl,
					},
				} as (typeof tenants)[number];

				if (includeTemplateDiff) {
					try {
						const diff = await withSandboxTimeout(
							{ orgSlug: slug },
							`theme_fleet_status diffTemplate ${scope}`,
							diffTemplate(
								ctx.getSandboxForOrg(slug),
								scope,
								normalizeCmsTemplateSlug(row.templateSlug),
							),
						);
						tenant.template = {
							scope,
							clean: diff.clean,
							checked: diff.checked,
							driftedCount: diff.drifted.length,
							drifted: diff.drifted.slice(0, 25).map((entry) => ({
								path: entry.path,
								locked: entry.locked,
							})),
						};
					} catch (err) {
						tenant.error = err instanceof Error ? err.message : String(err);
					}
				}

				tenants.push(tenant);
			}

			const staleActiveCount = tenants.filter(
				(tenant) => tenant.staleActive,
			).length;
			const templateDriftCount = tenants.filter(
				(tenant) => tenant.template && !tenant.template.clean,
			).length;
			const errorCount = tenants.filter((tenant) => tenant.error).length;
			const output = {
				generatedAt: new Date().toISOString(),
				scope,
				includeTemplateDiff,
				summary: {
					targetCount: targetSlugs.length,
					reportedCount: tenants.length,
					missingOrInactive,
					staleActiveCount,
					templateDriftCount,
					errorCount,
				},
				tenants,
			};

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(output, null, 2),
					},
				],
				structuredContent: output,
				isError:
					errorCount > 0 && tenants.length === errorCount ? true : undefined,
			};
		},
	);
}
