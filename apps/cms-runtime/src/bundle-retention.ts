import type { DbQueryClient } from "@tedix/db/query-client";
import {
	deleteTenantBundleRow,
	listPrunableTenantBundles,
	listTenantBundles,
} from "@tedix/db/queries/tenant-bundles";
import { withScheduledCmsRestorePermit } from "./scheduled-restore-permits";
import type { CmsRestoreFenceIdentity } from "./tenant-restore-fence";

// Pruning is authorized for this site only; additions need explicit owner approval.
const RETENTION_SITES = new Set(["tedix-landing"]);
const KEEP_COMPRESSED = 5;
const VERSIONS_PER_TICK = 3;
const PACK = "__tedix_packed_bundle.json.gz";

type RetentionEnv = {
	TENANT_BUNDLES: R2Bucket;
	RECOVERY_STORAGE: R2Bucket;
};

/** Keep references even in expired captures until their actual purge. */
async function referencedVersions(
	storage: R2Bucket,
	identity: CmsRestoreFenceIdentity,
): Promise<number[]> {
	const versions = new Set<number>();
	for (const prefix of [
		`recovery/${identity.siteId}/`,
		`recovery/site-drills/${identity.siteId}/`,
		`recovery/restores/${identity.siteId}/`,
	]) {
		let cursor: string | undefined;
		do {
			const page = await storage.list({ prefix, delimiter: "/", cursor });
			for (const directory of page.delimitedPrefixes) {
				const receipt = prefix.startsWith("recovery/restores/");
				const object = await storage.get(
					`${directory}${receipt ? "receipt" : "manifest"}.json`,
				);
				if (!object) {
					const control = await storage.get(`${directory}control.json`);
					const state = control
						? (await control.json<{ state?: string }>()).state
						: undefined;
					if (state === "purged" || state === "failed") continue;
					throw new Error("Bundle retention recovery inventory incomplete");
				}
				const reference = await object.json<{
					siteId: string;
					slug: string;
					bundle: { version: number };
				}>();
				if (
					reference.siteId !== identity.siteId ||
					reference.slug !== identity.slug ||
					!Number.isSafeInteger(reference.bundle?.version) ||
					reference.bundle.version < 1
				)
					throw new Error("Bundle retention recovery reference invalid");
				versions.add(reference.bundle.version);
			}
			cursor = page.truncated ? page.cursor : undefined;
		} while (cursor);
	}
	return [...versions];
}

/** Bound maintenance to three generations under a restore and activation fence. */
export async function retainTenantBundles(
	env: RetentionEnv,
	db: DbQueryClient,
	identity: CmsRestoreFenceIdentity,
): Promise<void> {
	if (!RETENTION_SITES.has(identity.slug)) return;
	const result = await withScheduledCmsRestorePermit(
		db,
		env.RECOVERY_STORAGE,
		identity,
		async () => {
			// A caught rejection proves all awaited maintenance calls ended, permitting release.
			try {
				const before = await listTenantBundles(db, identity.slug);
				const compressedVersions: number[] = [];
				for (const bundle of before) {
					if (bundle.r2Prefix !== `${identity.slug}/v${bundle.version}/`)
						throw new Error("Bundle retention catalog prefix invalid");
					if (await env.TENANT_BUNDLES.head(`${bundle.r2Prefix}${PACK}`))
						compressedVersions.push(bundle.version);
				}
				const evidence = {
					compressedVersions,
					referencedVersions: await referencedVersions(
						env.RECOVERY_STORAGE,
						identity,
					),
				};
				const prunable = await listPrunableTenantBundles(
					db,
					identity.slug,
					KEEP_COMPRESSED,
					evidence,
				);
				const excluded = prunable.map((bundle) => bundle.version);
				const report = {
					...identity,
					before: before.map((bundle) => bundle.version),
					kept: before
						.filter((bundle) => !excluded.includes(bundle.version))
						.map((bundle) => bundle.version),
					deleted: [] as number[],
					after: before.map((bundle) => bundle.version),
					checkedAt: new Date().toISOString(),
				};
				try {
					for (const bundle of prunable.slice(0, VERSIONS_PER_TICK)) {
						// Recheck catalog eligibility before deleting any objects.
						const eligible = await listPrunableTenantBundles(
							db,
							identity.slug,
							KEEP_COMPRESSED,
							evidence,
						);
						if (!eligible.some((current) => current.id === bundle.id)) continue;
						let cursor: string | undefined;
						do {
							const page = await env.TENANT_BUNDLES.list({
								prefix: bundle.r2Prefix,
								cursor,
							});
							if (
								page.objects.some(
									(object) => !object.key.startsWith(bundle.r2Prefix),
								)
							)
								throw new Error("Bundle retention object prefix invalid");
							if (page.objects.length)
								await env.TENANT_BUNDLES.delete(
									page.objects.map((object) => object.key),
								);
							cursor = page.truncated ? page.cursor : undefined;
						} while (cursor);
						if (await deleteTenantBundleRow(db, identity.slug, bundle.version))
							report.deleted.push(bundle.version);
					}
				} finally {
					report.after = (await listTenantBundles(db, identity.slug)).map(
						(bundle) => bundle.version,
					);
					await env.RECOVERY_STORAGE.put(
						`bundle-retention/v1/${identity.siteId}.json`,
						JSON.stringify(report),
						{
							httpMetadata: { contentType: "application/json" },
						},
					);
				}
				return {};
			} catch (error) {
				return { error };
			}
		},
		`bundle-retention:${crypto.randomUUID()}`,
	);
	if (result.admitted && "error" in result.value) throw result.value.error;
}
