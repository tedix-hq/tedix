import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import {
	createObjective,
	deleteObjective,
	getObjectiveById,
	listObjectives,
	updateObjective,
} from "./tedi-objectives";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE organization_purpose_charters (
			id TEXT PRIMARY KEY NOT NULL,
			org_id TEXT NOT NULL,
			version INTEGER NOT NULL,
			status TEXT NOT NULL DEFAULT 'active',
			purpose TEXT NOT NULL,
			principles TEXT NOT NULL DEFAULT '[]',
			strategic_theses TEXT NOT NULL DEFAULT '[]',
			non_goals TEXT NOT NULL DEFAULT '[]',
			evidence_refs TEXT NOT NULL DEFAULT '[]',
			review_cadence_days INTEGER NOT NULL DEFAULT 30,
			revision_reason TEXT NOT NULL,
			created_by_user_id TEXT,
			created_at TEXT NOT NULL,
			activated_at TEXT NOT NULL,
			superseded_at TEXT
		);
		CREATE TABLE tedi_objectives (
			id TEXT PRIMARY KEY NOT NULL,
			tedi_id TEXT NOT NULL,
			org_id TEXT NOT NULL,
			purpose_charter_id TEXT,
			title TEXT NOT NULL,
			description TEXT,
			approach TEXT,
			success_criteria TEXT,
			constraints TEXT,
			type TEXT NOT NULL DEFAULT 'standing',
			status TEXT NOT NULL DEFAULT 'active',
			risk_level TEXT NOT NULL DEFAULT 'medium',
			priority INTEGER NOT NULL DEFAULT 0,
			linked_domains TEXT DEFAULT '[]',
			gate_config TEXT DEFAULT '{}',
			budget_config TEXT DEFAULT '{}',
			progress TEXT DEFAULT '{}',
			created_at TEXT NOT NULL,
			updated_at TEXT,
			completed_at TEXT
		);
	`);
	return { db: createDbClient(createD1Facade(sqlite)), sqlite };
}

it("omits retired domains from reads and writes without changing stored history", async () => {
	const { db, sqlite } = fixture();
	const created = await createObjective(db, {
		id: "old-domains",
		tediId: "tedi-1",
		orgId: "org-1",
		title: "Current objective",
		type: "one_time",
		createdAt: "2026-11-01T00:00:00.000Z",
	});
	expect(created).not.toHaveProperty("linkedDomains");
	sqlite.exec(
		`UPDATE tedi_objectives SET linked_domains = '["historical"]' WHERE id = 'old-domains'`,
	);
	const updated = await updateObjective(db, created.id, {
		title: "Updated objective",
		updatedAt: "2026-11-02T00:00:00.000Z",
	});
	expect(updated).not.toHaveProperty("linkedDomains");
	expect(await getObjectiveById(db, created.id)).not.toHaveProperty(
		"linkedDomains",
	);
	const page = await listObjectives(db, { orgId: "org-1" });
	expect(page.total).toBe(1);
	expect(page.data[0]).not.toHaveProperty("linkedDomains");
	expect(
		sqlite
			.prepare("SELECT linked_domains FROM tedi_objectives WHERE id = ?")
			.get(created.id)?.linked_domains,
	).toBe('["historical"]');
	sqlite.close();
});

const baseParams = {
	tediId: "tedi-1",
	orgId: "org-1",
	title: "Keep the MCP app healthy",
	createdAt: "2026-07-16T00:00:00.000Z",
} as const;

describe("createObjective default gate (WS6)", () => {
	it("retires rather than deleting an objective anchor", async () => {
		const { db } = fixture();
		await createObjective(db, {
			...baseParams,
			id: "obj-retire",
			type: "one_time",
		});
		const retiredAt = "2026-07-20T00:00:00.000Z";
		expect(await deleteObjective(db, "obj-retire", retiredAt)).toBe(true);
		expect(await getObjectiveById(db, "obj-retire")).toMatchObject({
			status: "failed",
			completedAt: retiredAt,
		});
	});
	it("auto-applies the first_n(3) gate to a standing objective created without gateConfig", async () => {
		const { db } = fixture();
		const objective = await createObjective(db, {
			...baseParams,
			id: "obj-1",
			type: "standing",
		});
		expect(objective.gateConfig).toMatchObject({
			autonomyLevel: "supervised",
			gateType: "first_n",
			graduationCriteria: { consecutiveSuccesses: 3 },
			currentStreak: 0,
			lastGraduatedAt: null,
		});
	});

	it("treats an explicit empty {} gateConfig as ungated and applies the default", async () => {
		const { db } = fixture();
		const objective = await createObjective(db, {
			...baseParams,
			id: "obj-2",
			type: "standing",
			gateConfig: {},
		});
		expect(objective.gateConfig).toMatchObject({ gateType: "first_n" });
	});

	it("never overwrites an explicit gateConfig", async () => {
		const { db } = fixture();
		const explicit = {
			autonomyLevel: "manual",
			gateType: "always",
			graduationCriteria: { consecutiveSuccesses: 10 },
			currentStreak: 0,
			lastGraduatedAt: null,
		};
		const objective = await createObjective(db, {
			...baseParams,
			id: "obj-3",
			type: "standing",
			gateConfig: explicit,
		});
		expect(objective.gateConfig).toEqual(explicit);
	});

	it("leaves non-standing objectives ungated by default", async () => {
		const { db } = fixture();
		const oneTime = await createObjective(db, {
			...baseParams,
			id: "obj-4",
			type: "one_time",
		});
		expect(oneTime.gateConfig).toEqual({});
		const reactive = await createObjective(db, {
			...baseParams,
			id: "obj-5",
			type: "reactive",
		});
		expect(reactive.gateConfig).toEqual({});
	});
});
