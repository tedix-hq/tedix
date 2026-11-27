/**
 * Who depends on a skill, read from what the dependents themselves wrote:
 * a local runner names its rules skill in the health report it already sends,
 * a schedule and a factory hold the skill's id, a Workspace links it, and a
 * tedi owns it. Nothing here is guessed from run history.
 */

import { and, eq, gte, sql } from "drizzle-orm";
import { jsonRead } from "../../core-store/dialect";
import type { DbQueryClient } from "../../query-client";
import { skillEntries, skillSchedules } from "../../schema/cognitive";
import { dispatcherHealthReports } from "../../schema/dispatcher-health";
import { osWorkspaceResources, osWorkspaces } from "../../schema/os-workspaces";
import { projects } from "../../schema/projects";
import { tedis } from "../../schema/tedis";

/** A runner that has not reported for this long no longer counts as a user. */
const RUNNER_LIVE_MS = 7 * 86_400_000;

export interface SkillUser {
	/** Stable name of this use, quoted back to acknowledge it when archiving. */
	key: string;
	kind: "local_runner" | "schedule" | "factory" | "workspace" | "owner_tedi";
	factorySlug?: string | null;
	/** One plain sentence, such as "Read by 4 local runners on mac-1 on every pass (last seen today)". */
	label: string;
	lastSeenAt: string | null;
	/** Archiving would stop this user from working. */
	blocksArchive: boolean;
}

function seen(at: string, now: Date): string {
	const days = Math.floor((now.getTime() - Date.parse(at)) / 86_400_000);
	return days <= 0
		? "last seen today"
		: days === 1
			? "last seen yesterday"
			: `last seen ${days} days ago`;
}

export async function listSkillUsers(
	db: DbQueryClient,
	params: { orgId: string; skillId: string; now?: Date },
): Promise<SkillUser[]> {
	const now = params.now ?? new Date();
	const [runners, schedules, factories, workspaces, owners] = await db.batch([
		db
			.select({
				reporterId: dispatcherHealthReports.reporterId,
				machineName: dispatcherHealthReports.machineName,
				reportedAt: dispatcherHealthReports.reportedAt,
			})
			.from(dispatcherHealthReports)
			.where(
				and(
					eq(dispatcherHealthReports.orgId, params.orgId),
					eq(dispatcherHealthReports.rulesSkillId, params.skillId),
					gte(
						dispatcherHealthReports.reportedAt,
						new Date(now.getTime() - RUNNER_LIVE_MS).toISOString(),
					),
				),
			),
		db
			.select({
				scheduleId: skillSchedules.id,
				cron: skillSchedules.cron,
				lastFireAt: skillSchedules.lastFireAt,
			})
			.from(skillSchedules)
			.where(
				and(
					eq(skillSchedules.organizationId, params.orgId),
					eq(skillSchedules.skillId, params.skillId),
					eq(skillSchedules.enabled, true),
				),
			),
		db
			.select({
				projectId: projects.id,
				projectName: projects.name,
				factorySlug: sql<
					string | null
				>`${jsonRead(db, projects.metadata, ["factory", "slug"])}`,
			})
			.from(projects)
			.where(
				and(
					eq(projects.orgId, params.orgId),
					eq(projects.status, "active"),
					sql`${jsonRead(db, projects.metadata, ["factory", "skillId"])} = ${params.skillId}`,
				),
			),
		db
			.select({
				workspaceId: osWorkspaces.id,
				workspaceName: osWorkspaces.name,
			})
			.from(osWorkspaceResources)
			.innerJoin(
				osWorkspaces,
				eq(osWorkspaces.id, osWorkspaceResources.workspaceId),
			)
			.where(
				and(
					eq(osWorkspaceResources.organizationId, params.orgId),
					eq(osWorkspaceResources.providerId, "tedix"),
					eq(osWorkspaceResources.resourceType, "skill"),
					eq(osWorkspaceResources.providerResourceId, params.skillId),
					eq(osWorkspaceResources.status, "active"),
					eq(osWorkspaces.status, "active"),
				),
			),
		db
			.select({
				tediId: tedis.id,
				tediName: sql<string>`coalesce(${tedis.displayName}, ${tedis.name})`,
			})
			.from(skillEntries)
			.innerJoin(tedis, eq(tedis.id, skillEntries.tediId))
			.where(
				and(
					eq(skillEntries.organizationId, params.orgId),
					eq(skillEntries.id, params.skillId),
				),
			),
	]);
	const users: SkillUser[] = [];
	const machines = new Map<
		string,
		{ name: string; count: number; lastSeenAt: string }
	>();
	for (const row of runners) {
		const machine = machines.get(row.reporterId) ?? {
			name: row.machineName ?? `machine ${row.reporterId.slice(0, 8)}`,
			count: 0,
			lastSeenAt: row.reportedAt,
		};
		machine.count++;
		if (row.reportedAt > machine.lastSeenAt)
			machine.lastSeenAt = row.reportedAt;
		machines.set(row.reporterId, machine);
	}
	for (const machine of machines.values())
		users.push({
			key: `runner:${machine.name}`,
			kind: "local_runner",
			label: `Read by ${machine.count} local runner${machine.count === 1 ? "" : "s"} on ${machine.name} on every pass (${seen(machine.lastSeenAt, now)})`,
			lastSeenAt: machine.lastSeenAt,
			blocksArchive: true,
		});
	for (const row of schedules)
		users.push({
			key: `schedule:${row.scheduleId}`,
			kind: "schedule",
			label: `Runs on a schedule (${row.cron})${row.lastFireAt ? `, ${seen(row.lastFireAt, now).replace("seen", "run")}` : ""}`,
			lastSeenAt: row.lastFireAt,
			blocksArchive: true,
		});
	for (const row of factories)
		users.push({
			key: `factory:${row.projectId}`,
			kind: "factory",
			factorySlug: row.factorySlug,
			label: `Runs the factory "${row.projectName}"`,
			lastSeenAt: null,
			blocksArchive: true,
		});
	for (const row of workspaces)
		users.push({
			key: `workspace:${row.workspaceId}`,
			kind: "workspace",
			label: `Linked in the Workspace "${row.workspaceName}"`,
			lastSeenAt: null,
			blocksArchive: false,
		});
	for (const row of owners)
		users.push({
			key: `tedi:${row.tediId}`,
			kind: "owner_tedi",
			label: `Owned by the tedi ${row.tediName}`,
			lastSeenAt: null,
			blocksArchive: false,
		});
	return users;
}

/**
 * The users that stop an archive: every one that would break and was not
 * named in `acknowledged`.
 */
export function skillUsersBlockingArchive(
	users: readonly SkillUser[],
	acknowledged: readonly string[] = [],
): SkillUser[] {
	return users.filter(
		(user) => user.blocksArchive && !acknowledged.includes(user.key),
	);
}
