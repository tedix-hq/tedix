import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";

const migration = readFileSync(
	new URL(
		"../drizzle/20261125161527_remove_default_cognitive_crons/migration.sql",
		import.meta.url,
	),
	"utf8",
);

it("retires exact defaults in packs and overrides while preserving edits and order", () => {
	const defaults = JSON.parse(
		migration.match(/json_each\('((?:[^']|'')*)'\)/)![1]!.replaceAll("''", "'"),
	) as Record<string, unknown>[];
	const seedSql = readFileSync(
		new URL(
			"../drizzle/20260804222408_system_default_control_plane_seed/migration.sql",
			import.meta.url,
		),
		"utf8",
	);
	const seeded = JSON.parse(
		seedSql
			.match(/'(\{"cronPolicy":(?:[^']|'')*\})'/)![1]!
			.replaceAll("''", "'"),
	);
	expect(defaults).toEqual(
		expect.arrayContaining(seeded.cronPolicy.cronTemplates),
	);
	const edited = defaults.flatMap((template) => [
		{ ...template, message: `${template.message} Edited by a person.` },
		{ ...template, schedule: "0 10 * * 2" },
		{ ...template, tools: ["custom-tool"] },
		{ ...template, staggerMs: 42 },
		{ ...template, annotation: "keep" },
	]);
	const custom = { name: "digest", schedule: "0 9 * * *", message: "Digest" };
	const kept = [custom, ...edited, true, "unknown-template", null];
	// JSON object key order has no scheduling meaning.
	const reordered = defaults.map((template) =>
		Object.fromEntries(Object.entries(template).reverse()),
	);
	const sqlite = new DatabaseSync(":memory:");
	try {
		for (const [table, column] of [
			["policy_packs", "definition"],
			["tedis", "runtime_overrides"],
		] as const) {
			sqlite.exec(
				`CREATE TABLE ${table} (id TEXT PRIMARY KEY, ${column} TEXT)`,
			);
			const insert = sqlite.prepare(`INSERT INTO ${table} VALUES (?, ?)`);
			for (const [id, templates] of [
				[
					"mixed",
					[
						custom,
						...defaults,
						...edited,
						...reordered,
						true,
						"unknown-template",
						null,
					],
				],
				["defaults-only", defaults],
				["custom-only", [custom]],
			] as const) {
				insert.run(
					id,
					JSON.stringify({
						other: { preserved: true },
						cronPolicy: {
							protectedCronNames: ["digest"],
							cronTemplates: templates,
						},
					}),
				);
			}
			insert.run("invalid", "not-json");
			insert.run("absent", "{}");
		}
		sqlite.exec(migration);
		const after = JSON.stringify(
			sqlite.prepare("SELECT * FROM policy_packs").all(),
		);
		sqlite.exec(migration);
		expect(
			JSON.stringify(sqlite.prepare("SELECT * FROM policy_packs").all()),
		).toBe(after);
		for (const [table, column] of [
			["policy_packs", "definition"],
			["tedis", "runtime_overrides"],
		] as const) {
			const rows = new Map(
				sqlite
					.prepare(`SELECT id, ${column} AS value FROM ${table}`)
					.all()
					.map((row) => [row.id, row.value as string]),
			);
			for (const [id, templates] of [
				["mixed", kept],
				["defaults-only", []],
				["custom-only", [custom]],
			] as const) {
				expect(JSON.parse(rows.get(id)!)).toEqual({
					other: { preserved: true },
					cronPolicy: {
						protectedCronNames: ["digest"],
						cronTemplates: templates,
					},
				});
			}
			expect(rows.get("invalid")).toBe("not-json");
			expect(rows.get("absent")).toBe("{}");
		}
	} finally {
		sqlite.close();
	}
});
