import type { DocsReleaseGuard } from "@tedix/db/queries/docs-sites/releases";
import { z } from "zod";
import { getBuild, getSiteById, listReleases } from "./registry";
import type { AppBindings, DocsActor, DocsSite } from "./types";

const revision = z.string().regex(/^[a-f0-9]{40}$/);
const policySchema = z.strictObject({
	siteId: z.uuid(),
	orgSlug: z.string().min(1),
	canonicalUrl: z.url({ protocol: /^https$/ }),
	repository: z.string().regex(/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/),
});
type Policy = z.infer<typeof policySchema>;

export const docsReleaseActor: DocsActor = {
	type: "service",
	id: "docs-delegated-release",
	sessionId: null,
};

export interface DelegatedDocsRelease {
	operation: "release";
	siteId: string;
	sourceRevision: string;
	previousBuildId: string;
	previousReleaseId: string;
}

function readPolicy(env: AppBindings): Policy | null {
	if (env.ENVIRONMENT !== "production" || !env.DOCS_DELEGATED_RELEASE)
		return null;
	return policySchema.parse(JSON.parse(env.DOCS_DELEGATED_RELEASE));
}

export function matchesReleaseSource(site: DocsSite, policy: Policy): boolean {
	return (
		site.id === policy.siteId &&
		site.orgSlug === policy.orgSlug &&
		site.canonicalUrl === policy.canonicalUrl &&
		site.status === "active" &&
		site.accessMode === "public" &&
		site.sourceProvider === "github" &&
		site.sourceAuthMode === "public" &&
		site.repositoryUrl === `https://github.com/${policy.repository}.git` &&
		site.branch === "main" &&
		site.contentRoot === "docs/public"
	);
}

async function github(policy: Policy, path: string) {
	const response = await fetch(
		`https://api.github.com/repos/${policy.repository}/${path}`,
		{
			headers: {
				Accept: "application/vnd.github+json",
				"User-Agent": "Tedix-Docs-Release",
			},
			redirect: "manual",
			cache: "no-store",
			signal: AbortSignal.timeout(10_000),
		},
	);
	if (!response.ok)
		throw new Error(`Docs source check failed with HTTP ${response.status}`);
	return response.json();
}

async function publicDocsRevision(policy: Policy): Promise<string> {
	const commits = z
		.array(z.object({ sha: revision }))
		.parse(
			await github(policy, "commits?sha=main&path=docs%2Fpublic&per_page=1"),
		);
	if (!commits[0])
		throw new Error("Public docs are missing from the release branch");
	return commits[0].sha;
}

export async function scheduleDocsRelease(env: AppBindings): Promise<void> {
	const policy = readPolicy(env);
	if (!policy) return;
	const site = await getSiteById(env.DB, policy.siteId);
	if (!site || !matchesReleaseSource(site, policy) || !site.activeBuildId)
		return;

	const [latest] = await listReleases(env.DB, site.id);
	// A manual rollback holds automation until a maintainer publishes again.
	if (
		!latest ||
		latest.action !== "publish" ||
		latest.buildId !== site.activeBuildId
	)
		return;
	const active = await getBuild(env.DB, site.activeBuildId);
	const activeRevision = revision.safeParse(active?.sourceRevision);
	if (!activeRevision.success) return;
	const sourceRevision = await publicDocsRevision(policy);
	if (sourceRevision === activeRevision.data) return;

	const comparison = z
		.object({
			status: z.string(),
			merge_base_commit: z.object({ sha: revision }),
		})
		.parse(
			await github(
				policy,
				`compare/${activeRevision.data}...${sourceRevision}?per_page=1`,
			),
		);
	if (
		comparison.status !== "ahead" ||
		comparison.merge_base_commit.sha !== activeRevision.data
	)
		return;

	// A revision can be built at most once for this release baseline, even if
	// the scheduler is delivered twice. Workflows owns retries after admission.
	await env.DOCS_BUILD_WORKFLOW.createBatch([
		{
			id: `release-${latest.id}-${sourceRevision}`,
			params: {
				operation: "release",
				siteId: site.id,
				sourceRevision,
				previousBuildId: site.activeBuildId,
				previousReleaseId: latest.id,
			},
		},
	]);
}

export async function checkDelegatedRelease(
	env: AppBindings,
	release: DelegatedDocsRelease,
): Promise<{ site: DocsSite; guard: DocsReleaseGuard } | null> {
	const policy = readPolicy(env);
	if (!policy || release.siteId !== policy.siteId) return null;
	const site = await getSiteById(env.DB, release.siteId);
	if (
		!site ||
		!matchesReleaseSource(site, policy) ||
		site.activeBuildId !== release.previousBuildId
	)
		return null;
	const [latest] = await listReleases(env.DB, site.id);
	if (latest?.id !== release.previousReleaseId || latest.action !== "publish")
		return null;
	if ((await publicDocsRevision(policy)) !== release.sourceRevision)
		return null;
	return {
		site,
		guard: {
			sourceRevision: release.sourceRevision,
			previousBuildId: release.previousBuildId,
			previousReleaseId: release.previousReleaseId,
			canonicalUrl: policy.canonicalUrl,
			repositoryUrl: `https://github.com/${policy.repository}.git`,
		},
	};
}
