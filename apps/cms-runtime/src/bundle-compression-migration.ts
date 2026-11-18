import type { DbQueryClient } from "@tedix/db/query-client";
import { getNextTenantBundleForCompression } from "@tedix/db/queries/tenant-bundles";
import type { TenantBundle } from "@tedix/db/schema/tenant-bundles";
import {
	withSharedCmsRestorePermit,
	type CmsRestoreFenceIdentity,
} from "./tenant-restore-fence";

const COMPRESSED_KEY = "__tedix_packed_bundle.json.gz";

interface MigrationProgress {
	siteId: string;
	restoreEpoch: number;
	afterVersion: number;
	converted: number;
	alreadyCompressed: number;
}

async function verifyCompressed(
	bucket: R2Bucket,
	bundle: TenantBundle,
): Promise<boolean> {
	const object = await bucket.get(`${bundle.r2Prefix}${COMPRESSED_KEY}`);
	if (!object) return false;
	const packed = (await new Response(
		object.body.pipeThrough(new DecompressionStream("gzip")),
	).json()) as {
		mainModule?: string;
		modules?: Record<string, { js?: string }>;
	};
	if (
		packed.mainModule !== bundle.mainModule ||
		!packed.modules ||
		bundle.modulesJson.some(
			(path) => typeof packed.modules?.[path]?.js !== "string",
		)
	) {
		throw new Error(
			`Compressed bundle does not match catalog at ${bundle.r2Prefix}`,
		);
	}
	return true;
}

/** One retained version per tenant per tick; the checkpoint is pinned to restore epoch. */
export async function migrateTenantBundleCompression(
	env: {
		TENANT_BUNDLES: R2Bucket;
		RECOVERY_STORAGE: R2Bucket;
		DB_DO: DurableObjectNamespace;
	},
	db: DbQueryClient,
	identity: CmsRestoreFenceIdentity,
	load: (prefix: string) => Promise<unknown>,
): Promise<void> {
	await withSharedCmsRestorePermit(env, identity, async () => {
		const key = `bundle-compression-migration/v1/${identity.siteId}.json`;
		const saved = await env.RECOVERY_STORAGE.get(key);
		let progress = saved ? await saved.json<MigrationProgress>() : null;
		if (
			!progress ||
			progress.siteId !== identity.siteId ||
			progress.restoreEpoch !== identity.restoreEpoch
		) {
			progress = {
				siteId: identity.siteId,
				restoreEpoch: identity.restoreEpoch,
				afterVersion: 0,
				converted: 0,
				alreadyCompressed: 0,
			};
		}
		const { bundle, total, remaining } =
			await getNextTenantBundleForCompression(
				db,
				identity.slug,
				progress.afterVersion,
			);
		let unreadable = 0;
		if (bundle) {
			try {
				if (
					bundle.r2Prefix !== `${identity.slug}/v${bundle.version}/` ||
					!bundle.modulesJson.includes(bundle.mainModule)
				) {
					throw new Error(
						"Bundle catalog does not match tenant and generation",
					);
				}
				if (await verifyCompressed(env.TENANT_BUNDLES, bundle)) {
					progress.alreadyCompressed++;
				} else {
					await load(bundle.r2Prefix);
					if (!(await verifyCompressed(env.TENANT_BUNDLES, bundle)))
						throw new Error("Compressed write did not complete");
					progress.converted++;
				}
				progress.afterVersion = bundle.version;
			} catch (error) {
				// Keep the cursor on this generation so a failed write is retried.
				unreadable = 1;
				console.error("[cms-runtime] bundle compression migration unreadable", {
					slug: identity.slug,
					version: bundle.version,
					error: String(error),
				});
			}
		}
		const report = {
			...progress,
			slug: identity.slug,
			total,
			unreadable,
			remaining: remaining - (bundle && unreadable === 0 ? 1 : 0),
			checkedAt: new Date().toISOString(),
		};
		await env.RECOVERY_STORAGE.put(key, JSON.stringify(report), {
			httpMetadata: { contentType: "application/json" },
		});
		console.log("[cms-runtime] bundle compression migration", report);
	});
}
