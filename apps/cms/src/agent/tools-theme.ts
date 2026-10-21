import type { McpServer } from "@tedix/mcp-shared/server";
import * as z from "zod";
import { isPathEditable, isPathLocked } from "./constraints";
import { EDITABLE_DIRS } from "../template-policy";
import {
	inspectCmsHumanAuthActivation,
	setCmsHumanAuthActivation,
} from "./storage";
import { inspectWorkspaceSourceStatus } from "./workspace-source-status";
import {
	schema,
	WORKSPACE,
	withSandboxTimeout,
	forbidden,
	requirePlatformAdminForOrg,
	type SiteBuilderToolContext,
} from "./tools-shared";

export function registerThemeTools(
	server: McpServer,
	ctx: SiteBuilderToolContext,
): void {
	const humanAuthActivationOutput = z.object({
		status: z.enum(["ready", "unavailable"]),
		siteId: z.string().nullable(),
		tenantId: z.string().nullable(),
		activeVersion: z.number().int().nullable(),
		activeBundleEtag: z.string().nullable(),
		humanAssertionBundleEtag: z.string().nullable(),
		compatible: z.boolean(),
		reason: z.string().nullable(),
	});
	server.registerTool(
		"get_human_auth_activation",
		{
			title: "Inspect CMS Human Auth Activation",
			description:
				"Read the exact active site, editorial tenant, bundle version and etag, current human assertion marker, and compiled bundle compatibility. Platform admin only; this does not change tenant access.",
			inputSchema: schema(z.object({})),
			outputSchema: schema(humanAuthActivationOutput),
			annotations: { readOnlyHint: true },
		},
		async () => {
			if (!ctx.isPlatformAdmin)
				return forbidden(
					"Platform admin authority required to inspect CMS human auth activation",
				);
			const output = await inspectCmsHumanAuthActivation(
				ctx.db,
				ctx.bundlesBucket,
				ctx.orgSlug,
			);
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(output, null, 2) },
				],
				structuredContent: output,
			};
		},
	);

	server.registerTool(
		"set_human_auth_activation",
		{
			title: "Set Exact-Bundle CMS Human Auth Activation",
			description:
				"Enable or revoke human OAuth assertions for this CMS tenant only when site, editorial tenant, active version, etag, and current marker match the inspected values. Enabling also verifies the immutable compiled bundle's assertion handler. Platform admin only.",
			inputSchema: schema(
				z.object({
					expectedSiteId: z.string().uuid(),
					expectedTenantId: z.string().min(1),
					expectedVersion: z.number().int().positive(),
					expectedBundleEtag: z.string().regex(/^[a-f0-9]{64}$/),
					expectedCurrentMarker: z
						.string()
						.regex(/^[a-f0-9]{64}$/)
						.nullable(),
					enabled: z.boolean(),
				}),
			),
			outputSchema: schema(humanAuthActivationOutput),
			annotations: { destructiveHint: true, readOnlyHint: false },
		},
		async (
			args: Omit<Parameters<typeof setCmsHumanAuthActivation>[2], "slug">,
		) => {
			if (!ctx.isPlatformAdmin)
				return forbidden(
					"Platform admin authority required to change CMS human auth activation",
				);
			try {
				const output = await setCmsHumanAuthActivation(
					ctx.db,
					ctx.bundlesBucket,
					{ slug: ctx.orgSlug, ...args },
				);
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(output, null, 2) },
					],
					structuredContent: output,
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text" as const,
							text: `[CONFLICT] ${error instanceof Error ? error.message : "CMS human auth activation failed"}`,
						},
					],
					isError: true,
				};
			}
		},
	);

	server.registerTool(
		"theme_workspace_status",
		{
			title: "Compare Builder Workspace With Active Theme Source",
			description:
				"Before editing a committed CMS theme, compare the builder's editable files with the active Artifacts commit. " +
				"A difference may be intentional draft work or a reset/stale sandbox; review and preserve changes before replacing the workspace. " +
				"This check does not alter the builder workspace.",
			inputSchema: schema(z.object({})),
			outputSchema: schema(
				z.object({
					status: z.enum([
						"matches_active_source",
						"differs_from_active_source",
						"no_artifacts_source",
						"unavailable",
					]),
					activeVersion: z.number().int().nullable(),
					activeSourceCommit: z.string().nullable(),
					activeSourceDigest: z.string().optional(),
					workspaceSource: z
						.object({ digest: z.string(), fileCount: z.number().int() })
						.optional(),
					activeSource: z
						.object({ digest: z.string(), fileCount: z.number().int() })
						.optional(),
					message: z.string(),
				}),
			),
			annotations: { readOnlyHint: true },
		},
		async () => {
			const guard = requirePlatformAdminForOrg(
				ctx,
				ctx.orgSlug,
				"compare theme source for",
			);
			if (guard) return guard;
			const active = (await ctx.listVersions(ctx.orgSlug)).find(
				(version) => version.active,
			);
			const activeSourceRevision = active?.sourceRevision ?? null;
			const output = await withSandboxTimeout(
				ctx,
				"theme_workspace_status",
				inspectWorkspaceSourceStatus({
					orgSlug: ctx.orgSlug,
					templateSlug: ctx.templateSlug,
					sandbox: ctx.sandbox,
					activeVersion: active?.version ?? null,
					activeSourceRevision,
					artifacts: ctx.artifacts,
				}),
			).catch(() => ({
				status: "unavailable" as const,
				activeVersion: active?.version ?? null,
				activeSourceCommit:
					activeSourceRevision?.kind === "artifacts_commit"
						? activeSourceRevision.value
						: null,
				...(activeSourceRevision?.kind === "editable_source_digest"
					? { activeSourceDigest: activeSourceRevision.value }
					: {}),
				message:
					"Builder source comparison timed out or failed. Do not seed Artifacts or replace the workspace until the active source is recovered.",
			}));
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(output, null, 2) },
				],
				structuredContent: output,
			};
		},
	);

	server.registerTool(
		"theme_list_files",
		{
			title: "List Theme Files",
			description:
				"List all theme files with their editable/locked status. " +
				"LOCKED files cannot be modified — they contain auth, content layer, and Worker config. " +
				"EDITABLE files can be modified to customize the theme. Call theme_workspace_status before editing a committed site to detect stale or draft workspace contents.",
			inputSchema: schema(z.object({})),
			outputSchema: schema(
				z
					.object({
						files: z.array(
							z.object({
								path: z.string(),
								size: z.number(),
								status: z.enum(["locked", "editable", "unknown"]),
							}),
						),
					})
					.passthrough(),
			),
			annotations: { readOnlyHint: true },
		},
		async () => {
			const result = await withSandboxTimeout(
				ctx,
				"theme_list_files",
				ctx.sandbox.listFiles(`${WORKSPACE}/src`, { recursive: true }),
			);
			const annotated = result
				.filter((f) => f.type === "file")
				.map((f) => {
					const path = f.relativePath.startsWith("src/")
						? f.relativePath
						: `src/${f.relativePath}`;
					return {
						path,
						size: f.size,
						status: isPathLocked(path, ctx.templateSlug)
							? "locked"
							: isPathEditable(path, ctx.templateSlug)
								? "editable"
								: "unknown",
					};
				});
			const output = { files: annotated };

			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(output, null, 2) },
				],
				structuredContent: output,
			};
		},
	);

	server.registerTool(
		"theme_read_file",
		{
			title: "Read Theme File",
			description:
				"Read the contents of a theme file. You can read both locked and editable files " +
				"to understand the current theme structure before making changes.",
			inputSchema: schema(
				z.object({
					path: z
						.string()
						.describe(
							"File path relative to the theme root (e.g. 'src/pages/index.astro')",
						),
				}),
			),
			outputSchema: schema(
				z
					.object({
						content: z.string().describe("Raw file contents"),
					})
					.passthrough(),
			),
			annotations: { readOnlyHint: true },
		},
		async (args: any) => {
			const result = await withSandboxTimeout(
				ctx,
				`theme_read_file ${args.path}`,
				ctx.sandbox.readFile(`${WORKSPACE}/${args.path}`),
			);
			const output = { content: result.content };
			return {
				content: [{ type: "text" as const, text: output.content }],
				structuredContent: output,
			};
		},
	);

	server.registerTool(
		"theme_write_file",
		{
			title: "Write Theme File",
			description:
				"Create or update a theme file. Only files in editable directories are allowed: " +
				"src/styles/, src/layouts/, src/components/, src/pages/. " +
				"Locked files (middleware.ts, worker.ts, live.config.ts, etc.) cannot be modified. " +
				"Provide the COMPLETE file contents — not a diff or patch.",
			inputSchema: schema(
				z.object({
					path: z
						.string()
						.describe(
							"File path relative to theme root (e.g. 'src/pages/index.astro')",
						),
					content: z.string().describe("Complete file contents"),
				}),
			),
		},
		async (args: any) => {
			if (!isPathEditable(args.path, ctx.templateSlug)) {
				const reason = isPathLocked(args.path, ctx.templateSlug)
					? `"${args.path}" is a locked file — it contains critical CMS infrastructure that must not be modified`
					: `"${args.path}" is outside editable directories (${EDITABLE_DIRS.join(", ")})`;
				return {
					content: [{ type: "text" as const, text: `[FORBIDDEN] ${reason}` }],
					isError: true as const,
				};
			}

			await withSandboxTimeout(
				ctx,
				`theme_write_file ${args.path}`,
				ctx.sandbox.writeFile(`${WORKSPACE}/${args.path}`, args.content),
			);
			return {
				content: [
					{
						type: "text" as const,
						text: `Written ${args.path} (${args.content.length} bytes)`,
					},
				],
			};
		},
	);

	server.registerTool(
		"theme_delete_file",
		{
			title: "Delete Theme File",
			description:
				"Delete a theme file. Only editable files can be deleted. " +
				"Use this to remove custom components or pages you no longer need.",
			inputSchema: schema(
				z.object({
					path: z.string().describe("File path to delete"),
				}),
			),
			annotations: { destructiveHint: true },
		},
		async (args: any) => {
			if (!isPathEditable(args.path, ctx.templateSlug)) {
				return {
					content: [
						{
							type: "text" as const,
							text: `[FORBIDDEN] Cannot delete "${args.path}" — locked or outside editable directories`,
						},
					],
					isError: true as const,
				};
			}

			await ctx.sandbox.deleteFile(`${WORKSPACE}/${args.path}`);
			return {
				content: [{ type: "text" as const, text: `Deleted ${args.path}` }],
			};
		},
	);

	server.registerTool(
		"theme_write_files",
		{
			title: "Write Multiple Theme Files",
			description:
				"Create or update multiple theme files at once. Use this for coordinated changes " +
				"across pages, layouts, components, and styles. All files must be in editable " +
				"directories. Provide COMPLETE file contents for each file.",
			inputSchema: schema(
				z.object({
					files: z
						.array(
							z.object({
								path: z.string().describe("File path relative to theme root"),
								content: z.string().describe("Complete file contents"),
							}),
						)
						.describe("Array of files to write"),
					reasoning: z
						.string()
						.optional()
						.describe("Brief explanation of the changes being made"),
				}),
			),
		},
		async (args: any) => {
			const results: string[] = [];
			const errors: string[] = [];

			for (const file of args.files) {
				if (!isPathEditable(file.path, ctx.templateSlug)) {
					errors.push(
						`SKIPPED ${file.path} — locked or outside editable directories`,
					);
					continue;
				}
				await withSandboxTimeout(
					ctx,
					`theme_write_files ${file.path}`,
					ctx.sandbox.writeFile(`${WORKSPACE}/${file.path}`, file.content),
				);
				results.push(`Written ${file.path} (${file.content.length} bytes)`);
			}

			const output = [...results, ...errors].join("\n");
			return {
				content: [{ type: "text" as const, text: output }],
				isError:
					errors.length > 0 && results.length === 0
						? (true as const)
						: undefined,
			};
		},
	);
}
