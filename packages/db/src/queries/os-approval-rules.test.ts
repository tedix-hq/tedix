import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { osApprovalRules } from "../schema/os-approval-rules";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	createOsApprovalRule,
	deleteOsApprovalRule,
	findEnabledOsApprovalRulesByKind,
	getOsApprovalRule,
	listOsApprovalRules,
	setOsApprovalRuleEnabled,
} from "./os-approval-rules";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	// Rules are always org-scoped in the query predicate; the organizations
	// parent table is not needed for these tests.
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(schemaDdl(osApprovalRules));
	return createDbQueryClient(createD1Facade(sqlite));
}

function rule(overrides: Partial<Parameters<typeof createOsApprovalRule>[1]>) {
	return {
		id: crypto.randomUUID(),
		organizationId: "org-1",
		actionKind: "deploy",
		createdByKind: "user" as const,
		createdById: "user-1",
		createdAt: "2026-08-15T10:00:00.000Z",
		...overrides,
	};
}

describe("os approval rules", () => {
	it("creates with the approve decision and enabled defaults", async () => {
		const db = fixture();
		const created = await createOsApprovalRule(db, rule({ id: "rule-1" }));
		expect(created).toMatchObject({
			id: "rule-1",
			organizationId: "org-1",
			actionKind: "deploy",
			decision: "approve",
			enabled: true,
			disabledAt: null,
		});
	});

	it("lists only the owning organization's rules, newest first", async () => {
		const db = fixture();
		await createOsApprovalRule(
			db,
			rule({ id: "old", createdAt: "2026-08-01T00:00:00.000Z" }),
		);
		await createOsApprovalRule(
			db,
			rule({ id: "new", createdAt: "2026-08-14T00:00:00.000Z" }),
		);
		await createOsApprovalRule(
			db,
			rule({ id: "other", organizationId: "org-2" }),
		);

		const listed = await listOsApprovalRules(db, "org-1");
		expect(listed.map((row) => row.id)).toEqual(["new", "old"]);
		expect(await listOsApprovalRules(db, "org-2")).toHaveLength(1);
	});

	it("toggles enabled with disabledAt stamping, org-scoped", async () => {
		const db = fixture();
		await createOsApprovalRule(db, rule({ id: "rule-1" }));

		// Another organization cannot reach the rule.
		expect(
			await setOsApprovalRuleEnabled(
				db,
				{ organizationId: "org-2", ruleId: "rule-1" },
				false,
			),
		).toBeUndefined();

		const disabled = await setOsApprovalRuleEnabled(
			db,
			{ organizationId: "org-1", ruleId: "rule-1" },
			false,
		);
		expect(disabled?.enabled).toBe(false);
		expect(disabled?.disabledAt).toEqual(expect.any(String));

		const enabled = await setOsApprovalRuleEnabled(
			db,
			{ organizationId: "org-1", ruleId: "rule-1" },
			true,
		);
		expect(enabled?.enabled).toBe(true);
		expect(enabled?.disabledAt).toBeNull();
	});

	it("gets and permanently deletes only inside the owning organization", async () => {
		const db = fixture();
		await createOsApprovalRule(db, rule({ id: "rule-1", enabled: false }));
		expect(
			await getOsApprovalRule(db, {
				organizationId: "org-2",
				ruleId: "rule-1",
			}),
		).toBeUndefined();
		expect(
			await deleteOsApprovalRule(db, {
				organizationId: "org-2",
				ruleId: "rule-1",
			}),
		).toBe(false);
		expect(
			await deleteOsApprovalRule(db, {
				organizationId: "org-1",
				ruleId: "rule-1",
			}),
		).toBe(true);
		expect(
			await getOsApprovalRule(db, {
				organizationId: "org-1",
				ruleId: "rule-1",
			}),
		).toBeUndefined();
	});

	it("finds enabled rules by kind, ignoring disabled rules and other orgs", async () => {
		const db = fixture();
		await createOsApprovalRule(db, rule({ id: "deploy-rule" }));
		await createOsApprovalRule(
			db,
			rule({ id: "cron-rule", actionKind: "cron_job" }),
		);
		await createOsApprovalRule(
			db,
			rule({ id: "disabled-rule", actionKind: "bash_exec", enabled: false }),
		);
		await createOsApprovalRule(
			db,
			rule({ id: "foreign-rule", organizationId: "org-2" }),
		);

		const matched = await findEnabledOsApprovalRulesByKind(db, "org-1", [
			"deploy",
			"bash_exec",
			"cron_job",
			"deploy", // duplicate kinds are deduplicated before querying
		]);
		expect(matched.map((row) => row.id).sort()).toEqual([
			"cron-rule",
			"deploy-rule",
		]);
		expect(await findEnabledOsApprovalRulesByKind(db, "org-1", [])).toEqual([]);
	});

	it("chunks a large kind set under the bound-parameter cap", async () => {
		const db = fixture();
		await createOsApprovalRule(
			db,
			rule({ id: "match", actionKind: "kind-120" }),
		);
		const kinds = Array.from({ length: 130 }, (_, i) => `kind-${i}`);
		const matched = await findEnabledOsApprovalRulesByKind(db, "org-1", kinds);
		expect(matched.map((row) => row.id)).toEqual(["match"]);
	});
});
