import { COMPRESSED_CMS_BUNDLE_KEY } from "@tedix/provisioning/cms-bundle";
import {
	THEME_CANDIDATE_TTL_MS,
	signThemePreview,
	THEME_PREVIEW_PATH,
	themeCandidateKey,
	themeCandidateEtag,
	type CmsThemeCandidate,
} from "@tedix/provisioning/cms-theme-candidate";
import { stagingPrefix, stagingManifestKey } from "./deploy-staging";
import type { AppBindings } from "../types";
import type { CmsDeployWorkflowParams } from "./deploy-admission";

export async function readThemeCandidate(
	bucket: R2Bucket,
	slug: string,
	id: string,
) {
	const object = await bucket.get(themeCandidateKey(slug, id));
	if (!object) throw new Error("Theme candidate not found");
	const candidate = await object.json<CmsThemeCandidate>();
	if (
		!candidate.ready ||
		candidate.id !== id ||
		candidate.slug !== slug ||
		!Number.isFinite(Date.parse(candidate.expiresAt)) ||
		Date.parse(candidate.expiresAt) <= Date.now()
	)
		throw new Error("Theme candidate expired or invalid");
	return candidate;
}

/** Copy the immutable inputs to runtime storage without publishing a bundle row or live assets. */
export async function stageThemeCandidate(
	env: AppBindings,
	params: CmsDeployWorkflowParams,
	jobId: string,
	stagingAttemptId: string,
) {
	if (!params.sourceCommit)
		throw new Error("A candidate requires a source commit");
	const key = themeCandidateKey(params.orgSlug, jobId);
	const prior = await env.BUNDLES_BUCKET.get(key);
	const previous = prior ? await prior.json<CmsThemeCandidate>() : null;
	if (previous?.ready)
		return readThemeCandidate(env.BUNDLES_BUCKET, params.orgSlug, jobId);
	const prefix = `${stagingPrefix(params.orgSlug, stagingAttemptId)}/`;
	const manifestObject = await env.SITE_BUILDER_STORAGE.get(
		stagingManifestKey(params.orgSlug, stagingAttemptId),
	);
	if (!manifestObject) throw new Error("Staged manifest missing");
	const manifest = await manifestObject.json<{
		mainModule: string;
		files: string[];
		sourceRevision: { kind: string; value: string };
	}>();
	if (
		manifest.sourceRevision.kind !== "artifacts_commit" ||
		manifest.sourceRevision.value !== params.sourceCommit
	)
		throw new Error("Candidate source does not match staged manifest");
	const modules: Record<string, { js: string }> = {};
	for (const path of manifest.files) {
		const object = await env.SITE_BUILDER_STORAGE.get(`${prefix}files/${path}`);
		if (!object) throw new Error("Candidate module missing");
		modules[path] = { js: await object.text() };
	}
	if (!modules[manifest.mainModule])
		throw new Error("Candidate entry module missing");
	const now = Date.now();
	const candidate: CmsThemeCandidate = {
		ready: false,
		id: jobId,
		siteId: params.siteId,
		slug: params.orgSlug,
		restoreEpoch: params.restoreEpoch,
		sourceCommit: params.sourceCommit,
		version: params.nextBundleVersion,
		expectedActiveVersion: params.expectedActiveVersion,
		stagingAttemptId,
		r2Prefix: prefix,
		etag: await themeCandidateEtag(modules),
		createdAt: new Date(now).toISOString(),
		expiresAt: new Date(now + THEME_CANDIDATE_TTL_MS).toISOString(),
		summary: params.summary,
	};
	// The incomplete catalog record lets expiry clean up an interrupted copy too.
	await env.BUNDLES_BUCKET.put(key, JSON.stringify(candidate));
	const staticKey = `${prefix}static-manifest.json`;
	const staticObject = await env.SITE_BUILDER_STORAGE.get(staticKey);
	if (!staticObject) throw new Error("Candidate static manifest missing");
	const { filenames } = await staticObject.json<{ filenames: string[] }>();
	const keys = [
		stagingManifestKey(params.orgSlug, stagingAttemptId),
		staticKey,
		...manifest.files.map((path) => `${prefix}files/${path}`),
		...filenames.map((name) => `${prefix}static/${name}`),
	];
	for (const sourceKey of keys) {
		const object = await env.SITE_BUILDER_STORAGE.get(sourceKey);
		if (!object) throw new Error("Candidate input disappeared");
		await env.BUNDLES_BUCKET.put(sourceKey, await object.arrayBuffer());
	}
	const compressed = await new Response(
		new Blob([JSON.stringify({ mainModule: manifest.mainModule, modules })])
			.stream()
			.pipeThrough(new CompressionStream("gzip")),
	).arrayBuffer();
	await env.BUNDLES_BUCKET.put(
		`${prefix}${COMPRESSED_CMS_BUNDLE_KEY}`,
		compressed,
	);
	candidate.ready = true;
	await env.BUNDLES_BUCKET.put(key, JSON.stringify(candidate));
	return candidate;
}

export async function listThemeCandidatePreviews(
	bucket: R2Bucket,
	site: { siteId: string; slug: string; restoreEpoch: number },
	activeVersion: number | null,
	origin: string,
	secret: string | undefined,
) {
	const candidates = [];
	let cursor: string | undefined;
	do {
		const page = await bucket.list({
			prefix: `theme-candidates/${site.slug}/`,
			cursor,
		});
		for (const item of page.objects) {
			const object = await bucket.get(item.key);
			if (!object) continue;
			const candidate = await object.json<CmsThemeCandidate>();
			if (
				!candidate.ready ||
				candidate.siteId !== site.siteId ||
				candidate.slug !== site.slug ||
				candidate.restoreEpoch !== site.restoreEpoch ||
				!/^cms-[a-z0-9-]+$/.test(candidate.id) ||
				item.key !== themeCandidateKey(site.slug, candidate.id) ||
				!Number.isFinite(Date.parse(candidate.expiresAt)) ||
				Date.parse(candidate.expiresAt) <= Date.now() ||
				candidate.version === activeVersion
			)
				continue;
			const token = await signThemePreview(secret, candidate);
			candidates.push({
				id: candidate.id,
				version: candidate.version,
				createdAt: candidate.createdAt,
				previewUrl: `${origin}${THEME_PREVIEW_PATH}${candidate.id}/${token}/`,
				predecessorMatches: candidate.expectedActiveVersion === activeVersion,
			});
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return candidates.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
