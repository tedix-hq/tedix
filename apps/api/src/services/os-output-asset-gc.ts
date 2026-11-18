import type { DbClient } from "@tedix/db/client";
import { getOrganizationById } from "@tedix/db/queries/organizations";

type GcBucket = Pick<R2Bucket, "list" | "delete">;

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
