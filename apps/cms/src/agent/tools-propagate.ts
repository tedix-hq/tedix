import type { McpServer } from "@tedix/mcp-shared/server";
import * as z from "zod";
import { TEMPLATE_SNAPSHOTS } from "../template-snapshot";
import {
	type CmsTemplateSlug,
	normalizeCmsTemplateSlug,
} from "../template-policy";
import { listCmsFleetBundles } from "./storage";
import { resyncTemplate } from "./template-sync";
import {
	schema,
	forbidden,
	requirePlatformAdminForOrg,
	type SiteBuilderToolContext,
} from "./tools-shared";

export function registerPropagateTools(
	server: McpServer,
	ctx: SiteBuilderToolContext,
): void {
	server.registerTool(
		"template_propagate",
		{
			title: "Propagate Template Files to All Orgs",
			description:
				"Write one or more template files from the bundled snapshot to every active org sandbox " +
				"(or a specified subset), then optionally trigger a deploy for each. " +
				"Use this after pushing template changes to git and redeploying the Site Builder Worker " +
				"(which refreshes the snapshot). " +
				"Only files present in the template snapshot can be propagated. " +
				"Pass deploy:true to queue an Astro build for each org after writing.",
			inputSchema: schema(
				z.object({
					files: z
						.array(z.string())
						.describe(
							"File paths to propagate (relative to theme root, e.g. 'src/styles/globals.css'). " +
								"Must exist in the template snapshot.",
						),
					deploy: z
						.boolean()
						.optional()
						.describe(
							"Queue a deploy for each org after writing files (default: false)",
						),
					orgs: z
						.array(z.string())
						.optional()
						.describe(
							"Org slugs to target. Omit to target all active orgs in tenant_bundles.",
						),
				}),
			),
			annotations: { destructiveHint: true },
		},
		async (args: { files: string[]; deploy?: boolean; orgs?: string[] }) => {
			// Validate against the union up front; each target is still resynced
			// from its own template snapshot below.
			const snapshotPaths = new Set(
				Object.values(TEMPLATE_SNAPSHOTS).flatMap((snapshot) =>
					Object.keys(snapshot),
				),
			);
			const validFiles = args.files.filter((file) => snapshotPaths.has(file));
			const unknownFiles = args.files.filter(
				(file) => !snapshotPaths.has(file),
			);

			if (validFiles.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(
								{
									error:
										"No valid files to propagate. All specified paths are absent from the template snapshot.",
									unknownFiles,
								},
								null,
								2,
							),
						},
					],
					isError: true,
				};
			}

			// Resolve target orgs
			const fleetRows = await listCmsFleetBundles(ctx.db);
			const fleetBySlug = new Map(fleetRows.map((row) => [row.slug, row]));
			let targetSlugs: string[];
			if (args.orgs && args.orgs.length > 0) {
				targetSlugs = [...new Set(args.orgs)];
			} else {
				if (!ctx.isPlatformAdmin) {
					return forbidden(
						"Platform admin authority required to propagate the template to all orgs",
					);
				}
				targetSlugs = fleetRows.map((row) => row.slug);
			}

			const crossOrgSlug = targetSlugs.find((slug) => slug !== ctx.orgSlug);
			if (crossOrgSlug) {
				const guard = requirePlatformAdminForOrg(
					ctx,
					crossOrgSlug,
					"propagate template files to",
				);
				if (guard) return guard;
			}

			if (targetSlugs.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(
								{ error: "No active orgs found in tenant_bundles." },
								null,
								2,
							),
						},
					],
					isError: true,
				};
			}

			// Process orgs in batches of 5 to avoid overwhelming sandbox DOs
			const BATCH = 5;
			const results: Array<{
				slug: string;
				status: "ok" | "error";
				templateSlug?: CmsTemplateSlug;
				filesWritten?: number;
				copied?: string[];
				skipped?: string[];
				jobId?: string;
				error?: string;
			}> = [];

			for (let i = 0; i < targetSlugs.length; i += BATCH) {
				const batch = targetSlugs.slice(i, i + BATCH);
				const batchResults = await Promise.all(
					batch.map(async (slug) => {
						try {
							const fleetRow = fleetBySlug.get(slug);
							if (!fleetRow) {
								throw new Error(`No active CMS bundle found for org "${slug}"`);
							}
							const templateSlug = normalizeCmsTemplateSlug(
								fleetRow.templateSlug,
							);
							const sandbox = ctx.getSandboxForOrg(slug);
							const sync = await resyncTemplate(sandbox, {
								scope: "files",
								paths: validFiles,
								templateSlug,
							});
							let jobId: string | undefined;
							if (args.deploy && sync.copied.length > 0) {
								const d = await ctx.startDeploy(
									slug,
									`Template propagation (${templateSlug}): ${sync.copied.join(", ")}`,
								);
								jobId = d.jobId;
							}
							return {
								slug,
								status: "ok" as const,
								templateSlug,
								filesWritten: sync.copied.length,
								copied: sync.copied,
								skipped: sync.skipped,
								jobId,
							};
						} catch (err) {
							return { slug, status: "error" as const, error: String(err) };
						}
					}),
				);
				results.push(...batchResults);
			}

			const ok = results.filter((r) => r.status === "ok");
			const failed = results.filter((r) => r.status === "error");

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(
							{
								summary: `Processed ${validFiles.length} requested file(s) for ${ok.length}/${targetSlugs.length} orgs${args.deploy ? "; deploys queued only where files were copied" : ""}`,
								filesWritten: validFiles,
								unknownFiles:
									unknownFiles.length > 0 ? unknownFiles : undefined,
								orgsOk: ok.length,
								orgsFailed: failed.length,
								results,
							},
							null,
							2,
						),
					},
				],
				isError: failed.length > 0 && ok.length === 0 ? true : undefined,
			};
		},
	);
}
