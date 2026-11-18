import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { createScaffoldDatabase } from "../scripts/template-scaffold-fixture";
import { CMS_TEMPLATE_SLUGS } from "./template-policy";
import { TEMPLATE_SNAPSHOTS } from "./template-snapshot";

const seededTemplates = CMS_TEMPLATE_SLUGS.filter((slug) => {
	const pkg = JSON.parse(TEMPLATE_SNAPSHOTS[slug]!["package.json"]!);
	return Boolean(pkg.emdash?.seed);
});

describe("fresh site scaffolds", () => {
	it("covers every installed seeded scaffold", () => {
		expect(seededTemplates).toEqual([
			"marketing",
			"starter",
			"blog",
			"portfolio",
			"native-marketing",
		]);
	});

	it.each(seededTemplates)(
		"applies %s seed and passes native doctor",
		{ timeout: 60_000 },
		async (slug) => {
			const fixture = await createScaffoldDatabase(slug);
			try {
				const { stdout } = await fixture.run(
					"doctor",
					"--database",
					fixture.database,
					"--json",
				);
				const checks = JSON.parse(stdout) as {
					name: string;
					status: string;
					message: string;
				}[];
				expect(checks.filter((check) => check.status === "fail")).toEqual([]);
				for (const name of ["database", "migrations", "collections"]) {
					expect(checks.find((check) => check.name === name)?.status).toBe(
						"pass",
					);
				}
				const db = new DatabaseSync(fixture.database);
				try {
					const seed = JSON.parse(TEMPLATE_SNAPSHOTS[slug]!["seed/seed.json"]!);
					for (const collection of seed.collections) {
						expect(
							db
								.prepare("SELECT slug FROM _emdash_collections WHERE slug = ?")
								.get(collection.slug),
						).toBeTruthy();
						const table = `ec_${collection.slug.replaceAll('"', '""')}`;
						const count = db
							.prepare(`SELECT count(*) AS count FROM "${table}"`)
							.get()!;
						expect(count.count).toBe(
							seed.content?.[collection.slug]?.length ?? 0,
						);
					}
					for (const block of seed.blockTypes ?? []) {
						const versions = db
							.prepare(
								"SELECT v.version FROM _emdash_block_type_versions v JOIN _emdash_block_types b ON b.id = v.block_type_id WHERE b.slug = ? ORDER BY v.version",
							)
							.all(block.slug);
						expect(versions.map((row) => row.version)).toEqual(
							block.versions.map(
								(version: { version: number }) => version.version,
							),
						);
					}
				} finally {
					db.close();
				}
				const seedPath = fileURLToPath(
					new URL(`../templates/${slug}/seed/seed.json`, import.meta.url),
				);
				expect(JSON.parse(readFileSync(seedPath, "utf8"))).toEqual(
					JSON.parse(TEMPLATE_SNAPSHOTS[slug]!["seed/seed.json"]!),
				);
			} finally {
				await fixture.cleanup();
			}
		},
	);
});
