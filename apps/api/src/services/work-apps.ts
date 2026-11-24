import type { DbQueryClient } from "@tedix/db/query-client";
import { listOsWorkApps } from "@tedix/db/queries/os-workspaces/gadgets";
import type { OsWorkspaceViewer } from "@tedix/db/queries/os-workspaces/workspaces";

type WorkApps = Awaited<ReturnType<typeof listOsWorkApps>>;
const listings = new Map<
	string,
	{ expiresAt: number; rows: Promise<WorkApps> }
>();

/** Cache only read paths; installers need fresh revision pointers for their writes. */
export async function readWorkApps(
	db: DbQueryClient,
	organizationId: string,
	viewer: OsWorkspaceViewer,
	limit: number,
) {
	const key = JSON.stringify([
		organizationId,
		[...new Set(viewer.userIds)].sort(),
		[...new Set(viewer.workspaceIds ?? [])].sort(),
	]);
	const now = Date.now();
	let entry = listings.get(key);
	if (!entry || entry.expiresAt <= now) {
		for (const [key, value] of listings) {
			if (value.expiresAt <= now) listings.delete(key);
		}
		// Bound retained manifests, and coalesce overlapping misses in this isolate.
		if (listings.size >= 64) listings.delete(listings.keys().next().value!);
		entry = {
			expiresAt: now + 60_000,
			rows: listOsWorkApps(db, organizationId, viewer, 201),
		};
		listings.set(key, entry);
	}
	try {
		return (await entry.rows).slice(0, Math.min(Math.max(limit, 1), 201));
	} catch (error) {
		if (listings.get(key) === entry) listings.delete(key);
		throw error;
	}
}
