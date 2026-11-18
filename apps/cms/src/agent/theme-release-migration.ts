import { z } from "zod";
import type { AppBindings } from "../types";
import { normalizeCmsTemplateSlug } from "../template-policy";
import { getSiteBuilderSandbox } from "../sandbox";
import { readThemeArtifactHead } from "./artifact-source-read";
import { CmsDeployFailure } from "./deploy-failure";
import { themeArtifactRemote, themeArtifactRepoName } from "./hot-theme";
import { getCmsTemplateSelection } from "./storage";
import { snapshotForTemplate } from "./template-sync";
import {
	findThemeArtifactFile,
	readThemeArtifactBlob,
	readThemeArtifactTree,
	readThemeArtifactRepoCommitStatus,
	startThemeArtifactRepoCommit,
	themeArtifactCommitSandbox,
} from "./theme-artifacts";
import { withPublishedBlocks } from "./theme-content-compatibility";
import { themeReleaseSchema } from "./theme-release";

const path = "src/theme-release.json";
const declarationSchema = themeReleaseSchema.pick({
	upstreamStarterRevision: true,
	supportedBlocks: true,
});
const receiptSchema = z.object({
	orgSlug: z.string(),
	status: z.enum(["running", "committed", "already-present", "failed"]),
	updatedAt: z.string(),
	jobId: z.string().optional(),
	expectedHead: z.string().optional(),
	sourceCommit: z.string().optional(),
	migrationCommit: z.string().optional(),
	declaration: z.string().optional(),
	launchedAt: z.string().optional(),
	code: z.string().optional(),
});
/** How long an unreadable commit job is trusted before a fresh commit is launched. */
const COMMIT_JOB_PATIENCE_MS = 30 * 60_000;
type Receipt = z.infer<typeof receiptSchema>;

/** One site and at most one launch or status probe per request. No deploys. */
export async function migrateThemeRelease(env: AppBindings, orgSlug: string) {
	const key = `cms-theme-release-migration/v1/${orgSlug}.json`;
	let stage = "SITE_LOOKUP_FAILED";
	const record = async (receipt: Omit<Receipt, "orgSlug" | "updatedAt">) => {
		const stored = { ...receipt, orgSlug, updatedAt: new Date().toISOString() };
		await env.SITE_BUILDER_STORAGE.put(key, JSON.stringify(stored));
		const { declaration: _declaration, ...output } = stored;
		console.log(
			JSON.stringify({ event: "cms.theme_release_migration", ...output }),
		);
		return output;
	};
	try {
		const selection = await getCmsTemplateSelection(env.DB, orgSlug);
		if (!selection) throw new Error("Active site not found");
		const templateSlug = normalizeCmsTemplateSlug(selection.blogTemplateSlug);
		stage = "ARTIFACTS_READ_FAILED";
		if (!env.ARTIFACTS) throw new Error("Artifacts binding unavailable");
		using repo = await env.ARTIFACTS.get(themeArtifactRepoName(orgSlug));
		const readDeclaration = async (commit: string) => {
			const root = await readThemeArtifactTree(repo, commit);
			const hash = await findThemeArtifactFile(repo, root, path);
			if (!hash) return null;
			const file = await readThemeArtifactBlob(repo, hash, 256_000);
			declarationSchema.parse(JSON.parse(file.content));
			return file.content;
		};
		const saved = await env.SITE_BUILDER_STORAGE.get(key);
		const previous = saved ? receiptSchema.parse(await saved.json()) : null;
		const ctx = {
			orgSlug,
			get sandbox() {
				return getSiteBuilderSandbox(env, orgSlug);
			},
			artifactCommitSandbox: (jobId: string) =>
				getSiteBuilderSandbox(env, orgSlug, { kind: "artifact-commit", jobId }),
		};
		// The repository is the source of truth: a declaration at HEAD means the
		// site is migrated, whatever an earlier commit job reported.
		stage = "ARTIFACTS_READ_FAILED";
		const { sourceCommit } = await readThemeArtifactHead({
			orgSlug,
			artifacts: env.ARTIFACTS,
		});
		if ((await readDeclaration(sourceCommit)) !== null) {
			return record({
				status: "already-present",
				sourceCommit,
				migrationCommit: previous?.migrationCommit ?? sourceCommit,
			});
		}
		if (previous?.status === "running" && previous.jobId) {
			const fresh =
				previous.launchedAt !== undefined &&
				Date.now() - Date.parse(previous.launchedAt) < COMMIT_JOB_PATIENCE_MS;
			const snapshot = await readThemeArtifactRepoCommitStatus(
				themeArtifactCommitSandbox(ctx, previous.jobId),
				previous.jobId,
			).catch(() => undefined);
			if (fresh && (snapshot === undefined || snapshot.status === "running"))
				return record({
					...previous,
					status: "running",
					code: snapshot ? undefined : "COMMIT_STATUS_FAILED",
				});
			// Not at HEAD and the job is finished, failed or gone: launch a fresh
			// commit below; expectedHead keeps it from overwriting newer theme work.
		}
		stage = "DECLARATION_INVALID";
		const defaults = declarationSchema.parse(
			JSON.parse(snapshotForTemplate(templateSlug).snapshot[path]!),
		);
		const declaration =
			JSON.stringify(
				{
					...defaults,
					supportedBlocks: await withPublishedBlocks(
						env,
						orgSlug,
						defaults.supportedBlocks,
						100,
					),
				},
				null,
				2,
			) + "\n";
		declarationSchema.parse(JSON.parse(declaration));
		stage = "COMMIT_LAUNCH_FAILED";
		const token = await repo.createToken("write", 600);
		const launch = await startThemeArtifactRepoCommit(ctx, {
			branch: "main",
			expectedHead: sourceCommit,
			files: [{ path, content: declaration }],
			message: "Declare theme release and published block versions",
			remote: themeArtifactRemote(env.CF_ACCOUNT_ID, orgSlug),
			token: await token.plaintext,
		});
		return record({
			status: "running",
			jobId: launch.jobId,
			expectedHead: sourceCommit,
			declaration,
			launchedAt: new Date().toISOString(),
		});
	} catch (error) {
		return record({
			status: "failed",
			code: error instanceof CmsDeployFailure ? error.code : stage,
		});
	}
}
