import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import { listFactoryScoreboard } from "./factory-scoreboard";

const DDL = `
CREATE TABLE tedis (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL, display_name TEXT);
CREATE TABLE skill_entries (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, title TEXT NOT NULL);
CREATE TABLE skill_schedules (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, skill_id TEXT NOT NULL, tedi_id TEXT NOT NULL, cron TEXT NOT NULL, enabled INTEGER NOT NULL);
CREATE TABLE skill_runs (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, skill_id TEXT NOT NULL, tedi_id TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT, work_item_id TEXT);
CREATE TABLE os_blueprints (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL);
CREATE TABLE os_workspaces (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, source_blueprint_id TEXT);
CREATE TABLE os_gadget_executions (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, run_id TEXT, created_at TEXT NOT NULL);
CREATE TABLE os_outputs (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, title TEXT NOT NULL);
CREATE TABLE os_output_revisions (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, output_id TEXT NOT NULL, skill_run_id TEXT, created_at TEXT NOT NULL);
CREATE TABLE work_items (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, title TEXT NOT NULL, disposition TEXT NOT NULL, completed_at TEXT);
`;

const ORG = "org-1";
const NOW = new Date("2026-10-14T12:00:00.000Z");

describe("listFactoryScoreboard", () => {
	it("scores loops and Blueprints through their runs, flags idle ones, in one batch", async () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec(DDL);
		sqlite.exec(`
			INSERT INTO tedis VALUES ('tedi-nova', '${ORG}', 'nova', 'Nova'), ('tedi-miles', '${ORG}', 'miles', '');
			INSERT INTO skill_entries VALUES
				('skill-digest', '${ORG}', 'Daily digest'),
				('skill-watch', '${ORG}', 'Signup watch'),
				('skill-gadget', '${ORG}', 'Gadget skill'),
				('skill-off', '${ORG}', 'Retired loop');
			INSERT INTO skill_schedules VALUES
				('s-1', '${ORG}', 'skill-digest', 'tedi-nova', '0 7 * * *', 1),
				('s-2', '${ORG}', 'skill-watch', 'tedi-miles', '0 * * * *', 1),
				('s-3', '${ORG}', 'skill-off', 'tedi-miles', '0 1 * * *', 0),
				('s-4', 'org-2', 'skill-other', 'tedi-x', '0 1 * * *', 1);
			INSERT INTO os_blueprints VALUES
				('bp-crm', '${ORG}', 'CRM factory', 'published'),
				('bp-draft', '${ORG}', 'Draft factory', 'draft');
			INSERT INTO os_workspaces VALUES ('ws-crm', '${ORG}', 'bp-crm');
			INSERT INTO skill_runs VALUES
				('r-1', '${ORG}', 'skill-digest', 'tedi-nova', 'completed', '2026-10-13 07:00:00', 'wi-done'),
				('r-2', '${ORG}', 'skill-digest', 'tedi-nova', 'failed', '2026-10-12 07:00:00', NULL),
				('r-old', '${ORG}', 'skill-digest', 'tedi-nova', 'completed', '2026-10-01 07:00:00', NULL),
				('r-3', '${ORG}', 'skill-watch', 'tedi-miles', 'completed', '2026-10-13 10:00:00', NULL),
				('r-4', '${ORG}', 'skill-gadget', 'tedi-nova', 'completed', '2026-10-13 11:00:00', NULL),
				('r-x', 'org-2', 'skill-other', 'tedi-x', 'completed', '2026-10-13 11:00:00', NULL);
			INSERT INTO os_gadget_executions VALUES ('ge-1', '${ORG}', 'ws-crm', 'r-4', '2026-10-13 11:00:00');
			INSERT INTO os_outputs VALUES ('out-1', '${ORG}', 'Weekly brief'), ('out-2', '${ORG}', 'Lead sheet'), ('out-old', '${ORG}', 'Old brief');
			INSERT INTO os_output_revisions VALUES
				('rev-1', '${ORG}', 'out-1', 'r-1', '2026-10-13 07:05:00'),
				('rev-2', '${ORG}', 'out-1', 'r-1', '2026-10-13 07:06:00'),
				('rev-old', '${ORG}', 'out-old', 'r-old', '2026-10-01 07:05:00'),
				('rev-3', '${ORG}', 'out-2', 'r-4', '2026-10-13 11:05:00');
			INSERT INTO work_items VALUES ('wi-done', '${ORG}', 'Ship digest', 'completed', '2026-10-13T08:00:00.000Z');
		`);
		const db = createDbClient(createD1Facade(sqlite));

		const { data, since } = await listFactoryScoreboard(db, {
			orgId: ORG,
			now: NOW,
		});

		expect(since).toBe("2026-10-07T12:00:00.000Z");
		expect(data.map((row) => [row.tediName, row.name])).toEqual([
			["miles", "Signup watch"],
			["Nova", "CRM factory"],
			["Nova", "Daily digest"],
		]);
		expect(data[0]).toMatchObject({
			kind: "skill_loop",
			runs: 1,
			succeeded: 1,
			outputs: 0,
			workClosed: 0,
			lastResult: null,
			idle: true,
		});
		expect(data[2]).toMatchObject({
			kind: "skill_loop",
			id: "skill-digest",
			cron: "0 7 * * *",
			runs: 2,
			succeeded: 1,
			lastRunAt: "2026-10-13 07:00:00",
			outputs: 1,
			workClosed: 1,
			lastResult: {
				kind: "work_item",
				id: "wi-done",
				title: "Ship digest",
				at: "2026-10-13 08:00:00",
			},
			idle: false,
		});
		// The gadget run is the Blueprint's, so the tedi comes from the run.
		expect(data[1]).toMatchObject({
			kind: "blueprint",
			id: "bp-crm",
			tediId: "tedi-nova",
			tediName: "Nova",
			runs: 1,
			outputs: 1,
			lastResult: { kind: "output", id: "out-2", title: "Lead sheet" },
			idle: false,
		});
	});
});
