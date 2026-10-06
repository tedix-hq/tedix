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

/** The publish permit spans reservation, activation, static writes, and receipt. */
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
		};

		const files: Record<string, Uint8Array> = {};
		for (const path of manifest.files) {
			const obj = await env.SITE_BUILDER_STORAGE.get(
				stagingFileKey(orgSlug, stagingAttemptId, path),
			);
			if (!obj) throw new Error(`Staging file missing: ${path}`);
			files[path] = new Uint8Array(await obj.arrayBuffer());
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

		// Upload content-hashed static assets (fonts, CSS, JS chunks) to
		// BUNDLES_BUCKET under static/{orgSlug}/{filename}. These are never
		// versioned — content hashes guarantee uniqueness and immutability.
		const staticManifestObj = await env.SITE_BUILDER_STORAGE.get(
			`${stagingPrefix(orgSlug, stagingAttemptId)}/static-manifest.json`,
		);
		const staticFilenames: string[] = staticManifestObj
			? ((await staticManifestObj.json()) as { filenames: string[] }).filenames
			: [];

		for (let i = 0; i < staticFilenames.length; i += 10) {
			const writes = await Promise.allSettled(
				staticFilenames.slice(i, i + 10).map(async (filename) => {
					const obj = await env.SITE_BUILDER_STORAGE.get(
						stagingStaticKey(orgSlug, stagingAttemptId, filename),
					);
					if (!obj) {
						console.warn(
							`[deploy-workflow] staged static asset missing at publish: ${filename}`,
						);
						return;
					}
					const body = await obj.arrayBuffer();
					await env.BUNDLES_BUCKET.put(staticAssetKey(orgSlug, filename), body);
				}),
			);
			const failure = writes.find(
				(result): result is PromiseRejectedResult =>
					result.status === "rejected",
			);
			if (failure) throw failure.reason;
		}

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
			sourceRevision: result.sourceRevision,
			humanAuthority: result.humanAuthority,
		};
	});
}
