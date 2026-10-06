import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";

const MIGRATION = readFileSync(
	new URL(
		"../../drizzle/20260829090818_require_home_plan_dependencies/migration.sql",
		import.meta.url,
	),
	"utf8",
);

describe("required Home plan dependencies migration", () => {
	it("adds an empty array only to Home plans where dependencies are missing", () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec(
			"CREATE TABLE kernel_runtime_runs (id TEXT PRIMARY KEY, metadata TEXT)",
		);
		const missing = {
			trace: "preserve",
			homePlan: { id: "missing", assignments: [], summary: "keep me" },
		};
		const existing = {
			homePlan: {
				id: "existing",
				assignments: [],
				dependencies: [
					{ fromOwnerTediId: "a", toOwnerTediId: "b", reason: "first" },
				],
			},
		};
		sqlite
			.prepare("INSERT INTO kernel_runtime_runs VALUES (?, ?), (?, ?), (?, ?)")
			.run(
				"missing",
				JSON.stringify(missing),
				"existing",
				JSON.stringify(existing),
				"unrelated",
				JSON.stringify({ trace: "unchanged" }),
			);

		sqlite.exec(MIGRATION);

		const read = (id: string) =>
			JSON.parse(
				(
					sqlite
						.prepare("SELECT metadata FROM kernel_runtime_runs WHERE id = ?")
						.get(id) as { metadata: string }
				).metadata,
			);
		expect(read("missing")).toEqual({
			...missing,
			homePlan: { ...missing.homePlan, dependencies: [] },
		});
		expect(read("existing")).toEqual(existing);
		expect(read("unrelated")).toEqual({ trace: "unchanged" });
	});
});
