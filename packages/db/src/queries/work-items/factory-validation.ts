import { and, eq, isNull } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import {
	externalAgentPrincipals,
	externalAgentSessions,
} from "../../schema/external-agent-identity";
import { organizationMembers } from "../../schema/organization-members";
import { projects } from "../../schema/projects";
import { tedis } from "../../schema/tedis";
import { workItems } from "../../schema/work-items";
import { workCases, workMilestones } from "../../schema/work-factory";

export class WorkControlError extends Error {
	constructor(
		readonly code:
			| "NOT_FOUND"
			| "CONFLICT"
			| "INVALID_PRINCIPAL"
			| "INVALID_TRANSITION"
			| "NOT_ELIGIBLE"
			| "CAPACITY_EXHAUSTED"
			| "BUDGET_EXHAUSTED",
		message: string,
	) {
		super(`${code}: ${message}`);
		this.name = "WorkControlError";
	}
}

export async function requireActivePrincipal(
	db: DbQueryClient,
	params: {
		orgId: string;
		type: "user" | "tedi" | "external_agent" | "system";
		id: string;
	},
): Promise<void> {
	let found = false;
	if (params.type === "user") {
		found = Boolean(
			(
				await db
					.select({ id: organizationMembers.id })
					.from(organizationMembers)
					.where(
						and(
							eq(organizationMembers.organizationId, params.orgId),
							eq(organizationMembers.userId, params.id),
							eq(organizationMembers.status, "active"),
						),
					)
					.limit(1)
			)[0],
		);
	} else if (params.type === "tedi") {
		found = Boolean(
			(
				await db
					.select({ id: tedis.id })
					.from(tedis)
					.where(
						and(
							eq(tedis.organizationId, params.orgId),
							eq(tedis.id, params.id),
							isNull(tedis.retiredAt),
						),
					)
					.limit(1)
			)[0],
		);
	} else if (params.type === "external_agent") {
		found = Boolean(
			(
				await db
					.select({ id: externalAgentPrincipals.id })
					.from(externalAgentPrincipals)
					.where(
						and(
							eq(externalAgentPrincipals.organizationId, params.orgId),
							eq(externalAgentPrincipals.id, params.id),
							eq(externalAgentPrincipals.status, "active"),
						),
					)
					.limit(1)
			)[0],
		);
	} else {
		found = params.id === "tedix";
	}
	if (!found)
		throw new WorkControlError(
			"INVALID_PRINCIPAL",
			`${params.type}:${params.id} is not active in organization ${params.orgId}`,
		);
}

export async function requireExternalSession(
	db: DbQueryClient,
	params: {
		orgId: string;
		principalId: string;
		sessionId: string;
		externalSessionKey: string;
	},
): Promise<void> {
	const row = (
		await db
			.select({ id: externalAgentSessions.id })
			.from(externalAgentSessions)
			.where(
				and(
					eq(externalAgentSessions.organizationId, params.orgId),
					eq(externalAgentSessions.principalId, params.principalId),
					eq(externalAgentSessions.id, params.sessionId),
					eq(
						externalAgentSessions.externalSessionKey,
						params.externalSessionKey,
					),
					eq(externalAgentSessions.status, "active"),
				),
			)
			.limit(1)
	)[0];
	if (!row)
		throw new WorkControlError(
			"INVALID_PRINCIPAL",
			"External-agent session fence is not active",
		);
}

export async function requireWorkItem(
	db: DbQueryClient,
	orgId: string,
	id: string,
) {
	const row = (
		await db
			.select()
			.from(workItems)
			.where(and(eq(workItems.orgId, orgId), eq(workItems.id, id)))
			.limit(1)
	)[0];
	if (!row)
		throw new WorkControlError("NOT_FOUND", `Work Item ${id} was not found`);
	return row;
}

export async function requireProject(
	db: DbQueryClient,
	orgId: string,
	id: string,
) {
	const row = (
		await db
			.select()
			.from(projects)
			.where(and(eq(projects.orgId, orgId), eq(projects.id, id)))
			.limit(1)
	)[0];
	if (!row)
		throw new WorkControlError("NOT_FOUND", `Project ${id} was not found`);
	return row;
}

export async function requireWorkCase(
	db: DbQueryClient,
	orgId: string,
	id: string,
) {
	const row = (
		await db
			.select()
			.from(workCases)
			.where(and(eq(workCases.orgId, orgId), eq(workCases.id, id)))
			.limit(1)
	)[0];
	if (!row) throw new WorkControlError("NOT_FOUND", `Case ${id} was not found`);
	return row;
}

export async function requireMilestone(
	db: DbQueryClient,
	orgId: string,
	id: string,
) {
	const row = (
		await db
			.select()
			.from(workMilestones)
			.where(and(eq(workMilestones.orgId, orgId), eq(workMilestones.id, id)))
			.limit(1)
	)[0];
	if (!row)
		throw new WorkControlError("NOT_FOUND", `Milestone ${id} was not found`);
	return row;
}
