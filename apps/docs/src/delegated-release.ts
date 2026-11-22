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
	previousRevision: string;
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

async function mainRevision(policy: Policy): Promise<string> {
	const response = await fetch(
		`https://github.com/${policy.repository}.git/info/refs?service=git-upload-pack`,
		{
			redirect: "manual",
			cache: "no-store",
			signal: AbortSignal.timeout(10_000),
		},
	);
	if (!response.ok)
		throw new Error(`Docs source check failed with HTTP ${response.status}`);
	if (
		response.headers.get("Content-Type") !==
		"application/x-git-upload-pack-advertisement"
	)
		throw new Error("Docs source did not return a Git advertisement");
	// The four hex bytes before the revision are the Git packet length.
	const ref = /^003d([a-f0-9]{40}) refs\/heads\/main$/m.exec(
		await response.text(),
	);
	return revision.parse(ref?.[1]);
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
	const sourceRevision = await mainRevision(policy);
	if (sourceRevision === activeRevision.data) return;

	// A revision can be built at most once for this release baseline, even if
	// the scheduler is delivered twice. Workflows owns retries after admission.
	await env.DOCS_BUILD_WORKFLOW.createBatch([
		{
			id: `release-${latest.id}-${sourceRevision}`,
			params: {
				operation: "release",
				siteId: site.id,
				sourceRevision,
				previousRevision: activeRevision.data,
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
	const active = await getBuild(env.DB, release.previousBuildId);
	if (
		!revision.safeParse(release.sourceRevision).success ||
		!revision.safeParse(release.previousRevision).success ||
		active?.sourceRevision !== release.previousRevision
	)
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
