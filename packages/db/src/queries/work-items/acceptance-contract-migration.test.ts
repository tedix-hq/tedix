import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";

const MIGRATION = readFileSync(
	new URL(
		"../../../drizzle/20260820222324_canonical_work_acceptance_booleans/migration.sql",
		import.meta.url,
	),
	"utf8",
);

describe("canonical Work Item acceptance booleans migration", () => {
	it("preserves contracts while converting every claim to a JSON boolean", () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec(
			"CREATE TABLE work_items (id TEXT PRIMARY KEY, acceptance_contract TEXT)",
		);
		const original = {
			version: 1,
			label: "Preserve me",
			claims: [
				{
					key: "reviewed",
					label: "Reviewed",
					evidenceKinds: ["artifact"],
					minimumAcceptedEvidence: 1,
					requiresIndependentReview: 1,
				},
				{
					key: "self-verified",
					label: "Self verified",
					evidenceKinds: ["test"],
					minimumAcceptedEvidence: 2,
					requiresIndependentReview: 0,
				},
			],
		};
		sqlite
			.prepare("INSERT INTO work_items VALUES ('work', ?), ('empty', NULL)")
			.run(JSON.stringify(original));

		sqlite.exec(MIGRATION);

		const migrated = sqlite
			.prepare("SELECT acceptance_contract FROM work_items WHERE id='work'")
			.get() as { acceptance_contract: string };
		const parsed = JSON.parse(migrated.acceptance_contract) as typeof original;
		expect(parsed).toEqual({
			...original,
			claims: [
				{ ...original.claims[0], requiresIndependentReview: true },
				{ ...original.claims[1], requiresIndependentReview: false },
			],
		});
		expect(
			sqlite
				.prepare(
					"SELECT json_type(acceptance_contract, '$.claims[0].requiresIndependentReview') AS first, json_type(acceptance_contract, '$.claims[1].requiresIndependentReview') AS second FROM work_items WHERE id='work'",
				)
				.get(),
		).toEqual({ first: "true", second: "false" });
		expect(
			sqlite
				.prepare("SELECT acceptance_contract FROM work_items WHERE id='empty'")
				.get(),
		).toEqual({ acceptance_contract: null });
	});
});
