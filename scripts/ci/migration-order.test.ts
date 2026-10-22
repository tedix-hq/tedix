import { expect, test } from "bun:test";
import { findOutOfOrderMigrations } from "./migration-order.ts";

const base = [
	"20261021192732_d1_retention_policies",
	"20261021195849_connection_provider_ownership",
];

test("a migration added after the newest base migration passes", () => {
	expect(
		findOutOfOrderMigrations(base, [
			...base,
			"20261022000206_workspace_skill_draft_grants",
		]).outOfOrder,
	).toEqual([]);
});

test("a migration that sorts before an existing base migration fails", () => {
	expect(
		findOutOfOrderMigrations(base, [
			...base,
			"20261021194015_workspace_skill_draft_grants",
			"20261022000206_later",
		]),
	).toEqual({
		latestBase: "20261021195849_connection_provider_ownership",
		outOfOrder: ["20261021194015_workspace_skill_draft_grants"],
	});
});

test("removing unapplied base migrations is not an ordering failure", () => {
	expect(findOutOfOrderMigrations(base, [base[0]]).outOfOrder).toEqual([]);
});

test("an empty base accepts any migration", () => {
	expect(findOutOfOrderMigrations([], ["20260101000000_init"])).toEqual({
		latestBase: undefined,
		outOfOrder: [],
	});
});
