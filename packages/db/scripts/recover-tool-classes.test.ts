import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { planToolClassRecovery } from "./recover-tool-classes";

const key = "com.tedix/policy";
const old = (tier = "bounded_write", radius = "single_resource") => ({
	id: "tool'1",
	app_id: "app1",
	tool_id: "report_status",
	write_capability: "write",
	meta: JSON.stringify({
		other: "kept",
		[key]: { owner: "reviewer", riskTier: tier, blastRadius: radius },
	}),
	updated_at: "2026-11-14T16:00:00Z",
});
const migrated = (row = old()) => ({
	...row,
	meta: JSON.stringify({
		other: "kept",
		[key]: {
			owner: "reviewer",
			riskTier: "high_impact_write",
			blastRadius: "multi_tenant",
			declared: true,
		},
	}),
});

describe("tool class recovery plan", () => {
	it("repairs the actual immutable migration without losing unrelated metadata", () => {
		const db = new DatabaseSync(":memory:");
		const before = old();
		try {
			db.exec(
				"CREATE TABLE app_tools (id TEXT, app_id TEXT, tool_id TEXT, write_capability TEXT, meta TEXT, updated_at TEXT, tool_type_id TEXT, annotations TEXT)",
			);
			db.prepare(
				"INSERT INTO app_tools VALUES (?, ?, ?, ?, ?, ?, 'rpc', NULL)",
			).run(...Object.values(before));
			db.exec(
				readFileSync(
					new URL(
						"../drizzle/20261114160256_require-tool-class/migration.sql",
						import.meta.url,
					),
					"utf8",
				),
			);
			const after = db
				.prepare(
					"SELECT id, app_id, tool_id, write_capability, meta, updated_at FROM app_tools",
				)
				.get();
			const plan = planToolClassRecovery([before], [after]);
			expect(plan.review).toEqual([]);
			expect(plan.changes).toHaveLength(1);
			db.exec(plan.changes[0]!.sql);
			expect(db.prepare("SELECT meta FROM app_tools").get()?.meta).toBe(
				before.meta,
			);
		} finally {
			db.close();
		}
	});

	it.each([
		["bounded_write", "single_resource"],
		["external_side_effect", "external_system"],
		["high_impact_write", "tenant"],
	])(
		"recovers exact prior %s class with a concurrent edit fence",
		(tier, radius) => {
			const before = old(tier, radius);
			const after = migrated(before);
			const plan = planToolClassRecovery([before], [after]);
			expect(plan.review).toEqual([]);
			expect(plan.changes).toHaveLength(1);
			const db = new DatabaseSync(":memory:");
			try {
				db.exec(
					"CREATE TABLE app_tools (id TEXT, app_id TEXT, tool_id TEXT, write_capability TEXT, meta TEXT, updated_at TEXT)",
				);
				db.prepare("INSERT INTO app_tools VALUES (?, ?, ?, ?, ?, ?)").run(
					...Object.values(after),
				);
				db.exec(plan.changes[0]!.sql);
				expect(db.prepare("SELECT meta FROM app_tools").get()?.meta).toBe(
					before.meta,
				);
				db.prepare("UPDATE app_tools SET meta = ?, updated_at = 'later'").run(
					after.meta,
				);
				db.exec(plan.changes[0]!.sql);
				expect(db.prepare("SELECT meta FROM app_tools").get()?.meta).toBe(
					after.meta,
				);
			} finally {
				db.close();
			}
		},
	);

	it("lists missing, invalid and later-edited classes for review without guessing", () => {
		const before = old();
		for (const current of [
			{ ...migrated(), updated_at: "later" },
			{ ...migrated(), tool_id: "other" },
			{ ...migrated(), meta: "{}" },
		]) {
			const plan = planToolClassRecovery([before], [current]);
			expect(plan.changes).toEqual([]);
			expect(plan.review).toHaveLength(1);
		}
		expect(planToolClassRecovery([], [migrated()]).review[0]?.reason).toContain(
			"No prior row",
		);
		expect(
			planToolClassRecovery([{ ...before, meta: null }], [migrated()]).review[0]
				?.reason,
		).toContain("No complete valid prior class");
	});

	it("does not rewrite a reviewed prior class or an already repaired row", () => {
		const reviewed = {
			...old(),
			meta: JSON.stringify({
				[key]: {
					riskTier: "bounded_write",
					blastRadius: "single_resource",
					declared: true,
				},
			}),
		};
		expect(planToolClassRecovery([reviewed], [migrated()]).changes).toEqual([]);
		expect(planToolClassRecovery([old()], [old()])).toEqual({
			changes: [],
			review: [],
		});
		expect(() => planToolClassRecovery([old(), old()], [])).toThrow(
			"Duplicate",
		);
	});
});
