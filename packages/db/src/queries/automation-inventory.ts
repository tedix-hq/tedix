import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import { organizations } from "../schema/organizations";
import { tedis } from "../schema/tedis";
import { projects } from "../schema/projects";
import { osGadgets, osGadgetRevisions } from "../schema/os-workspaces";
import { skillEntries, skillSchedules } from "../schema/cognitive";
import { mcpEventSubscriptions } from "../schema/mcp-event-subscriptions";
import { commitmentWakeOutbox } from "../schema/work-items";
import { workDue } from "../schema/work-due";
import { cmsSites } from "../schema/cms-sites";
import { tenantBundles } from "../schema/tenant-bundles";
import {
	AppRuntimeTriggerSchema,
	appTriggerEnabled,
} from "@tedix/api-contract/schemas/os-app-runtime";
import { listFactoryHealth } from "./factories";

export async function listAutomationInventory(
	db: DbQueryClient,
	input: { after?: string; limit: number },
	now = new Date(),
) {
	const orgs = await db
		.select({ organizationId: organizations.id })
		.from(organizations)
		.where(input.after ? gt(organizations.id, input.after) : undefined)
		.orderBy(asc(organizations.id))
		.limit(input.limit + 1);
	const page = orgs.slice(0, input.limit);
	const rows = await Promise.all(
		page.map(async ({ organizationId }) => {
			const [
				cron,
				recurring,
				wakes,
				due,
				subscriptions,
				sites,
				schedules,
				archived,
				apps,
			] = await db.batch([
				db
					.select({
						enabled: sql<number>`coalesce(sum(json_extract(job.value, '$.enabled') = 1), 0)`,
						disabled: sql<number>`coalesce(sum(coalesce(json_extract(job.value, '$.enabled'), 0) != 1), 0)`,
					})
					.from(tedis)
					.innerJoin(sql`json_each(${tedis.cronJobs}) AS job`, sql`true`)
					.where(eq(tedis.organizationId, organizationId)),
				db
					.select({
						enabled: sql<number>`coalesce(sum(coalesce(json_extract(template.value, '$.enabled'), 1) = 1), 0)`,
						disabled: sql<number>`coalesce(sum(json_extract(template.value, '$.enabled') = 0), 0)`,
					})
					.from(projects)
					.innerJoin(
						sql`json_each(${projects.metadata}, '$.recurringWork') AS template`,
						sql`true`,
					)
					.where(
						and(
							eq(projects.orgId, organizationId),
							isNull(projects.archivedAt),
						),
					),
				db
					.select({ count: sql<number>`count(*)` })
					.from(commitmentWakeOutbox)
					.where(
						and(
							eq(commitmentWakeOutbox.orgId, organizationId),
							isNull(commitmentWakeOutbox.completedAt),
						),
					),
				db
					.select({ kind: workDue.kind, count: sql<number>`count(*)` })
					.from(workDue)
					.where(eq(workDue.orgId, organizationId))
					.groupBy(workDue.kind),
				db
					.select({ count: sql<number>`count(*)` })
					.from(mcpEventSubscriptions)
					.where(
						and(
							eq(mcpEventSubscriptions.organizationId, organizationId),
							gt(mcpEventSubscriptions.expiresAt, now.toISOString()),
						),
					),
				db
					.select({ count: sql<number>`count(*)` })
					.from(cmsSites)
					.where(
						and(
							eq(cmsSites.organizationId, organizationId),
							sql`exists (select 1 from ${tenantBundles} where ${tenantBundles.slug} = ${cmsSites.slug} and ${tenantBundles.isActive} = 1)`,
						),
					),
				db
					.select({ count: sql<number>`count(*)` })
					.from(skillSchedules)
					.where(
						and(
							eq(skillSchedules.organizationId, organizationId),
							eq(skillSchedules.enabled, false),
						),
					),
				db
					.select({ count: sql<number>`count(*)` })
					.from(skillEntries)
					.where(
						and(
							eq(skillEntries.organizationId, organizationId),
							eq(skillEntries.lifecycleState, "archived"),
							sql`(
                                exists (select 1 from ${skillSchedules}
                                    where ${skillSchedules.organizationId} = ${organizationId}
                                    and ${skillSchedules.skillId} = ${skillEntries.id})
                                or exists (select 1 from ${projects}
                                    where ${projects.orgId} = ${organizationId}
                                    and json_extract(${projects.metadata}, '$.factory.skillId') = ${skillEntries.id})
                            )`,
						),
					),
				db
					.select({
						triggers: sql<string>`coalesce(json_extract(${osGadgetRevisions.manifest}, '$.config.triggers'), '[]')`,
						choices: osGadgets.triggerEnabled,
					})
					.from(osGadgets)
					.innerJoin(
						osGadgetRevisions,
						and(
							eq(osGadgetRevisions.id, osGadgets.currentRevisionId),
							eq(osGadgetRevisions.organizationId, osGadgets.organizationId),
						),
					)
					.where(
						and(
							eq(osGadgets.organizationId, organizationId),
							eq(osGadgets.status, "active"),
							eq(osGadgets.hasRuntimeTriggers, true),
						),
					),
			]);
			const osAppTriggers = { enabled: 0, disabled: 0, disabledSchedules: 0 };
			for (const app of apps) {
				for (const raw of JSON.parse(app.triggers) as unknown[]) {
					const parsed = AppRuntimeTriggerSchema.safeParse(raw);
					if (!parsed.success) continue;
					const trigger = parsed.data;
					const enabled = appTriggerEnabled(trigger, app.choices);
					osAppTriggers[enabled ? "enabled" : "disabled"]++;
					if (!enabled && trigger.kind === "schedule")
						osAppTriggers.disabledSchedules++;
				}
			}
			// Use the delivery verdict, never treat an enabled lane as proof of health.
			const health = await listFactoryHealth(db, {
				orgId: organizationId,
				now,
				runLimit: 5,
			});
			const factories = {
				healthy: 0,
				idle: 0,
				paused: 0,
				archived: Number(archived[0]!.count),
				failing: 0,
				not_firing: 0,
				pending: 0,
			};
			for (const factory of health) factories[factory.verdict]++;
			return {
				organizationId,
				tediCronJobs: {
					enabled: Number(cron[0]!.enabled),
					disabled: Number(cron[0]!.disabled),
				},
				osAppTriggers,
				recurringWork: {
					enabled: Number(recurring[0]!.enabled),
					disabled: Number(recurring[0]!.disabled),
				},
				commitmentWakesPending: Number(wakes[0]!.count),
				workDueByKind: Object.fromEntries(
					due.map((row) => [row.kind, Number(row.count)]),
				),
				mcpSubscriptions: Number(subscriptions[0]!.count),
				factories,
				cmsTenantSites: Number(sites[0]!.count),
				disabledSchedules: Number(schedules[0]!.count),
			};
		}),
	);
	return {
		organizations: rows,
		nextCursor: orgs.length > input.limit ? page.at(-1)!.organizationId : null,
	};
}
