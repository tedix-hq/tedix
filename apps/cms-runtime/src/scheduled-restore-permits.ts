import type { DbQueryClient } from "@tedix/db/query-client";
import {
	enterCmsRestorePermit,
	leaveCompletedCmsScheduledPermit,
	leaveCmsRestorePermit,
	type CmsRestorePermitParams,
	type CmsRestoreSiteParams,
} from "@tedix/db/queries/cms-restore-fences";
import type { CmsRestoreFenceIdentity } from "./tenant-restore-fence";

interface ScheduledPermitCompletion extends CmsRestorePermitParams {
	version: 1;
	kind: "scheduled";
	state: "completed";
}

function prefix(siteId: string): string {
	return `scheduled-permits/${siteId}/`;
}

function key(permit: CmsRestorePermitParams): string {
	return `${prefix(permit.siteId)}${permit.permitId}.json`;
}

/** Only a successful RPC return proves that the tenant handler and its tracked
 * waitUntil callbacks ended. A rejection or process loss remains unknown; no
 * duration limit, permit age, or missing receipt can authorize reclamation.
 * https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/
 */
export async function withScheduledCmsRestorePermit<T>(
	db: DbQueryClient,
	storage: R2Bucket,
	identity: CmsRestoreFenceIdentity,
	run: () => Promise<T>,
): Promise<{ admitted: false } | { admitted: true; value: T }> {
	const permit: CmsRestorePermitParams = {
		...identity,
		permitId: crypto.randomUUID(),
		kind: "scheduled",
	};
	if (!(await enterCmsRestorePermit(db, permit))) return { admitted: false };
	const value = await run();
	const receipt: ScheduledPermitCompletion = {
		...permit,
		kind: "scheduled",
		version: 1,
		state: "completed",
	};
	// Persist proof before release: a lost D1 response must not lose ownership.
	await storage.put(key(permit), JSON.stringify(receipt));
	if (!(await leaveCompletedCmsScheduledPermit(db, permit)))
		throw new Error("CMS scheduled restore permit release failed");
	await storage.delete(key(permit));
	return { admitted: true, value };
}

/** Deriving the tenant env, building the loader stub and starting the isolate
 * through `ready` run no tenant handler: module scope cannot perform I/O. A
 * failure there (bundle load, module evaluation, loader factory) therefore
 * proves no scheduled write began and must not leave a permit behind. Only
 * the handler RPC itself runs under the permit, and its rejection stays
 * unknown. */
export async function runScheduledTenantWithPermit<T>(
	db: DbQueryClient,
	storage: R2Bucket,
	identity: CmsRestoreFenceIdentity,
	tenant: { ready: () => Promise<unknown>; scheduled: () => Promise<T> },
): Promise<{ admitted: false } | { admitted: true; value: T }> {
	await tenant.ready();
	return withScheduledCmsRestorePermit(db, storage, identity, tenant.scheduled);
}

function isCompletion(value: unknown): value is ScheduledPermitCompletion {
	if (typeof value !== "object" || value === null) return false;
	const receipt = value as Record<string, unknown>;
	return (
		receipt.version === 1 &&
		receipt.state === "completed" &&
		receipt.kind === "scheduled" &&
		typeof receipt.siteId === "string" &&
		typeof receipt.slug === "string" &&
		typeof receipt.permitId === "string" &&
		Number.isSafeInteger(receipt.restoreEpoch) &&
		(receipt.restoreEpoch as number) >= 0
	);
}

/** A bounded page of exact owner receipts; unknown and active permits stay in
 * D1 and still block capture. Replaying cleanup after a lost delete response is
 * safe because leave matches the full site, slug, epoch, kind and permit ID. */
export async function reconcileScheduledCmsRestorePermits(
	db: DbQueryClient,
	storage: R2Bucket,
	site: CmsRestoreSiteParams,
): Promise<number> {
	const page = await storage.list({ prefix: prefix(site.siteId), limit: 100 });
	let reclaimed = 0;
	for (const object of page.objects) {
		const stored = await storage.get(object.key);
		if (!stored) continue;
		const receipt: unknown = await stored.json();
		if (
			!isCompletion(receipt) ||
			receipt.siteId !== site.siteId ||
			receipt.slug !== site.slug ||
			key(receipt) !== object.key
		)
			throw new Error("CMS scheduled restore permit completion invalid");
		if (await leaveCmsRestorePermit(db, receipt)) reclaimed++;
		await storage.delete(object.key);
	}
	return reclaimed;
}
