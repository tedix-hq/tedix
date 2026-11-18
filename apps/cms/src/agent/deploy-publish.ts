import { themeReleaseSchema, type ThemeRelease } from "./theme-release";
import { checkLiveThemeCompatibility } from "./theme-content-compatibility";
import { CmsDeployFailure } from "./deploy-failure";
import {
	type TenantBundleSourceRevision,
	uploadTenantBundle,
} from "@tedix/provisioning/cms";
import type { AppBindings } from "../types";
import {
	type ExactCmsActiveSite,
	withExactCmsSiteRestorePermit,
} from "./cms-restore-permit";
import {
	stagingFileKey,
	stagingManifestKey,
	stagingPrefix,
	stagingStaticKey,
} from "./deploy-staging";

export type DeployPublishPhaseState =
	| "queued"
	| "running"
	| "complete"
	| "failed";

/** Permanent R2 key for a content-hashed static asset. Never versioned. */
function staticAssetKey(orgSlug: string, filename: string): string {
	return `static/${orgSlug}/${filename}`;
}

interface PublishStagedCmsBundleInput {
	env: AppBindings;
	site: ExactCmsActiveSite;
	orgSlug: string;
	stagingAttemptId: string;
	summary?: string;
	jobId: string;
	nextBundleVersion: number;
	expectedActiveVersion: number | null;
	record: (
		phase: string,
		status: DeployPublishPhaseState,
		message?: string,
		details?: Record<string, unknown>,
	) => Promise<void>;
}

/** The publish permit spans verified static writes, activation, and receipt. */
export async function publishStagedCmsBundle(
	input: PublishStagedCmsBundleInput,
) {
	const {
		env,
		site,
		orgSlug,
		stagingAttemptId,
		summary,
		jobId,
		nextBundleVersion,
		expectedActiveVersion,
		record,
	} = input;
	if (site.slug !== orgSlug) {
		throw new Error(
			"CMS publish site identity does not match organization slug",
		);
	}
	return withExactCmsSiteRestorePermit(env.DB, site, async () => {
		const manifestObj = await env.SITE_BUILDER_STORAGE.get(
			stagingManifestKey(orgSlug, stagingAttemptId),
		);
		if (!manifestObj) throw new Error("Staging manifest missing");
		const manifest = (await manifestObj.json()) as {
			mainModule: string;
			files: string[];
			sourceRevision: TenantBundleSourceRevision;
			release: ThemeRelease;
		};

		const files: Record<string, Uint8Array> = {};
		for (const path of manifest.files) {
			const obj = await env.SITE_BUILDER_STORAGE.get(
				stagingFileKey(orgSlug, stagingAttemptId, path),
			);
			if (!obj) throw new Error(`Staging file missing: ${path}`);
			files[path] = new Uint8Array(await obj.arrayBuffer());
		}

		// Upload content-hashed static assets (fonts, CSS, JS chunks) to
		// BUNDLES_BUCKET under static/{orgSlug}/{filename}. These are never
		// versioned — content hashes guarantee uniqueness and immutability.
		const staticManifestObj = await env.SITE_BUILDER_STORAGE.get(
			`${stagingPrefix(orgSlug, stagingAttemptId)}/static-manifest.json`,
		);
		if (!staticManifestObj)
			throw new CmsDeployFailure(
				"STATIC_MANIFEST_MISSING",
				"Static staging manifest missing",
			);
		const { filenames: staticFilenames } = (await staticManifestObj.json()) as {
			filenames: string[];
		};
		if (
			!Array.isArray(staticFilenames) ||
			staticFilenames.some(
				(name) =>
					typeof name !== "string" ||
					!name ||
					name.includes("/") ||
					name === "." ||
					name === "..",
			)
		)
			throw new Error("Invalid static staging manifest");

		for (let i = 0; i < staticFilenames.length; i += 10) {
			const writes = await Promise.allSettled(
				staticFilenames.slice(i, i + 10).map(async (filename) => {
					const obj = await env.SITE_BUILDER_STORAGE.get(
						stagingStaticKey(orgSlug, stagingAttemptId, filename),
					);
					if (!obj)
						throw new CmsDeployFailure(
							"STATIC_ASSET_MISSING",
							`Staged static asset missing: ${filename}`,
						);
					const body = await obj.arrayBuffer();
					const key = staticAssetKey(orgSlug, filename);
					await env.BUNDLES_BUCKET.put(key, body);
					const stored = await env.BUNDLES_BUCKET.get(key);
					if (!stored)
						throw new CmsDeployFailure(
							"STATIC_ASSET_MISSING",
							`Published static asset missing: ${filename}`,
							true,
						);
					const actual = new Uint8Array(await stored.arrayBuffer());
					const expected = new Uint8Array(body);
					if (
						actual.length !== expected.length ||
						actual.some((byte, index) => byte !== expected[index])
					) {
						throw new CmsDeployFailure(
							"STATIC_ASSET_MISMATCH",
							`Published static asset mismatch: ${filename}`,
							true,
						);
					}
				}),
			);
			const failure = writes.find(
				(result): result is PromiseRejectedResult =>
					result.status === "rejected",
			);
			if (failure) throw failure.reason;
		}

		const parsedRelease = themeReleaseSchema.safeParse(manifest.release);
		if (!parsedRelease.success)
			throw new CmsDeployFailure(
				"THEME_RELEASE_INVALID",
				"Staged theme release manifest is missing or invalid",
			);
		// A new site has no active renderer or published content to inspect yet.
		if (expectedActiveVersion !== null) {
			await checkLiveThemeCompatibility(env, orgSlug, parsedRelease.data);
		}
		const releaseKey = `${orgSlug}/v${nextBundleVersion}/theme-release.json`;
		const releaseBody = JSON.stringify({
			...parsedRelease.data,
			sourceRevision: manifest.sourceRevision,
		});
		await env.BUNDLES_BUCKET.put(releaseKey, releaseBody);
		const storedRelease = await env.BUNDLES_BUCKET.get(releaseKey);
		if (!storedRelease || (await storedRelease.text()) !== releaseBody) {
			throw new CmsDeployFailure(
				"THEME_RELEASE_INVALID",
				"Theme release manifest readback failed",
			);
		}

		const result = await uploadTenantBundle(
			{ bundlesBucket: env.BUNDLES_BUCKET, platformDb: env.DB },
			{
				orgSlug,
				mainModule: manifest.mainModule,
				files,
				summary,
				deployedBy: jobId,
				version: nextBundleVersion,
				expectedActiveVersion,
				sourceRevision: manifest.sourceRevision,
			},
		);

		await record("publish-bundle", "complete", "Bundle published", {
			version: result.version,
			staticCount: staticFilenames.length,
			sourceRevision: result.sourceRevision,
			humanAuthority: result.humanAuthority,
		});

		return {
			version: result.version,
			etag: result.etag,
			staticCount: staticFilenames.length,
			staticFilenames,
			sourceRevision: result.sourceRevision,
			humanAuthority: result.humanAuthority,
		};
	});
}
