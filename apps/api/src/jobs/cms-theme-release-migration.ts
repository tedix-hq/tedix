import { z } from "zod";
import { createDbClient } from "@tedix/db/client";
import { listActiveCmsSitesForThemeReleaseMigration } from "@tedix/db/queries/cms-sites";

const cursorKey = "cms-theme-release-migration/v1/cursor";
const commit = z.string().regex(/^[a-f0-9]{40}$/);
const receiptSchema = z.object({
	orgSlug: z.string(),
	status: z.enum(["running", "committed", "already-present", "failed"]),
	sourceCommit: commit.optional(),
	migrationCommit: commit.optional(),
	jobId: z.string().max(100).optional(),
	code: z
		.string()
		.regex(/^[A-Z_]+$/)
		.max(100)
		.optional(),
});

/** Temporary caller; remove after every site has a verified declaration. */
export async function runCmsThemeReleaseMigrationTick(
	env: Pick<
		CloudflareEnv,
		"DB" | "CMS" | "PLATFORM_SERVICE_TOKEN" | "R2_BUCKET"
	>,
) {
	const cursor = await env.R2_BUCKET.get(cursorKey);
	const sites = await listActiveCmsSitesForThemeReleaseMigration(
		createDbClient(env.DB),
		cursor ? await cursor.text() : "",
	);
	const counts = { checked: sites.length, present: 0, running: 0, failed: 0 };
	for (const site of sites) {
		let receipt: z.infer<typeof receiptSchema>;
		try {
			const response = await env.CMS.fetch(
				new Request(
					`https://cms.internal/api/internal/deployments/${encodeURIComponent(site.slug)}/theme-release-migration`,
					{
						method: "POST",
						headers: {
							Authorization: `Bearer ${env.PLATFORM_SERVICE_TOKEN}`,
							"X-Tedix-Connection-Label": site.slug,
						},
					},
				),
			);
			receipt = receiptSchema.parse(await response.json());
			const expectedStatus =
				receipt.status === "failed"
					? 500
					: receipt.status === "running"
						? 202
						: 200;
			if (
				receipt.orgSlug !== site.slug ||
				response.status !== expectedStatus ||
				(["committed", "already-present"].includes(receipt.status) &&
					!receipt.sourceCommit)
			)
				throw new Error("Invalid migration receipt");
		} catch {
			receipt = {
				orgSlug: site.slug,
				status: "failed",
				code: "MIGRATION_REQUEST_FAILED",
			};
		}
		if (receipt.status === "failed") counts.failed++;
		else if (receipt.status === "running") counts.running++;
		else counts.present++;
		console.log(
			JSON.stringify({
				event: "cms.theme_release_migration_tick",
				siteId: site.id,
				...receipt,
			}),
		);
	}
	// Advance even after a site failure so one broken repo cannot starve the fleet.
	await env.R2_BUCKET.put(
		cursorKey,
		sites.length === 10 ? sites.at(-1)!.id : "",
	);
	return counts;
}
