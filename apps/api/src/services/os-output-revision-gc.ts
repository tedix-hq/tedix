import type { DbClient } from "@tedix/db/client";
import { env } from "cloudflare:workers";
import { getOrganizationById } from "@tedix/db/queries/organizations";
import { referencedOutputBodyHashes } from "@tedix/db/queries/os-workspaces/outputs";
import { outputRevisionBodyKey } from "./os-output-revision-body-store";

export const OUTPUT_BODY_PREFIX = "os-output-revisions/v1/";
const GRACE_MS = 24 * 60 * 60 * 1000;
type GcBucket = Pick<R2Bucket, "list" | "head" | "delete">;

export async function sweepOutputRevisionBodies(input: {
	db: DbClient;
	bucket: GcBucket;
	organizationId: string;
	now: Date;
	dryRun: boolean;
}) {
	// D1 reachability cannot prove a body is orphaned while workspace objects own revisions.
	// Keep cleanup conservative until their complete historical inventories participate.
	if (env.WORKSPACE_RUNTIME)
		return {
			scanned: 0,
			eligible: 0,
			removed: 0,
			paused: "workspace-output-inventory-incomplete" as const,
		};
	const { db, bucket, organizationId, dryRun } = input;
	const prefix = outputRevisionBodyKey(organizationId, "0".repeat(64)).replace(
		/[^/]+$/,
		"",
	);
	const cutoff = input.now.getTime() - GRACE_MS;
	const result = { scanned: 0, eligible: 0, removed: 0 };
	let cursor: string | undefined;
	do {
		const page = await bucket.list({ prefix, cursor, limit: 500 });
		// Retirement keeps the organization row and its history. Only a hard
		// deletion permits dropping the whole prefix, including recent objects.
		const deletedOrganization = !(await getOrganizationById(
			db,
			organizationId,
		));
		const candidates = page.objects.filter((object) => {
			if (!object.key.startsWith(prefix))
				throw new Error("Output body list escaped organization prefix");
			return (
				deletedOrganization ||
				(/^[a-f0-9]{64}\.gz$/.test(object.key.slice(prefix.length)) &&
					object.uploaded.getTime() < cutoff)
			);
		});
		result.scanned += page.objects.length;
		// All os_output_revisions.content_sha256 rows in this org are roots:
		// historical revisions and inline-backed rows count, not just current pointers.
		const roots = await referencedOutputBodyHashes(
			db,
			{ organizationId: organizationId },
			candidates.map((object) => object.key.slice(prefix.length, -3)),
		);
		for (const object of candidates) {
			const hash = object.key.slice(prefix.length, -3);
			if (!deletedOrganization && roots.has(hash)) continue;
			result.eligible++;
			if (dryRun) continue;
			// Writers put before committing D1. Recheck upload age and roots after
			// listing so a refreshed body or newly committed revision is retained.
			const current = await bucket.head(object.key);
			if (
				!current ||
				(!deletedOrganization && current.uploaded.getTime() >= cutoff)
			)
				continue;
			if (
				!deletedOrganization &&
				(
					await referencedOutputBodyHashes(
						db,
						{ organizationId: organizationId },
						[hash],
					)
				).has(hash)
			)
				continue;
			await bucket.delete(object.key);
			result.removed++;
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return result;
}

const OUTPUT_ASSET_PREFIX = "os-output-assets/v1/";

/**
 * Images stored with files live as long as their file. This removes only what
 * a hard-deleted organization left behind: every image under its prefix.
 */
export async function sweepDeletedOrganizationOutputAssets(input: {
	db: DbClient;
	bucket: GcBucket;
}): Promise<number> {
	let removed = 0;
	let cursor: string | undefined;
	do {
		const page = await input.bucket.list({
			prefix: OUTPUT_ASSET_PREFIX,
			delimiter: "/",
			cursor,
			limit: 500,
		});
		for (const prefix of page.delimitedPrefixes) {
			if (!prefix.startsWith(OUTPUT_ASSET_PREFIX) || !prefix.endsWith("/"))
				throw new Error("Invalid output asset organization prefix");
			const organizationId = prefix.slice(OUTPUT_ASSET_PREFIX.length, -1);
			let objects: string | undefined;
			do {
				// Checked for every page, so an organization that exists keeps everything.
				if (await getOrganizationById(input.db, organizationId)) break;
				const listed = await input.bucket.list({
					prefix,
					cursor: objects,
					limit: 500,
				});
				const keys = listed.objects.map((object) => object.key);
				if (keys.some((key) => !key.startsWith(prefix)))
					throw new Error("Output asset list escaped organization prefix");
				if (keys.length) await input.bucket.delete(keys);
				removed += keys.length;
				objects = listed.truncated ? listed.cursor : undefined;
			} while (objects);
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return removed;
}

/** Discover R2 tenants too: deleted organizations no longer appear in D1. */
export async function runOutputRevisionBodyGc(input: {
	db: DbClient;
	bucket: GcBucket;
	now: Date;
}) {
	const totals = { scanned: 0, eligible: 0, removed: 0, assetsRemoved: 0 };
	let cursor: string | undefined;
	do {
		const page = await input.bucket.list({
			prefix: OUTPUT_BODY_PREFIX,
			delimiter: "/",
			cursor,
			limit: 500,
		});
		for (const prefix of page.delimitedPrefixes) {
			if (!prefix.startsWith(OUTPUT_BODY_PREFIX) || !prefix.endsWith("/"))
				throw new Error("Invalid output body organization prefix");
			const organizationId = prefix.slice(OUTPUT_BODY_PREFIX.length, -1);
			const scoped = { ...input, organizationId };
			const preview = await sweepOutputRevisionBodies({
				...scoped,
				dryRun: true,
			});
			console.log(
				JSON.stringify({
					event: "output_body_gc.preview",
					organizationId,
					...preview,
				}),
			);
			const result = await sweepOutputRevisionBodies({
				...scoped,
				dryRun: false,
			});
			console.log(
				JSON.stringify({
					event: "output_body_gc.completed",
					organizationId,
					...result,
				}),
			);
			totals.scanned += result.scanned;
			totals.eligible += result.eligible;
			totals.removed += result.removed;
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	totals.assetsRemoved = await sweepDeletedOrganizationOutputAssets(input);
	return totals;
}
