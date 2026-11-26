/**
 * Who depends on a row before it is archived, retired or deleted.
 *
 * Same shape as `cognitive/skill-users.ts`: every dependent is something that
 * wrote a reference to the row itself — a workspace default, a project lead, a
 * provider installation, organization stewardship, Work assignments, schedules,
 * share links — never a guess from history. `blocksArchive` marks the
 * dependents whose use would actually stop; the rest are shown so the owner
 * sees the whole picture. `rowDependentsBlocking` applies the owner override:
 * every blocking dependent must be named in `acknowledged`.
 */

import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { coreTable } from "../core-store/client";
import { jsonRead } from "../core-store/dialect";
import type { DbQueryClient } from "../query-client";
import {
	skillEntries as d1SkillEntries,
	skillSchedules as d1SkillSchedules,
} from "../schema/cognitive";
import { organizations as d1Organizations } from "../schema/organizations";
import {
	policyPacks as d1PolicyPacks,
	runtimeProfiles as d1RuntimeProfiles,
	workspaceTemplateSets as d1WorkspaceTemplateSets,
} from "../schema/control-plane";
import {
	osCollaborationProposals as d1OsCollaborationProposals,
	osGadgetExecutions as d1OsGadgetExecutions,
	osGadgets as d1OsGadgets,
	osWorkspaces as d1OsWorkspaces,
	osWorkspaceProjects as d1OsWorkspaceProjects,
} from "../schema/os-workspaces";
import {
	osReviewBatches as d1OsReviewBatches,
	osShareLinks as d1OsShareLinks,
	osShareSkillReadGrants as d1OsShareSkillReadGrants,
} from "../schema/os-shares";
import { projects as d1Projects } from "../schema/projects";
import { providerInstallations as d1ProviderInstallations } from "../schema/provider-installations";
import { tedis as d1Tedis } from "../schema/tedis";
import { userConfigs as d1UserConfigs } from "../schema/user-configs";
import { workAgentSessions as d1WorkAgentSessions } from "../schema/work-agent-sessions";
import {
	workAttempts as d1WorkAttempts,
	workItems as d1WorkItems,
} from "../schema/work-items";
import { workItemSources as d1WorkItemSources } from "../schema/work-item-sources";
import { workspaceOutputIndex as d1WorkspaceOutputIndex } from "../schema/workspace-feed";
import { chunkForBoundParams } from "../utils/batch";
import { readFactoryBinding } from "./factories";

/** A row lifecycle operation that consults dependents before it runs. */
export type RowDependentTargetKind =
	| "tedi"
	| "project"
	| "policy_pack"
	| "runtime_profile"
	| "workspace_template_set"
	| "output"
	| "workspace"
	| "gadget";

export interface RowDependentTarget {
	kind: RowDependentTargetKind;
	id: string;
	/**
	 * Owning organization. Null only for system-scoped rows (a system policy
	 * pack); dependents that need tenant scope are skipped without it.
	 */
	orgId?: string | null;
	/** The tedi's current slug; matches legacy slug-based org settings. */
	slug?: string | null;
}

export interface RowDependent {
	/** Stable name of this use, quoted back to acknowledge it when retiring. */
	key: string;
	kind:
		| "workspace"
		| "project"
		| "tedi"
		| "installation"
		| "organization"
		| "work_item"
		| "attempt"
		| "execution"
		| "schedule"
		| "skill"
		| "share_link"
		| "proposal"
		| "factory"
		| "session"
		| "review_batch"
		| "source"
		| "output"
		| "gadget";
	/** One plain sentence, such as "Answers chat by default in Workspace \"Ops\"". */
	label: string;
	lastSeenAt: string | null;
	/** Retiring or archiving would stop this user from working. */
	blocksArchive: boolean;
}

const OPEN_WORK_DISPOSITIONS = ["proposed", "accepted"] as const;
const LIVE_ATTEMPT_STATES = [
	"queued",
	"running",
	"waiting",
	"retrying",
] as const;
const LIVE_EXECUTION_STATES = [
	"queued",
	"awaiting_approval",
	"running",
	"paused",
] as const;

function countLabel(count: number, singular: string, plural?: string): string {
	return `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
}

async function listTediDependents(
	db: DbQueryClient,
	orgId: string,
	tediId: string,
	tediSlug: string | null,
): Promise<RowDependent[]> {
	const osWorkspaces = coreTable(db, d1OsWorkspaces);
	const projects = coreTable(db, d1Projects);
	const providerInstallations = coreTable(db, d1ProviderInstallations);
	const organizations = coreTable(db, d1Organizations);
	const workItems = coreTable(db, d1WorkItems);
	const workAttempts = coreTable(db, d1WorkAttempts);
	const osGadgetExecutions = coreTable(db, d1OsGadgetExecutions);
	const skillSchedules = coreTable(db, d1SkillSchedules);
	const skillEntries = coreTable(db, d1SkillEntries);
	const [
		defaultWorkspaces,
		ledProjects,
		installations,
		organization,
		stewardedWork,
		accountableWork,
		executorWork,
		liveAttempts,
		liveExecutions,
		schedules,
		ownedSkills,
	] = await db.batch([
		db
			.select({ id: osWorkspaces.id, name: osWorkspaces.name })
			.from(osWorkspaces)
			.where(
				and(
					eq(osWorkspaces.organizationId, orgId),
					eq(osWorkspaces.defaultTediId, tediId),
					eq(osWorkspaces.status, "active"),
				),
			),
		db
			.select({ id: projects.id, name: projects.name })
			.from(projects)
			.where(
				and(
					eq(projects.orgId, orgId),
					eq(projects.leadTediId, tediId),
					ne(projects.status, "archived"),
				),
			),
		db
			.select({
				id: providerInstallations.id,
				status: providerInstallations.status,
				externalTenantId: providerInstallations.externalTenantId,
				customerName: organizations.name,
			})
			.from(providerInstallations)
			.innerJoin(
				organizations,
				eq(organizations.id, providerInstallations.customerOrganizationId),
			)
			.where(eq(providerInstallations.primaryTediId, tediId)),
		db
			.select({ metadata: organizations.metadata })
			.from(organizations)
			.where(eq(organizations.id, orgId))
			.limit(1),
		db
			.select({ count: sql<number>`count(*)` })
			.from(workItems)
			.where(
				and(
					eq(workItems.orgId, orgId),
					eq(workItems.stewardType, "tedi"),
					eq(workItems.stewardId, tediId),
					inArray(workItems.disposition, [...OPEN_WORK_DISPOSITIONS]),
				),
			),
		db
			.select({ count: sql<number>`count(*)` })
			.from(workItems)
			.where(
				and(
					eq(workItems.orgId, orgId),
					eq(workItems.accountableOwnerType, "tedi"),
					eq(workItems.accountableOwnerId, tediId),
					inArray(workItems.disposition, [...OPEN_WORK_DISPOSITIONS]),
				),
			),
		db
			.select({ count: sql<number>`count(*)` })
			.from(workItems)
			.where(
				and(
					eq(workItems.orgId, orgId),
					eq(workItems.executorType, "tedi"),
					eq(workItems.executorId, tediId),
					inArray(workItems.disposition, [...OPEN_WORK_DISPOSITIONS]),
				),
			),
		db
			.select({ count: sql<number>`count(*)` })
			.from(workAttempts)
			.where(
				and(
					eq(workAttempts.orgId, orgId),
					eq(workAttempts.executorType, "tedi"),
					eq(workAttempts.executorId, tediId),
					inArray(workAttempts.runtimeState, [...LIVE_ATTEMPT_STATES]),
				),
			),
		db
			.select({ count: sql<number>`count(*)` })
			.from(osGadgetExecutions)
			.where(
				and(
					eq(osGadgetExecutions.organizationId, orgId),
					eq(osGadgetExecutions.tediId, tediId),
					inArray(osGadgetExecutions.status, [...LIVE_EXECUTION_STATES]),
				),
			),
		db
			.select({
				scheduleId: skillSchedules.id,
				cron: skillSchedules.cron,
				lastFireAt: skillSchedules.lastFireAt,
				skillTitle: skillEntries.title,
			})
			.from(skillSchedules)
			.innerJoin(skillEntries, eq(skillEntries.id, skillSchedules.skillId))
			.where(
				and(
					eq(skillSchedules.organizationId, orgId),
					eq(skillSchedules.tediId, tediId),
					eq(skillSchedules.enabled, true),
				),
			),
		db
			.select({ count: sql<number>`count(*)` })
			.from(skillEntries)
			.where(
				and(
					eq(skillEntries.organizationId, orgId),
					eq(skillEntries.tediId, tediId),
					ne(skillEntries.lifecycleState, "archived"),
				),
			),
	]);

	const dependents: RowDependent[] = [];
	for (const row of defaultWorkspaces)
		dependents.push({
			key: `workspace:${row.id}`,
			kind: "workspace",
			label: `Answers chat by default in the Workspace "${row.name}"`,
			lastSeenAt: null,
			blocksArchive: true,
		});
	for (const row of ledProjects)
		dependents.push({
			key: `project:${row.id}`,
			kind: "project",
			label: `Leads the project "${row.name}"`,
			lastSeenAt: null,
			blocksArchive: true,
		});
	for (const row of installations)
		dependents.push({
			key: `installation:${row.id}`,
			kind: "installation",
			label: `Primary tedi of an embedded app installation in ${row.customerName} (${row.status})`,
			lastSeenAt: null,
			blocksArchive: true,
		});

	const metadata = organization[0]?.metadata;
	const stewardship = metadata?.workStewardship;
	if (stewardship?.defaultTediId === tediId)
		dependents.push({
			key: "stewardship:default",
			kind: "organization",
			label: "Organization work stewardship uses it as the default steward",
			lastSeenAt: null,
			blocksArchive: true,
		});
	const stewardedProjectIds = Object.entries(stewardship?.projectStewards ?? {})
		.filter(([, stewardId]) => stewardId === tediId)
		.map(([projectId]) => projectId);
	const stewardedKindEntries = Object.entries(
		stewardship?.workKindStewards ?? {},
	).filter(([, stewardId]) => stewardId === tediId);
	const ownedChannel = metadata?.ownedChannel;
	const isChannelPublisher =
		ownedChannel?.publisherTediId === tediId ||
		(tediSlug !== null && ownedChannel?.publisherTediSlug === tediSlug);
	if (stewardedProjectIds.length > 0 || stewardedKindEntries.length > 0) {
		const stewardedProjects = (
			await Promise.all(
				chunkForBoundParams(stewardedProjectIds, 50).map((chunk) =>
					db
						.select({ id: projects.id, name: projects.name })
						.from(projects)
						.where(
							and(
								eq(projects.orgId, orgId),
								// bound-params: chunked by chunkForBoundParams
								inArray(projects.id, chunk),
							),
						),
				),
			)
		).flat();
		const projectNames = new Map(
			stewardedProjects.map((row) => [row.id, row.name]),
		);
		for (const projectId of stewardedProjectIds)
			dependents.push({
				key: `stewardship:project:${projectId}`,
				kind: "organization",
				label: `Work stewardship names it steward of the project "${projectNames.get(projectId) ?? projectId}"`,
				lastSeenAt: null,
				blocksArchive: true,
			});
		for (const [workKind] of stewardedKindEntries)
			dependents.push({
				key: `stewardship:kind:${workKind}`,
				kind: "organization",
				label: `Work stewardship names it steward for Work kind "${workKind}"`,
				lastSeenAt: null,
				blocksArchive: true,
			});
	}
	if (isChannelPublisher)
		dependents.push({
			key: "owned-channel:publisher",
			kind: "organization",
			label: "The organization's owned channel names it as the publishing tedi",
			lastSeenAt: null,
			blocksArchive: true,
		});

	const stewarded = stewardedWork[0]?.count ?? 0;
	if (stewarded > 0)
		dependents.push({
			key: "work:stewarded",
			kind: "work_item",
			label: `Stewards ${countLabel(stewarded, "open Work Item")}`,
			lastSeenAt: null,
			blocksArchive: true,
		});
	const accountable = accountableWork[0]?.count ?? 0;
	if (accountable > 0)
		dependents.push({
			key: "work:accountable",
			kind: "work_item",
			label: `Is the accountable owner of ${countLabel(accountable, "open Work Item")}`,
			lastSeenAt: null,
			blocksArchive: true,
		});
	const executor = executorWork[0]?.count ?? 0;
	if (executor > 0)
		dependents.push({
			key: "work:executor",
			kind: "work_item",
			label: `Is named executor on ${countLabel(executor, "open Work Item")}`,
			lastSeenAt: null,
			blocksArchive: true,
		});
	const attempts = liveAttempts[0]?.count ?? 0;
	if (attempts > 0)
		dependents.push({
			key: "attempts:live",
			kind: "attempt",
			label: `Has ${countLabel(attempts, "live Work Attempt")}`,
			lastSeenAt: null,
			blocksArchive: true,
		});
	const executions = liveExecutions[0]?.count ?? 0;
	if (executions > 0)
		dependents.push({
			key: "executions:live",
			kind: "execution",
			label: `Has ${countLabel(executions, "unfinished app execution")}`,
			lastSeenAt: null,
			blocksArchive: true,
		});
	for (const row of schedules)
		dependents.push({
			key: `schedule:${row.scheduleId}`,
			kind: "schedule",
			label: `Runs the schedule "${row.skillTitle}" (${row.cron})`,
			lastSeenAt: row.lastFireAt,
			blocksArchive: true,
		});
	const skills = ownedSkills[0]?.count ?? 0;
	if (skills > 0)
		dependents.push({
			key: "skills:owned",
			kind: "skill",
			label: `Owns ${countLabel(skills, "skill")}`,
			lastSeenAt: null,
			blocksArchive: false,
		});
	return dependents;
}

async function listProjectDependents(
	db: DbQueryClient,
	orgId: string,
	projectId: string,
): Promise<RowDependent[]> {
	const workItems = coreTable(db, d1WorkItems);
	const projects = coreTable(db, d1Projects);
	const osWorkspaceProjects = coreTable(db, d1OsWorkspaceProjects);
	const osWorkspaces = coreTable(db, d1OsWorkspaces);
	const workAgentSessions = coreTable(db, d1WorkAgentSessions);
	const userConfigs = coreTable(db, d1UserConfigs);
	const organizations = coreTable(db, d1Organizations);
	const workItemSources = coreTable(db, d1WorkItemSources);
	const [
		openWork,
		projectRow,
		linkedWorkspaces,
		agentSessions,
		filingConfigs,
		organization,
		sources,
	] = await db.batch([
		db
			.select({ count: sql<number>`count(*)` })
			.from(workItems)
			.where(
				and(
					eq(workItems.orgId, orgId),
					eq(workItems.projectId, projectId),
					inArray(workItems.disposition, [...OPEN_WORK_DISPOSITIONS]),
				),
			),
		db
			.select({
				id: projects.id,
				name: projects.name,
				metadata: projects.metadata,
			})
			.from(projects)
			.where(and(eq(projects.orgId, orgId), eq(projects.id, projectId)))
			.limit(1),
		db
			.select({
				workspaceId: osWorkspaces.id,
				workspaceName: osWorkspaces.name,
			})
			.from(osWorkspaceProjects)
			.innerJoin(
				osWorkspaces,
				and(
					eq(osWorkspaces.id, osWorkspaceProjects.workspaceId),
					eq(osWorkspaces.status, "active"),
				),
			)
			.where(
				and(
					eq(osWorkspaceProjects.organizationId, orgId),
					eq(osWorkspaceProjects.projectId, projectId),
					eq(osWorkspaceProjects.status, "active"),
				),
			),
		db
			.select({ count: sql<number>`count(*)` })
			.from(workAgentSessions)
			.where(
				and(
					eq(workAgentSessions.organizationId, orgId),
					eq(workAgentSessions.projectId, projectId),
				),
			),
		db
			.select({ userId: userConfigs.userId, value: userConfigs.value })
			.from(userConfigs)
			.where(
				and(
					eq(userConfigs.namespace, `organization:${orgId}`),
					eq(userConfigs.key, "request-auto-filing"),
				),
			),
		db
			.select({ metadata: organizations.metadata })
			.from(organizations)
			.where(eq(organizations.id, orgId))
			.limit(1),
		db
			.select({ count: sql<number>`count(*)` })
			.from(workItemSources)
			.where(
				and(
					eq(workItemSources.orgId, orgId),
					eq(workItemSources.projectId, projectId),
					ne(workItemSources.state, "tombstoned"),
				),
			),
	]);

	const dependents: RowDependent[] = [];
	const open = openWork[0]?.count ?? 0;
	if (open > 0)
		dependents.push({
			key: "work:open",
			kind: "work_item",
			label: `Has ${countLabel(open, "open Work Item")}`,
			lastSeenAt: null,
			blocksArchive: true,
		});
	const project = projectRow[0];
	const factory = project ? readFactoryBinding(project.metadata) : null;
	if (project && factory)
		dependents.push({
			key: `factory:${project.id}`,
			kind: "factory",
			label: `Runs the factory "${factory.name}" on its schedule`,
			lastSeenAt: null,
			blocksArchive: true,
		});
	for (const row of linkedWorkspaces)
		dependents.push({
			key: `workspace:${row.workspaceId}`,
			kind: "workspace",
			label: `Linked to the Workspace "${row.workspaceName}"`,
			lastSeenAt: null,
			blocksArchive: false,
		});
	const sessions = agentSessions[0]?.count ?? 0;
	if (sessions > 0)
		dependents.push({
			key: "sessions:bound",
			kind: "session",
			label: `Has ${countLabel(sessions, "agent session")} bound to it`,
			lastSeenAt: null,
			blocksArchive: false,
		});
	const filingMembers = filingConfigs.filter(
		(row) => row.value.intakeProjectId === projectId,
	).length;
	if (filingMembers > 0)
		dependents.push({
			key: "filing:intake",
			kind: "organization",
			label: `${countLabel(filingMembers, "member", "members")} file requests into it automatically`,
			lastSeenAt: null,
			blocksArchive: true,
		});
	const metadata = organization[0]?.metadata;
	for (const binding of metadata?.sessionProjectBindings ?? []) {
		if (binding.projectId !== projectId) continue;
		dependents.push({
			key: `session-binding:${binding.prefix}`,
			kind: "organization",
			label: `Session prefix "${binding.prefix}" files into it`,
			lastSeenAt: null,
			blocksArchive: true,
		});
	}
	if (metadata?.workStewardship?.projectStewards?.[projectId])
		dependents.push({
			key: "stewardship:project",
			kind: "organization",
			label: "Work stewardship names a steward for this project",
			lastSeenAt: null,
			blocksArchive: false,
		});
	const sourceCount = sources[0]?.count ?? 0;
	if (sourceCount > 0)
		dependents.push({
			key: "sources:attached",
			kind: "source",
			label: `Has ${countLabel(sourceCount, "attached source")}`,
			lastSeenAt: null,
			blocksArchive: false,
		});
	return dependents;
}

type ControlPlaneRevisionTable =
	| typeof d1PolicyPacks
	| typeof d1RuntimeProfiles
	| typeof d1WorkspaceTemplateSets;

/**
 * Control-plane definitions are immutable revision families keyed by
 * `(scope, slug, organizationId)`; archiving any revision archives the
 * family, so a tedi bound to ANY revision counts as a dependent.
 */
async function listControlPlaneFamilyDependents(
	db: DbQueryClient,
	revisionTable: ControlPlaneRevisionTable,
	binding: "policyPackId" | "runtimeProfileId" | "workspaceTemplateSetId",
	noun: string,
	revisionId: string,
): Promise<RowDependent[]> {
	const table = coreTable(db, revisionTable);
	const tedis = coreTable(db, d1Tedis);
	const organizations = coreTable(db, d1Organizations);
	const bindingColumn =
		binding === "policyPackId"
			? tedis.policyPackId
			: binding === "runtimeProfileId"
				? tedis.runtimeProfileId
				: tedis.workspaceTemplateSetId;
	const [source] = await db
		.select({
			scope: table.scope,
			slug: table.slug,
			organizationId: table.organizationId,
		})
		.from(table)
		.where(eq(table.id, revisionId))
		.limit(1);
	if (!source) return [];
	const family = await db
		.select({ id: table.id })
		.from(table)
		.where(
			and(
				eq(table.scope, source.scope),
				eq(table.slug, source.slug),
				source.organizationId === null
					? isNull(table.organizationId)
					: eq(table.organizationId, source.organizationId),
			),
		);
	const revisionIds = family.map((row) => row.id);
	if (revisionIds.length === 0) return [];
	const users = (
		await Promise.all(
			chunkForBoundParams(revisionIds, 50).map((chunk) =>
				db
					.select({
						tediId: tedis.id,
						tediName: sql<string>`coalesce(${tedis.displayName}, ${tedis.name})`,
						organizationName: organizations.name,
					})
					.from(tedis)
					.innerJoin(organizations, eq(organizations.id, tedis.organizationId))
					.where(
						and(
							// bound-params: chunked by chunkForBoundParams
							inArray(bindingColumn, chunk),
							isNull(tedis.retiredAt),
						),
					),
			),
		)
	).flat();
	return users.map((row) => ({
		key: `tedi:${row.tediId}`,
		kind: "tedi" as const,
		label: `Pinned to this ${noun} by the tedi "${row.tediName}" in ${row.organizationName}`,
		lastSeenAt: null,
		blocksArchive: true,
	}));
}

function listPolicyPackDependents(
	db: DbQueryClient,
	packId: string,
): Promise<RowDependent[]> {
	return listControlPlaneFamilyDependents(
		db,
		d1PolicyPacks,
		"policyPackId",
		"policy pack",
		packId,
	);
}

function listRuntimeProfileDependents(
	db: DbQueryClient,
	profileId: string,
): Promise<RowDependent[]> {
	return listControlPlaneFamilyDependents(
		db,
		d1RuntimeProfiles,
		"runtimeProfileId",
		"runtime profile",
		profileId,
	);
}

function listWorkspaceTemplateSetDependents(
	db: DbQueryClient,
	templateSetId: string,
): Promise<RowDependent[]> {
	return listControlPlaneFamilyDependents(
		db,
		d1WorkspaceTemplateSets,
		"workspaceTemplateSetId",
		"workspace template set",
		templateSetId,
	);
}

async function listOutputDependents(
	db: DbQueryClient,
	orgId: string,
	outputId: string,
): Promise<RowDependent[]> {
	const osShareLinks = coreTable(db, d1OsShareLinks);
	const osCollaborationProposals = coreTable(db, d1OsCollaborationProposals);
	const projects = coreTable(db, d1Projects);
	const osReviewBatches = coreTable(db, d1OsReviewBatches);
	const [shares, openProposals, factoryProjects, reviewBatches] =
		await db.batch([
			db
				.select({ count: sql<number>`count(*)` })
				.from(osShareLinks)
				.where(
					and(
						eq(osShareLinks.organizationId, orgId),
						eq(osShareLinks.resourceType, "output"),
						eq(osShareLinks.resourceId, outputId),
						isNull(osShareLinks.revokedAt),
					),
				),
			db
				.select({ count: sql<number>`count(*)` })
				.from(osCollaborationProposals)
				.where(
					and(
						eq(osCollaborationProposals.organizationId, orgId),
						eq(osCollaborationProposals.documentType, "output"),
						eq(osCollaborationProposals.documentId, outputId),
						eq(osCollaborationProposals.status, "open"),
					),
				),
			db
				.select({
					id: projects.id,
					name: projects.name,
					factoryName: jsonRead(db, projects.metadata, ["factory", "name"]),
				})
				.from(projects)
				.where(
					and(
						eq(projects.orgId, orgId),
						eq(projects.status, "active"),
						eq(
							jsonRead(db, projects.metadata, ["factory", "output", "id"]),
							outputId,
						),
					),
				),
			db
				.select({ count: sql<number>`count(*)` })
				.from(osReviewBatches)
				.where(
					and(
						eq(osReviewBatches.organizationId, orgId),
						eq(osReviewBatches.sourceOutputId, outputId),
					),
				),
		]);

	const dependents: RowDependent[] = [];
	const shareCount = shares[0]?.count ?? 0;
	if (shareCount > 0)
		dependents.push({
			key: "shares:active",
			kind: "share_link",
			label: `Has ${countLabel(shareCount, "active share link")}`,
			lastSeenAt: null,
			blocksArchive: true,
		});
	const proposalCount = openProposals[0]?.count ?? 0;
	if (proposalCount > 0)
		dependents.push({
			key: "proposals:open",
			kind: "proposal",
			label: `Has ${countLabel(proposalCount, "open collaboration proposal")}`,
			lastSeenAt: null,
			blocksArchive: true,
		});
	for (const row of factoryProjects)
		dependents.push({
			key: `factory:${row.id}`,
			kind: "factory",
			label: `The factory "${row.factoryName ?? row.name}" writes its summary here`,
			lastSeenAt: null,
			blocksArchive: true,
		});
	const batches = reviewBatches[0]?.count ?? 0;
	if (batches > 0)
		dependents.push({
			key: "reviews:batches",
			kind: "review_batch",
			label: `Has ${countLabel(batches, "review batch")}`,
			lastSeenAt: null,
			blocksArchive: false,
		});
	return dependents;
}

async function listWorkspaceDependents(
	db: DbQueryClient,
	orgId: string,
	workspaceId: string,
): Promise<RowDependent[]> {
	const providerInstallations = coreTable(db, d1ProviderInstallations);
	const organizations = coreTable(db, d1Organizations);
	const osWorkspaceProjects = coreTable(db, d1OsWorkspaceProjects);
	const projects = coreTable(db, d1Projects);
	const osWorkspaces = coreTable(db, d1OsWorkspaces);
	const osShareLinks = coreTable(db, d1OsShareLinks);
	const osCollaborationProposals = coreTable(db, d1OsCollaborationProposals);
	const osGadgets = coreTable(db, d1OsGadgets);
	const workspaceOutputIndex = coreTable(db, d1WorkspaceOutputIndex);
	const [
		installations,
		linkedProjects,
		shares,
		openProposals,
		activeGadgets,
		activeOutputs,
		factoryProjects,
	] = await db.batch([
		db
			.select({
				id: providerInstallations.id,
				status: providerInstallations.status,
				customerName: organizations.name,
			})
			.from(providerInstallations)
			.innerJoin(
				organizations,
				eq(organizations.id, providerInstallations.customerOrganizationId),
			)
			.where(eq(providerInstallations.primaryWorkspaceId, workspaceId)),
		db
			.select({
				projectId: osWorkspaceProjects.projectId,
				name: projects.name,
			})
			.from(osWorkspaceProjects)
			.innerJoin(
				projects,
				and(
					eq(projects.orgId, osWorkspaceProjects.organizationId),
					eq(projects.id, osWorkspaceProjects.projectId),
				),
			)
			.where(
				and(
					eq(osWorkspaceProjects.organizationId, orgId),
					eq(osWorkspaceProjects.workspaceId, workspaceId),
					eq(osWorkspaceProjects.status, "active"),
				),
			),
		db
			.select({ count: sql<number>`count(*)` })
			.from(osShareLinks)
			.where(
				and(
					eq(osShareLinks.organizationId, orgId),
					eq(osShareLinks.resourceType, "workspace"),
					eq(osShareLinks.resourceId, workspaceId),
					isNull(osShareLinks.revokedAt),
				),
			),
		db
			.select({ count: sql<number>`count(*)` })
			.from(osCollaborationProposals)
			.where(
				and(
					eq(osCollaborationProposals.organizationId, orgId),
					eq(osCollaborationProposals.workspaceId, workspaceId),
					eq(osCollaborationProposals.status, "open"),
				),
			),
		db
			.select({ count: sql<number>`count(*)` })
			.from(osGadgets)
			.where(
				and(
					eq(osGadgets.organizationId, orgId),
					eq(osGadgets.workspaceId, workspaceId),
					eq(osGadgets.status, "active"),
				),
			),
		db
			.select({
				count: sql<number>`count(distinct ${workspaceOutputIndex.outputId})`,
			})
			.from(workspaceOutputIndex)
			.where(
				and(
					eq(workspaceOutputIndex.organizationId, orgId),
					eq(workspaceOutputIndex.workspaceId, workspaceId),
					eq(workspaceOutputIndex.isCurrent, 1),
					eq(workspaceOutputIndex.status, "active"),
				),
			),
		db
			.select({
				id: projects.id,
				name: projects.name,
				factoryName: jsonRead(db, projects.metadata, ["factory", "name"]),
			})
			.from(projects)
			.where(
				and(
					eq(projects.orgId, orgId),
					eq(projects.status, "active"),
					eq(
						jsonRead(db, projects.metadata, ["factory", "workspaceId"]),
						workspaceId,
					),
				),
			),
	]);

	const dependents: RowDependent[] = [];
	for (const row of installations)
		dependents.push({
			key: `installation:${row.id}`,
			kind: "installation",
			label: `Primary workspace of an embedded app installation in ${row.customerName} (${row.status})`,
			lastSeenAt: null,
			blocksArchive: true,
		});
	for (const row of linkedProjects)
		dependents.push({
			key: `project:${row.projectId}`,
			kind: "project",
			label: `Linked to the project "${row.name}"`,
			lastSeenAt: null,
			blocksArchive: false,
		});
	const shareCount = shares[0]?.count ?? 0;
	if (shareCount > 0)
		dependents.push({
			key: "shares:active",
			kind: "share_link",
			label: `Has ${countLabel(shareCount, "active share link")}`,
			lastSeenAt: null,
			blocksArchive: true,
		});
	const proposalCount = openProposals[0]?.count ?? 0;
	if (proposalCount > 0)
		dependents.push({
			key: "proposals:open",
			kind: "proposal",
			label: `Has ${countLabel(proposalCount, "open collaboration proposal")}`,
			lastSeenAt: null,
			blocksArchive: true,
		});
	const gadgets = activeGadgets[0]?.count ?? 0;
	if (gadgets > 0)
		dependents.push({
			key: "gadgets:active",
			kind: "gadget",
			label: `Contains ${countLabel(gadgets, "active app")}`,
			lastSeenAt: null,
			blocksArchive: false,
		});
	const outputs = activeOutputs[0]?.count ?? 0;
	if (outputs > 0)
		dependents.push({
			key: "outputs:active",
			kind: "output",
			label: `Holds ${countLabel(outputs, "active output")}`,
			lastSeenAt: null,
			blocksArchive: false,
		});
	for (const row of factoryProjects)
		dependents.push({
			key: `factory:${row.id}`,
			kind: "factory",
			label: `Used by the factory "${row.factoryName ?? row.name}"`,
			lastSeenAt: null,
			blocksArchive: true,
		});
	return dependents;
}

async function listGadgetDependents(
	db: DbQueryClient,
	orgId: string,
	gadgetId: string,
): Promise<RowDependent[]> {
	const osCollaborationProposals = coreTable(db, d1OsCollaborationProposals);
	const osShareLinks = coreTable(db, d1OsShareLinks);
	const osShareSkillReadGrants = coreTable(db, d1OsShareSkillReadGrants);
	const osGadgetExecutions = coreTable(db, d1OsGadgetExecutions);
	const [openProposals, shares, readGrants, liveExecutions] = await db.batch([
		db
			.select({ count: sql<number>`count(*)` })
			.from(osCollaborationProposals)
			.where(
				and(
					eq(osCollaborationProposals.organizationId, orgId),
					eq(osCollaborationProposals.documentType, "gadget"),
					eq(osCollaborationProposals.documentId, gadgetId),
					eq(osCollaborationProposals.status, "open"),
				),
			),
		db
			.select({ count: sql<number>`count(*)` })
			.from(osShareLinks)
			.where(
				and(
					eq(osShareLinks.organizationId, orgId),
					eq(osShareLinks.resourceType, "gadget"),
					eq(osShareLinks.resourceId, gadgetId),
					isNull(osShareLinks.revokedAt),
				),
			),
		db
			.select({ count: sql<number>`count(*)` })
			.from(osShareSkillReadGrants)
			.where(
				and(
					eq(osShareSkillReadGrants.organizationId, orgId),
					eq(osShareSkillReadGrants.gadgetId, gadgetId),
					isNull(osShareSkillReadGrants.revokedAt),
				),
			),
		db
			.select({ count: sql<number>`count(*)` })
			.from(osGadgetExecutions)
			.where(
				and(
					eq(osGadgetExecutions.organizationId, orgId),
					eq(osGadgetExecutions.gadgetId, gadgetId),
					inArray(osGadgetExecutions.status, [...LIVE_EXECUTION_STATES]),
				),
			),
	]);

	const dependents: RowDependent[] = [];
	const proposalCount = openProposals[0]?.count ?? 0;
	if (proposalCount > 0)
		dependents.push({
			key: "proposals:open",
			kind: "proposal",
			label: `Has ${countLabel(proposalCount, "open collaboration proposal")}`,
			lastSeenAt: null,
			blocksArchive: true,
		});
	const shareCount = shares[0]?.count ?? 0;
	if (shareCount > 0)
		dependents.push({
			key: "shares:active",
			kind: "share_link",
			label: `Has ${countLabel(shareCount, "active share link")}`,
			lastSeenAt: null,
			blocksArchive: true,
		});
	const grants = readGrants[0]?.count ?? 0;
	if (grants > 0)
		dependents.push({
			key: "grants:skill-read",
			kind: "share_link",
			label: `Has ${countLabel(grants, "skill read grant")} for shared links`,
			lastSeenAt: null,
			blocksArchive: true,
		});
	const executions = liveExecutions[0]?.count ?? 0;
	if (executions > 0)
		dependents.push({
			key: "executions:live",
			kind: "execution",
			label: `Has ${countLabel(executions, "unfinished execution")}`,
			lastSeenAt: null,
			blocksArchive: true,
		});
	return dependents;
}

/**
 * Everything that points at the row, grouped by what would stop if it were
 * archived, retired or deleted. An empty list means nothing depends on it.
 */
export async function listRowDependents(
	db: DbQueryClient,
	target: RowDependentTarget,
): Promise<RowDependent[]> {
	switch (target.kind) {
		case "tedi": {
			if (!target.orgId) return [];
			return listTediDependents(
				db,
				target.orgId,
				target.id,
				target.slug ?? null,
			);
		}
		case "project": {
			if (!target.orgId) return [];
			return listProjectDependents(db, target.orgId, target.id);
		}
		case "policy_pack":
			return listPolicyPackDependents(db, target.id);
		case "runtime_profile":
			return listRuntimeProfileDependents(db, target.id);
		case "workspace_template_set":
			return listWorkspaceTemplateSetDependents(db, target.id);
		case "output": {
			if (!target.orgId) return [];
			return listOutputDependents(db, target.orgId, target.id);
		}
		case "workspace": {
			if (!target.orgId) return [];
			return listWorkspaceDependents(db, target.orgId, target.id);
		}
		case "gadget": {
			if (!target.orgId) return [];
			return listGadgetDependents(db, target.orgId, target.id);
		}
	}
}

/**
 * The dependents that stop the operation: every one that would break and was
 * not named in `acknowledged`.
 */
export function rowDependentsBlocking(
	dependents: readonly RowDependent[],
	acknowledged: readonly string[] = [],
): RowDependent[] {
	return dependents.filter(
		(dependent) =>
			dependent.blocksArchive && !acknowledged.includes(dependent.key),
	);
}
