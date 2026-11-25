import { DatabaseSync } from "node:sqlite";
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { organizations } from "../schema/organizations";
import { tedis } from "../schema/tedis";
import { projects } from "../schema/projects";
import { osGadgets, osGadgetRevisions } from "../schema/os-workspaces";
import { skillEntries, skillSchedules, skillRuns } from "../schema/cognitive";
import { mcpEventSubscriptions } from "../schema/mcp-event-subscriptions";
import {
	commitmentWakeOutbox,
	workItems,
	workItemComments,
} from "../schema/work-items";
import { workDue } from "../schema/work-due";
import { cmsSites } from "../schema/cms-sites";
import { tenantBundles } from "../schema/tenant-bundles";
import { workspaceOutputIndex } from "../schema/workspace-feed";
import { appTriggerDefinition } from "@tedix/api-contract/schemas/os-app-runtime";
import { listAutomationInventory } from "./automation-inventory";

it("counts each automation source without leaking rows, separates delivery health, and pages empty organizations", async () => {
	const sqlite = new DatabaseSync(":memory:");
	try {
		sqlite.exec("PRAGMA foreign_keys=OFF");
		sqlite.exec(
			schemaDdl(
				organizations,
				tedis,
				projects,
				osGadgets,
				osGadgetRevisions,
				skillEntries,
				skillSchedules,
				skillRuns,
				mcpEventSubscriptions,
				commitmentWakeOutbox,
				workItems,
				workItemComments,
				workDue,
				cmsSites,
				tenantBundles,
				workspaceOutputIndex,
			),
		);
		const insert = (
			table: SQLiteTable,
			values: Record<string, string | number>,
		) => {
			const config = getTableConfig(table);
			for (const column of config.columns) {
				if (
					column.notNull &&
					column.name.endsWith("_at") &&
					!(column.name in values)
				)
					values[column.name] = "2026-01-01T11:00:00Z";
				if (
					column.notNull &&
					column.default === undefined &&
					!column.generated &&
					!(column.name in values)
				)
					values[column.name] = column.dataType === "number" ? 0 : "fixture";
			}
			const keys = Object.keys(values);
			sqlite
				.prepare(
					`INSERT INTO ${config.name} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
				)
				.run(...Object.values(values));
		};
		const now = new Date("2026-01-01T12:00:00Z");
		const before = "2026-01-01T11:00:00Z";
		const future = "2026-01-01T13:00:00Z";
		insert(organizations, { id: "a", name: "Private organization", slug: "a" });
		insert(organizations, { id: "b", slug: "b" });
		insert(tedis, {
			id: "t",
			organization_id: "a",
			cron_jobs: JSON.stringify([
				{ name: "secret-job", enabled: true },
				{ enabled: false },
			]),
		});
		insert(projects, {
			id: "p",
			org_id: "a",
			metadata: JSON.stringify({
				recurringWork: [{ enabled: true }, { enabled: false }, {}],
			}),
		});
		insert(projects, {
			id: "retired",
			org_id: "a",
			key: "retired",
			archived_at: before,
			metadata: JSON.stringify({ recurringWork: [{}] }),
		});
		for (const kind of ["approval-expiry", "orphan-run-sweep"])
			insert(workDue, { org_id: "a", kind, object_id: "due" });
		insert(workDue, {
			org_id: "b",
			kind: "approval-expiry",
			object_id: "other",
		});
		insert(commitmentWakeOutbox, { id: "pending", org_id: "a" });
		insert(commitmentWakeOutbox, {
			id: "complete",
			org_id: "a",
			completed_at: before,
		});
		insert(mcpEventSubscriptions, {
			id: "live",
			created_at: before,
			updated_at: before,
			organization_id: "a",
			expires_at: future,
			sealed_credential: "do-not-return",
		});
		insert(mcpEventSubscriptions, {
			id: "expired",
			created_at: before,
			updated_at: before,
			organization_id: "a",
			expires_at: before,
		});
		insert(cmsSites, { id: "site", organization_id: "a", slug: "site" });
		insert(cmsSites, {
			id: "no-bundle",
			organization_id: "a",
			slug: "no-bundle",
		});
		insert(tenantBundles, {
			id: "bundle",
			slug: "site",
			is_active: 1,
			modules_json: "[]",
		});
		const trigger = {
			id: "scheduled",
			kind: "schedule" as const,
			cron: "0 * * * *",
			method: "run",
		};
		insert(osGadgets, {
			id: "g",
			organization_id: "a",
			current_revision_id: "rev",
			has_runtime_triggers: 1,
			trigger_enabled: JSON.stringify({
				scheduled: { enabled: true, definition: "stale-definition" },
			}),
		});
		insert(osGadgetRevisions, {
			id: "rev",
			organization_id: "a",
			gadget_id: "g",
			manifest: JSON.stringify({ config: { triggers: [trigger] } }),
		});
		for (const [id, enabled, lifecycle] of [
			["healthy", 1, "active"],
			["idle", 1, "active"],
			["paused", 0, "active"],
			["archived", 0, "archived"],
		] as const) {
			insert(skillEntries, {
				id,
				organization_id: "a",
				lifecycle_state: lifecycle,
			});
			insert(skillSchedules, {
				id,
				skill_id: id,
				organization_id: "a",
				enabled,
				cron: "0 * * * *",
				next_fire_at: future,
				created_at: before,
				params: "{}",
			});
			insert(skillRuns, {
				id,
				workflow_instance_id: id,
				skill_id: id,
				organization_id: "a",
				status: "completed",
				started_at: before,
				completed_at: "2026-01-01T11:01:00Z",
				params: "{}",
			});
		}
		insert(workspaceOutputIndex, {
			organization_id: "a",
			output_id: "output",
			revision: 1,
			skill_run_id: "healthy",
			revision_created_at: before,
		});
		const db = createDbQueryClient(createD1Facade(sqlite));
		const result = await listAutomationInventory(db, { limit: 1 }, now);
		expect(result).toEqual({
			organizations: [
				{
					organizationId: "a",
					tediCronJobs: { enabled: 1, disabled: 1 },
					osAppTriggers: { enabled: 0, disabled: 1, disabledSchedules: 1 },
					recurringWork: { enabled: 2, disabled: 1 },
					commitmentWakesPending: 1,
					workDueByKind: { "approval-expiry": 1, "orphan-run-sweep": 1 },
					mcpSubscriptions: 1,
					factories: {
						healthy: 1,
						idle: 1,
						paused: 1,
						archived: 1,
						failing: 0,
						not_firing: 0,
						pending: 0,
					},
					cmsTenantSites: 1,
					disabledSchedules: 2,
				},
			],
			nextCursor: "a",
		});
		const empty = await listAutomationInventory(
			db,
			{ after: "a", limit: 1 },
			now,
		);
		expect(empty.nextCursor).toBeNull();
		expect(empty.organizations[0]).toMatchObject({
			organizationId: "b",
			commitmentWakesPending: 0,
			tediCronJobs: { enabled: 0, disabled: 0 },
			workDueByKind: { "approval-expiry": 1 },
		});
		// A matching definition must enable the schedule; stale choices above must not.
		sqlite
			.prepare("UPDATE os_gadgets SET trigger_enabled = ? WHERE id = 'g'")
			.run(
				JSON.stringify({
					scheduled: {
						enabled: true,
						definition: appTriggerDefinition(trigger),
					},
				}),
			);
		expect(
			(await listAutomationInventory(db, { limit: 1 }, now)).organizations[0]!
				.osAppTriggers,
		).toEqual({ enabled: 1, disabled: 0, disabledSchedules: 0 });
	} finally {
		sqlite.close();
	}
});
