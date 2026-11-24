import type { McpServer } from "@tedix/mcp-shared/server";
import * as z from "zod";
import { TEMPLATE_SNAPSHOTS } from "../template-snapshot";
import { normalizeCmsTemplateSlug } from "../template-policy";
import {
	ARTIFACTS_ZERO_OID,
	commitRepoFiles,
	type ThemeArtifactFileChange,
} from "./theme-artifact-commit";
import { themeArtifactRepoName, themeArtifactRemote } from "./hot-theme";
import { readThemeArtifactBlob } from "./theme-artifacts";
import {
	ensureStarterRepoCurrent,
	listStarterChanges,
	listStarterCommits,
	resolveStarterBaseline,
	themeSourceWithStarterCommit,
	type StarterChangeset,
} from "./starter-source";
import { schema, type SiteBuilderToolContext } from "./tools-shared";

const commitSha = z.string().regex(/^[a-f0-9]{40}$/);
const MAX_LISTED_CHANGES = 200;

function starterUpstreamRevision(templateSlug: string): string | undefined {
	const raw = TEMPLATE_SNAPSHOTS[templateSlug]?.["src/theme-release.json"];
	if (!raw) return undefined;
	try {
		const parsed = JSON.parse(raw) as { upstreamStarterRevision?: unknown };
		return typeof parsed.upstreamStarterRevision === "string"
			? parsed.upstreamStarterRevision
			: undefined;
	} catch {
		return undefined;
	}
}

async function starterRepos(ctx: SiteBuilderToolContext) {
	if (!ctx.artifacts) {
		throw new Error("CMS Artifacts binding is unavailable on this Worker");
	}
	const templateSlug = normalizeCmsTemplateSlug(ctx.templateSlug);
	const starter = await ensureStarterRepoCurrent({
		artifacts: ctx.artifacts,
		accountId: ctx.artifactsAccountId,
		namespace: ctx.artifactsNamespace,
		templateSlug,
		tedixCommit: ctx.gitSha,
		upstreamStarterRevision: starterUpstreamRevision(templateSlug),
	});
	const siteRepo = await ctx.artifacts.get(themeArtifactRepoName(ctx.orgSlug));
	const [siteCommit] = await siteRepo.log({ ref: "main", limit: 1 });
	if (!siteCommit || !/^[a-f0-9]{40}$/.test(siteCommit.hash)) {
		throw new Error(
			`Theme repo for ${ctx.orgSlug} has no main commit; provision it first`,
		);
	}
	return {
		templateSlug,
		starterRepo: starter.repo,
		starterHead: starter.head,
		siteRepo,
		siteHead: siteCommit.hash,
	};
}

function trimChangeset(changeset: StarterChangeset) {
	return {
		...changeset,
		changes: changeset.changes.slice(0, MAX_LISTED_CHANGES),
		truncated: changeset.changes.length > MAX_LISTED_CHANGES,
	};
}

export function registerStarterTools(
	server: McpServer,
	ctx: SiteBuilderToolContext,
): void {
	server.registerTool(
		"theme_starter_diff",
		{
			title: "Diff Starter Template Updates",
			description:
				"List editable-file changes the site's starter template shipped since the commit " +
				"the site last recorded (src/theme-source.json starterCommit, or the oldest starter " +
				"commit matching the site's theme-release.json upstreamStarterRevision). Each change " +
				"is marked clean (site file still matches the old starter, safe to overwrite), " +
				"current (site already has the new content), or conflict (site edited the file). " +
				"Read-only for the site; it may create or advance the shared cms-starter-* repo " +
				"so the diff covers the newest bundled template snapshot.",
			inputSchema: schema(
				z.object({
					fromCommit: commitSha
						.optional()
						.describe(
							"Override the baseline starter commit (40-hex). Use a commit listed in recentStarterCommits when no baseline resolves.",
						),
				}),
			),
			outputSchema: schema(
				z
					.object({
						status: z.enum(["ok", "no_baseline"]),
						templateSlug: z.string(),
						starterRepo: z.string(),
						baseline: z
							.object({
								commit: z.string(),
								via: z.enum(["explicit", "theme_source", "upstream_revision"]),
							})
							.nullable(),
						toCommit: z.string().nullable(),
						counts: z
							.object({
								clean: z.number().int(),
								conflict: z.number().int(),
								current: z.number().int(),
							})
							.nullable(),
						changes: z.array(
							z.object({
								path: z.string(),
								kind: z.enum(["added", "modified", "deleted"]),
								status: z.enum(["clean", "conflict", "current"]),
								baseHash: z.string().nullable(),
								headHash: z.string().nullable(),
								siteHash: z.string().nullable(),
							}),
						),
						truncated: z.boolean(),
						recentStarterCommits: z.array(z.unknown()),
						message: z.string().optional(),
					})
					.passthrough(),
			),
			annotations: { readOnlyHint: true },
		},
		async (args: { fromCommit?: string }) => {
			try {
				const repos = await starterRepos(ctx);
				const baseline = await resolveStarterBaseline({
					siteRepo: repos.siteRepo,
					siteHead: repos.siteHead,
					starterRepo: repos.starterRepo,
					templateSlug: repos.templateSlug,
					fromCommit: args.fromCommit,
				});
				const recentStarterCommits = await listStarterCommits(
					repos.starterRepo,
					5,
				);
				if (!baseline) {
					const output = {
						status: "no_baseline" as const,
						templateSlug: repos.templateSlug,
						starterRepo: `cms-starter-${repos.templateSlug}`,
						baseline: null,
						toCommit: repos.starterHead,
						counts: null,
						changes: [],
						truncated: false,
						recentStarterCommits,
						message:
							"No recorded starter commit and no theme-release.json upstreamStarterRevision match. " +
							"Pass fromCommit with one of recentStarterCommits to diff against a chosen baseline.",
					};
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify(output, null, 2),
							},
						],
						structuredContent: output,
					};
				}
				const changeset = trimChangeset(
					await listStarterChanges({
						siteRepo: repos.siteRepo,
						siteHead: repos.siteHead,
						starterRepo: repos.starterRepo,
						fromCommit: baseline.commit,
						toCommit: repos.starterHead,
						templateSlug: repos.templateSlug,
					}),
				);
				const { changes, counts, ...rest } = changeset;
				const output = {
					status: "ok" as const,
					templateSlug: repos.templateSlug,
					starterRepo: `cms-starter-${repos.templateSlug}`,
					baseline,
					...rest,
					counts,
					changes,
					recentStarterCommits,
				};
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(output, null, 2),
						},
					],
					structuredContent: output,
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
		"theme_starter_apply",
		{
			title: "Apply Starter Template Updates",
			description:
				"Commit clean starter-template updates (plus caller-resolved conflicts) to a " +
				"starter-update-* branch in the site's theme repo, record the new starter commit " +
				"in src/theme-source.json, and stage a preview candidate. Never publishes — " +
				"publishing stays on the normal stage, preview, publish flow. Conflicting files " +
				"must be resolved via resolutions[] ({path, content} or {path, delete:true}); " +
				"clean and current changes need no resolution.",
			inputSchema: schema(
				z.object({
					summary: z
						.string()
						.optional()
						.describe("Version-history note for the staged candidate"),
					fromCommit: commitSha
						.optional()
						.describe("Baseline starter commit override (40-hex)"),
					resolutions: z
						.array(
							z.object({
								path: z.string(),
								content: z
									.string()
									.optional()
									.describe("Full replacement file content"),
								delete: z
									.literal(true)
									.optional()
									.describe("Delete the file instead of writing content"),
							}),
						)
						.optional()
						.describe(
							"One entry per conflicting path from theme_starter_diff. Exactly one of content/delete per entry.",
						),
				}),
			),
			annotations: { destructiveHint: true },
		},
		async (args: {
			summary?: string;
			fromCommit?: string;
			resolutions?: Array<{
				path: string;
				content?: string;
				delete?: true;
			}>;
		}) => {
			try {
				const repos = await starterRepos(ctx);
				const baseline = await resolveStarterBaseline({
					siteRepo: repos.siteRepo,
					siteHead: repos.siteHead,
					starterRepo: repos.starterRepo,
					templateSlug: repos.templateSlug,
					fromCommit: args.fromCommit,
				});
				if (!baseline) {
					const recentStarterCommits = await listStarterCommits(
						repos.starterRepo,
						10,
					);
					throw new Error(
						`No starter baseline for ${ctx.orgSlug}. Call theme_starter_diff and re-run with fromCommit set to one of: ` +
							recentStarterCommits.map((c) => c.commit).join(", "),
					);
				}
				const changeset = await listStarterChanges({
					siteRepo: repos.siteRepo,
					siteHead: repos.siteHead,
					starterRepo: repos.starterRepo,
					fromCommit: baseline.commit,
					toCommit: repos.starterHead,
					templateSlug: repos.templateSlug,
				});
				const actionable = changeset.changes.filter(
					(change) => change.status !== "current",
				);
				const conflicts = actionable.filter(
					(change) => change.status === "conflict",
				);
				const conflictPaths = new Set(conflicts.map((c) => c.path));
				const resolutions = new Map<
					string,
					{ content?: string; delete?: true }
				>();
				for (const resolution of args.resolutions ?? []) {
					if (!conflictPaths.has(resolution.path)) {
						throw new Error(
							`Resolution for ${resolution.path} is not a conflicting starter change`,
						);
					}
					if (
						(resolution.content === undefined) ===
						(resolution.delete === undefined)
					) {
						throw new Error(
							`Resolution for ${resolution.path} needs exactly one of content or delete`,
						);
					}
					resolutions.set(resolution.path, resolution);
				}
				const unresolved = conflicts
					.map((c) => c.path)
					.filter((path) => !resolutions.has(path));
				if (unresolved.length > 0) {
					throw new Error(
						`Unresolved starter conflicts: ${unresolved.join(", ")}. ` +
							"Re-run theme_starter_diff and pass resolutions[] for each.",
					);
				}

				const files: ThemeArtifactFileChange[] = [];
				const applied: string[] = [];
				const resolved: string[] = [];
				for (const change of actionable) {
					const resolution = resolutions.get(change.path);
					if (resolution) {
						files.push(
							resolution.delete
								? { path: change.path, delete: true }
								: { path: change.path, content: resolution.content! },
						);
						resolved.push(change.path);
						continue;
					}
					if (change.headHash === null) {
						files.push({ path: change.path, delete: true });
					} else {
						const blob = await readThemeArtifactBlob(
							repos.starterRepo,
							change.headHash,
						);
						files.push({ path: change.path, content: blob.content });
					}
					applied.push(change.path);
				}
				// Record the starter commit the site now tracks, even when no
				// editable file changed (e.g. only locked files moved).
				files.push(
					await themeSourceWithStarterCommit(
						repos.siteRepo,
						repos.siteHead,
						repos.starterHead,
					),
				);

				const branch = `starter-update-${repos.starterHead.slice(0, 12)}`;
				const [branchCommit] = await repos.siteRepo.log({
					ref: branch,
					limit: 1,
				});
				const branchHead =
					branchCommit && /^[a-f0-9]{40}$/.test(branchCommit.hash)
						? branchCommit.hash
						: null;
				const baseCommit = branchHead ?? repos.siteHead;
				const result = await commitRepoFiles({
					repo: repos.siteRepo,
					remote: themeArtifactRemote(
						ctx.artifactsAccountId,
						ctx.orgSlug,
						ctx.artifactsNamespace,
					),
					ref: branch,
					baseCommit,
					expectedOldOid: branchHead ?? ARTIFACTS_ZERO_OID,
					files,
					message:
						args.summary ??
						`Apply ${repos.templateSlug} starter updates through ${repos.starterHead.slice(0, 12)}`,
				});
				if (!result.committed && "conflict" in result) {
					throw new Error(
						`Branch ${branch} moved during commit (remote head ${result.remoteHead ?? "unknown"}); retry theme_starter_apply`,
					);
				}
				const commit = result.committed ? result.commit : baseCommit;
				const unchanged = !result.committed && "unchanged" in result;
				const { jobId } = await ctx.startDeploy(
					ctx.orgSlug,
					args.summary ??
						`Starter updates for ${repos.templateSlug} (branch ${branch})`,
					commit,
					{ stageOnly: true },
				);
				const output = {
					status: "staged" as const,
					templateSlug: repos.templateSlug,
					branch,
					commit,
					candidateJobId: jobId,
					baseline: baseline.commit,
					toCommit: repos.starterHead,
					applied,
					resolved,
					skipped: changeset.changes.length - actionable.length,
					unchanged,
					hint: "Poll theme_deploy_status with candidateJobId; publish stays on the normal preview/publish flow.",
				};
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(output, null, 2),
						},
					],
					structuredContent: output,
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
}
