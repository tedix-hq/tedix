import type { McpServer } from "@tedix/mcp-shared/server";
import * as z from "zod";
import { readThemeArtifactFile } from "./artifact-source-read";
import { isPathEditable } from "./constraints";
import {
	HOT_THEME_PUBLIC_PATH,
	hotThemeManifestKey,
	listHotThemeRevisions,
	readHotThemeCss,
	readHotThemeManifest,
	rollbackHotThemeCss,
	themeArtifactRemote,
	themeArtifactRepoName,
	writeHotThemeCss,
} from "./hot-theme";
import {
	digestEditableThemeSource,
	materializeEditableThemeSource,
} from "./source-provenance";
import {
	cancelThemeArtifactRepoSeed,
	readThemeArtifactRepoCommitStatus,
	readThemeArtifactRepoSeedStatus,
	startThemeArtifactRepoCommit,
	startThemeArtifactRepoSeed,
} from "./theme-artifacts";
import {
	schema,
	WORKSPACE,
	withSandboxTimeout,
	forbidden,
	themeArtifactSeedOutput,
	type ThemeArtifactSeedOutput,
	cmsThemeArtifactSeedStatusKey,
	cmsThemeArtifactCommitStatusKey,
	updateStoredJobReceipt,
	type SiteBuilderToolContext,
} from "./tools-shared";

export function registerHotThemeTools(
	server: McpServer,
	ctx: SiteBuilderToolContext,
): void {
	server.registerTool(
		"read_hot_theme",
		{
			title: "Read Hot Theme",
			description:
				"Read the sandbox-free hot theme CSS published for this tenant. " +
				"This reads R2 directly and does not open the Site Builder sandbox.",
			inputSchema: schema(z.object({})),
			outputSchema: schema(
				z
					.object({
						orgSlug: z.string(),
						publicPath: z.string(),
						css: z.string(),
						manifest: z
							.object({
								orgSlug: z.string(),
								cssKey: z.string(),
								historyKey: z.string().optional(),
								previousRevision: z.string().nullable().optional(),
								revision: z.string(),
								revisionKey: z.string().optional(),
								size: z.number().int(),
								sha256: z.string(),
								updatedAt: z.string(),
								summary: z.string().optional(),
							})
							.passthrough()
							.nullable(),
					})
					.passthrough(),
			),
			annotations: { readOnlyHint: true },
		},
		async () => {
			const [manifest, css] = await Promise.all([
				readHotThemeManifest(ctx.bundlesBucket, ctx.orgSlug),
				readHotThemeCss(ctx.bundlesBucket, ctx.orgSlug),
			]);
			const output = {
				orgSlug: ctx.orgSlug,
				publicPath: HOT_THEME_PUBLIC_PATH,
				css: css ?? "",
				manifest,
			};
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(output, null, 2) },
				],
				structuredContent: output,
			};
		},
	);

	server.registerTool(
		"write_hot_theme",
		{
			title: "Write Hot Theme",
			description:
				"Publish sandbox-free CSS for the tenant at /_tedix/theme.css. " +
				"Use this for near-instant visual changes such as colors, spacing, typography, and small layout overrides. " +
				"It writes R2 + D1 metadata directly and does not run Astro build or touch the Site Builder sandbox.",
			inputSchema: schema(
				z.object({
					css: z
						.string()
						.max(120_000)
						.describe("Complete CSS to serve from /_tedix/theme.css."),
					summary: z
						.string()
						.max(300)
						.optional()
						.describe("Short operator summary for the hot theme revision."),
					confirmLivePublish: z
						.boolean()
						.describe(
							"Must be true. This publishes to the live tenant immediately.",
						),
				}),
			),
			outputSchema: schema(
				z
					.object({
						orgSlug: z.string(),
						publicPath: z.string(),
						cssKey: z.string(),
						historyKey: z.string().optional(),
						manifestKey: z.string(),
						previousRevision: z.string().nullable().optional(),
						revision: z.string(),
						revisionKey: z.string().optional(),
						size: z.number().int(),
						sha256: z.string(),
						updatedAt: z.string(),
						summary: z.string().optional(),
					})
					.passthrough(),
			),
			annotations: { destructiveHint: true },
		},
		async (args: {
			css: string;
			summary?: string;
			confirmLivePublish: boolean;
		}) => {
			if (!args.confirmLivePublish) {
				return forbidden(
					"write_hot_theme publishes directly to the live CMS runtime; pass confirmLivePublish:true",
				);
			}
			if (/<\/?\s*script\b/i.test(args.css)) {
				return forbidden("Hot theme CSS must not contain script tags.");
			}

			const manifest = await writeHotThemeCss(ctx, {
				css: args.css,
				summary: args.summary,
			});
			const output = {
				...manifest,
				publicPath: HOT_THEME_PUBLIC_PATH,
				manifestKey: hotThemeManifestKey(ctx.orgSlug),
			};
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(output, null, 2) },
				],
				structuredContent: output,
			};
		},
	);

	server.registerTool(
		"list_hot_theme_revisions",
		{
			title: "List Hot Theme Revisions",
			description:
				"List the bounded R2-backed hot-theme CSS revision history for this tenant. " +
				"Use this before rollback_hot_theme when a live CSS-only change needs to be reversed without using the Site Builder sandbox.",
			inputSchema: schema(
				z.object({
					limit: z
						.number()
						.int()
						.min(1)
						.max(25)
						.optional()
						.describe("Maximum revisions to return. Default 10."),
				}),
			),
			outputSchema: schema(
				z
					.object({
						orgSlug: z.string(),
						currentRevision: z.string().nullable(),
						updatedAt: z.string(),
						revisions: z.array(
							z.object({
								activatedAt: z.string(),
								createdAt: z.string(),
								revision: z.string(),
								revisionKey: z.string(),
								sha256: z.string(),
								size: z.number().int(),
								sourceRepo: z
									.object({
										name: z.string(),
										remote: z.string(),
										defaultBranch: z.string().optional(),
									})
									.optional(),
								summary: z.string().optional(),
							}),
						),
					})
					.passthrough(),
			),
			annotations: { readOnlyHint: true },
		},
		async (args: { limit?: number }) => {
			const history = await listHotThemeRevisions(
				ctx.bundlesBucket,
				ctx.orgSlug,
			);
			const output = {
				...history,
				revisions: history.revisions.slice(0, args.limit ?? 10),
			};
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(output, null, 2) },
				],
				structuredContent: output,
			};
		},
	);

	server.registerTool(
		"rollback_hot_theme",
		{
			title: "Rollback Hot Theme",
			description:
				"Promote a previous R2-backed hot-theme CSS revision back to /_tedix/theme.css without opening the Site Builder sandbox or running an Astro build.",
			inputSchema: schema(
				z.object({
					revision: z
						.string()
						.regex(/^[a-f0-9]{12}$/)
						.describe("Revision from list_hot_theme_revisions."),
					summary: z
						.string()
						.max(300)
						.optional()
						.describe("Short operator summary for the rollback revision."),
					confirmLivePublish: z
						.boolean()
						.describe(
							"Must be true. This immediately changes the live tenant hot-theme CSS.",
						),
				}),
			),
			outputSchema: schema(
				z
					.object({
						orgSlug: z.string(),
						publicPath: z.string(),
						cssKey: z.string(),
						historyKey: z.string().optional(),
						manifestKey: z.string(),
						previousRevision: z.string().nullable().optional(),
						revision: z.string(),
						revisionKey: z.string().optional(),
						size: z.number().int(),
						sha256: z.string(),
						updatedAt: z.string(),
						summary: z.string().optional(),
					})
					.passthrough(),
			),
			annotations: { destructiveHint: true },
		},
		async (args: {
			revision: string;
			summary?: string;
			confirmLivePublish: boolean;
		}) => {
			if (!args.confirmLivePublish) {
				return forbidden(
					"rollback_hot_theme publishes directly to the live CMS runtime; pass confirmLivePublish:true",
				);
			}
			const manifest = await rollbackHotThemeCss(ctx, {
				revision: args.revision,
				summary: args.summary,
			});
			const output = {
				...manifest,
				publicPath: HOT_THEME_PUBLIC_PATH,
				manifestKey: hotThemeManifestKey(ctx.orgSlug),
			};
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(output, null, 2) },
				],
				structuredContent: output,
			};
		},
	);

	server.registerTool(
		"provision_theme_artifact_repo",
		{
			title: "Provision Theme Artifact Repo",
			description:
				"Create or read the tenant's Cloudflare Artifacts Git repo and mint a short-lived Git token for editable theme source handoff. " +
				"The repo is for agent/operator authoring and review; hot live CSS still publishes through write_hot_theme. " +
				"Pass seedFromSandbox:true with scope:'write' to start a pollable seed job that pushes the current sandbox theme source into the repo.",
			inputSchema: schema(
				z.object({
					scope: z
						.enum(["read", "write"])
						.optional()
						.describe("Token scope. Default read."),
					ttlSeconds: z
						.number()
						.int()
						.min(60)
						.max(3600)
						.optional()
						.describe("Short-lived Git token TTL. Default 1800 seconds."),
					seedFromSandbox: z
						.boolean()
						.optional()
						.describe(
							"Start a background seed job that pushes the current /workspace theme source into the Artifacts repo. Requires scope:'write'. Defaults to false.",
						),
					forceSeed: z
						.boolean()
						.optional()
						.describe(
							"Overwrite the target branch when seedFromSandbox is true and the repo already has that branch. Defaults to false.",
						),
				}),
			),
			outputSchema: schema(
				z
					.object({
						orgSlug: z.string(),
						repoName: z.string(),
						remote: z.string(),
						defaultBranch: z.string().optional(),
						scope: z.enum(["read", "write"]),
						token: z.string().optional(),
						expiresAt: z.union([z.string(), z.number()]).optional(),
						created: z.boolean(),
						seedJob: z
							.object({
								jobId: z.string(),
								status: z.enum([
									"running",
									"complete",
									"failed",
									"timeout",
									"cancelled",
								]),
								running: z.boolean(),
								startedAt: z.string().nullable(),
								durationMs: z.number().int().nullable(),
								seed: z.record(z.string(), z.unknown()).nullable(),
								message: z.string(),
							})
							.passthrough()
							.optional(),
					})
					.passthrough(),
			),
		},
		async (args: {
			forceSeed?: boolean;
			scope?: "read" | "write";
			seedFromSandbox?: boolean;
			ttlSeconds?: number;
		}) => {
			if (!ctx.artifacts) {
				return {
					content: [
						{
							type: "text" as const,
							text: "[ERROR] CMS Artifacts binding is not configured.",
						},
					],
					isError: true as const,
				};
			}

			const repoName = themeArtifactRepoName(ctx.orgSlug);
			const scope = args.scope ?? "read";
			const ttlSeconds = args.ttlSeconds ?? 1800;
			if (args.seedFromSandbox && scope !== "write") {
				return forbidden(
					"seedFromSandbox pushes theme source to Git; request scope:'write' so the short-lived token can push.",
				);
			}
			let created = false;
			let repo: import("../types").ArtifactsRepoHandle;
			try {
				repo = await ctx.artifacts.get(repoName);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (!/not.?found|NOT_FOUND|404/i.test(message)) throw error;
				await ctx.artifacts.create(repoName, {
					description: `CMS theme source for ${ctx.orgSlug}`,
					readOnly: false,
					setDefaultBranch: "main",
				});
				repo = await ctx.artifacts.get(repoName);
				created = true;
			}

			const tokenResult = await repo.createToken(scope, ttlSeconds);
			const remote = themeArtifactRemote(
				ctx.artifactsAccountId,
				ctx.orgSlug,
				ctx.artifactsNamespace,
			);
			const defaultBranch = "main";
			const plaintext = await tokenResult.plaintext;
			const expiresAt = await tokenResult.expiresAt;
			const seedLaunch = args.seedFromSandbox
				? await withSandboxTimeout(
						ctx,
						"provision_theme_artifact_repo seedFromSandbox launch",
						startThemeArtifactRepoSeed(ctx, {
							branch: defaultBranch,
							forceSeed: args.forceSeed === true,
							remote,
							token: plaintext,
						}),
					)
				: undefined;
			let seedJob = seedLaunch
				? themeArtifactSeedOutput({
						jobId: seedLaunch.jobId,
						status: "running",
						exitCode: null,
						running: true,
						startedAt: seedLaunch.startedAt,
						durationMs: 0,
						seed: null,
						stdoutTail: "",
						stderrTail: "",
						logTail: "",
						message:
							"CMS theme artifact seed started; poll theme_artifact_seed_status with this jobId.",
					})
				: undefined;
			if (seedJob) {
				const initial = seedJob;
				seedJob = await updateStoredJobReceipt(
					ctx.storage,
					cmsThemeArtifactSeedStatusKey(ctx.orgSlug, initial.jobId),
					async () => initial,
				);
			}

			const output = {
				orgSlug: ctx.orgSlug,
				repoName,
				remote,
				defaultBranch,
				scope,
				token: plaintext,
				expiresAt,
				created,
				seedJob,
			};
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(output, null, 2) },
				],
				structuredContent: output,
			};
		},
	);

	server.registerTool(
		"read_theme_artifact_file",
		{
			title: "Read Theme Artifact File",
			description:
				"Read one editable text file from an exact commit in this tenant's Artifacts theme repo without changing the Site Builder sandbox. The short-lived read token stays server-side.",
			inputSchema: schema(
				z.object({
					sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
					path: z.string().min(1),
				}),
			),
			outputSchema: schema(
				z.object({
					sourceCommit: z.string(),
					path: z.string(),
					content: z.string(),
					sizeBytes: z.number(),
				}),
			),
			annotations: { readOnlyHint: true },
		},
		async (args: { sourceCommit: string; path: string }) => {
			if (!ctx.artifacts) {
				return forbidden("CMS Artifacts binding is not configured");
			}
			const output = await readThemeArtifactFile({
				orgSlug: ctx.orgSlug,
				templateSlug: ctx.templateSlug,
				sourceCommit: args.sourceCommit,
				path: args.path,
				artifacts: ctx.artifacts,
			});
			return {
				content: [{ type: "text" as const, text: JSON.stringify(output) }],
				structuredContent: output,
			};
		},
	);

	server.registerTool(
		"checkout_theme_artifact_source",
		{
			title: "Check Out Theme Artifact Source",
			description:
				"Load the editable Astro/CSS files from one exact commit in this tenant's Artifacts theme repo into the disposable Site Builder sandbox. " +
				"Use theme_read_file after this to inspect and edit the current source. This replaces unsaved editable sandbox files but does not deploy or publish. Locked template files remain platform-owned. The read token stays server-side.",
			inputSchema: schema(
				z.object({
					sourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
					confirmReplaceSandbox: z.literal(true),
				}),
			),
			annotations: { destructiveHint: true },
		},
		async (args: { sourceCommit: string; confirmReplaceSandbox: true }) => {
			if (!ctx.artifacts)
				return forbidden("CMS Artifacts binding is not configured");
			const repo = await ctx.artifacts.get(themeArtifactRepoName(ctx.orgSlug));
			const tokenResult = await repo.createToken("read", 600);
			await materializeEditableThemeSource(ctx.sandbox, {
				remote: themeArtifactRemote(
					ctx.artifactsAccountId,
					ctx.orgSlug,
					ctx.artifactsNamespace,
				),
				token: await tokenResult.plaintext,
				commit: args.sourceCommit,
				templateSlug: ctx.templateSlug,
			});
			const source = await digestEditableThemeSource(
				ctx.sandbox,
				ctx.templateSlug,
			);
			const output = {
				sourceCommit: args.sourceCommit,
				...source,
				sandboxPath: WORKSPACE,
			};
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(output, null, 2) },
				],
				structuredContent: output,
			};
		},
	);

	server.registerTool(
		"commit_theme_artifact_files",
		{
			title: "Commit Theme Files to Artifacts",
			description:
				"Commit complete editable Astro/CSS file contents to the tenant's existing Artifacts Git main branch. " +
				"The server handles the short-lived Git token; no credential is returned. Pass the current full main commit as expectedHead. " +
				"Poll theme_artifact_commit_status for the commit SHA, then pass that SHA to theme_deploy.sourceCommit. " +
				"A changed main branch is reported as a conflict; this tool never force-pushes or deploys.",
			inputSchema: schema(
				z.object({
					expectedHead: z.string().regex(/^[0-9a-f]{40}$/),
					message: z.string().min(1).max(200),
					files: z
						.array(
							z.object({
								path: z.string().min(1),
								content: z.string().max(256_000),
							}),
						)
						.min(1)
						.max(20),
				}),
			),
		},
		async (args: {
			expectedHead: string;
			message: string;
			files: Array<{ path: string; content: string }>;
		}) => {
			if (!ctx.artifacts)
				return forbidden("CMS Artifacts binding is not configured");
			const paths = args.files.map((file) => file.path);
			if (
				new Set(paths).size !== paths.length ||
				paths.some((path) => !isPathEditable(path, ctx.templateSlug))
			) {
				return forbidden(
					"Every path must be unique and editable for this tenant template",
				);
			}
			if (
				paths.some(
					(path) =>
						!/^[a-zA-Z0-9._/\[\]-]+$/.test(path) ||
						path
							.split("/")
							.some(
								(segment) =>
									!segment ||
									segment === "." ||
									segment === ".." ||
									segment === ".git",
							),
				)
			) {
				return forbidden(
					"Theme artifact paths may contain only letters, numbers, dot, underscore, dash, slash, and brackets",
				);
			}
			const repo = await ctx.artifacts.get(themeArtifactRepoName(ctx.orgSlug));
			const tokenResult = await repo.createToken("write", 600);
			const launch = await withSandboxTimeout(
				ctx,
				"commit_theme_artifact_files launch",
				startThemeArtifactRepoCommit(ctx, {
					branch: "main",
					expectedHead: args.expectedHead,
					files: args.files,
					message: args.message,
					remote: themeArtifactRemote(
						ctx.artifactsAccountId,
						ctx.orgSlug,
						ctx.artifactsNamespace,
					),
					token: await tokenResult.plaintext,
				}),
			);
			const receipt = await updateStoredJobReceipt(
				ctx.storage,
				cmsThemeArtifactCommitStatusKey(ctx.orgSlug, launch.jobId),
				async () =>
					themeArtifactSeedOutput({
						jobId: launch.jobId,
						status: "running",
						exitCode: null,
						running: true,
						startedAt: launch.startedAt,
						durationMs: 0,
						seed: null,
						stdoutTail: "",
						stderrTail: "",
						logTail: "",
						message: "CMS theme artifact commit started",
					}),
			);
			const output = {
				jobId: launch.jobId,
				status: receipt.status,
				message: receipt.message,
			};
			return {
				content: [{ type: "text" as const, text: JSON.stringify(output) }],
				structuredContent: output,
			};
		},
	);

	server.registerTool(
		"theme_artifact_commit_status",
		{
			title: "Check Theme Artifact Commit Status",
			description:
				"Read the result of commit_theme_artifact_files. A complete result may report a conflict or unchanged files instead of a new commit.",
			inputSchema: schema(
				z.object({ jobId: z.string().regex(/^[a-zA-Z0-9._-]{1,96}$/) }),
			),
		},
		async (args: { jobId: string }) => {
			const receipt = await updateStoredJobReceipt<ThemeArtifactSeedOutput>(
				ctx.storage,
				cmsThemeArtifactCommitStatusKey(ctx.orgSlug, args.jobId),
				async () =>
					themeArtifactSeedOutput(
						await readThemeArtifactRepoCommitStatus(ctx.sandbox, args.jobId),
					),
			);
			const { seed, ...rest } = receipt;
			const output = { ...rest, result: seed };
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(output, null, 2) },
				],
				structuredContent: output,
			};
		},
	);

	server.registerTool(
		"theme_artifact_seed_status",
		{
			title: "Check Theme Artifact Seed Status",
			description:
				"Check a source-handoff seed job started by provision_theme_artifact_repo. " +
				"Uses short Sandbox process probes and returns the latest Git push result/log tails.",
			inputSchema: schema(
				z.object({
					jobId: z
						.string()
						.regex(/^[a-zA-Z0-9._-]{1,96}$/)
						.describe(
							"Seed job ID returned by provision_theme_artifact_repo.seedJob.jobId.",
						),
				}),
			),
			outputSchema: schema(
				z.object({
					jobId: z.string(),
					status: z.enum([
						"running",
						"complete",
						"failed",
						"timeout",
						"cancelled",
					]),
					exitCode: z.number().int().nullable(),
					running: z.boolean(),
					startedAt: z.string().nullable(),
					durationMs: z.number().int().nullable(),
					seed: z.record(z.string(), z.unknown()).nullable(),
					stdoutTail: z.string(),
					stderrTail: z.string(),
					logTail: z.string(),
					message: z.string(),
				}),
			),
			annotations: { readOnlyHint: true },
		},
		async (args: { jobId: string }) => {
			const output = await updateStoredJobReceipt<ThemeArtifactSeedOutput>(
				ctx.storage,
				cmsThemeArtifactSeedStatusKey(ctx.orgSlug, args.jobId),
				async () =>
					themeArtifactSeedOutput(
						await readThemeArtifactRepoSeedStatus(ctx.sandbox, args.jobId),
					),
			);
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(output, null, 2) },
				],
				structuredContent: output,
				isError:
					output.status === "failed" || output.status === "timeout"
						? (true as const)
						: undefined,
			};
		},
	);

	server.registerTool(
		"theme_artifact_seed_cancel",
		{
			title: "Cancel Theme Artifact Seed",
			description:
				"Cancel a running source-handoff seed job started by provision_theme_artifact_repo.",
			inputSchema: schema(
				z.object({
					jobId: z
						.string()
						.regex(/^[a-zA-Z0-9._-]{1,96}$/)
						.describe(
							"Seed job ID returned by provision_theme_artifact_repo.seedJob.jobId.",
						),
				}),
			),
			outputSchema: schema(
				z.object({
					jobId: z.string(),
					status: z.enum([
						"running",
						"complete",
						"failed",
						"timeout",
						"cancelled",
					]),
					exitCode: z.number().int().nullable(),
					running: z.boolean(),
					startedAt: z.string().nullable(),
					durationMs: z.number().int().nullable(),
					seed: z.record(z.string(), z.unknown()).nullable(),
					stdoutTail: z.string(),
					stderrTail: z.string(),
					logTail: z.string(),
					message: z.string(),
					cancelled: z.boolean(),
					previousStatus: z.string().nullable(),
				}),
			),
			annotations: { destructiveHint: true },
		},
		async (args: { jobId: string }) => {
			let cancellation:
				| { cancelled: boolean; previousStatus: string | null }
				| undefined;
			const receipt = await updateStoredJobReceipt<ThemeArtifactSeedOutput>(
				ctx.storage,
				cmsThemeArtifactSeedStatusKey(ctx.orgSlug, args.jobId),
				async () => {
					const snapshot = await cancelThemeArtifactRepoSeed(
						ctx.sandbox,
						args.jobId,
					);
					cancellation = snapshot;
					return themeArtifactSeedOutput(snapshot);
				},
			);
			const output = {
				...receipt,
				cancelled:
					receipt.status === "cancelled" && (cancellation?.cancelled ?? false),
				previousStatus: cancellation?.previousStatus ?? receipt.status,
			};
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(output, null, 2) },
				],
				structuredContent: output,
				isError:
					output.status === "failed" || output.status === "timeout"
						? (true as const)
						: undefined,
			};
		},
	);
}
