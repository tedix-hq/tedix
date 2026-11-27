import { and, eq, isNull } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { coreTable } from "../../core-store/client";
import { selectedStoredColumns } from "./factory-state";
import {
	externalAgentPrincipals as d1ExternalAgentPrincipals,
	externalAgentSessions as d1ExternalAgentSessions,
} from "../../schema/external-agent-identity";
import { organizationMembers as d1OrganizationMembers } from "../../schema/organization-members";
import { projects as d1Projects } from "../../schema/projects";
import { tedis as d1Tedis } from "../../schema/tedis";
import {
	workItems as d1WorkItems,
	workItemStoredColumns,
} from "../../schema/work-items";
import { workCases as d1WorkCases } from "../../schema/work-factory";

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
	const organizationMembers = coreTable(db, d1OrganizationMembers);
	const tedis = coreTable(db, d1Tedis);
	const externalAgentPrincipals = coreTable(db, d1ExternalAgentPrincipals);
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
	const externalAgentSessions = coreTable(db, d1ExternalAgentSessions);
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
	const workItems = coreTable(db, d1WorkItems);
	const row = (
		await db
			.select(selectedStoredColumns(db, d1WorkItems, workItemStoredColumns))
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
	const projects = coreTable(db, d1Projects);
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
	const workCases = coreTable(db, d1WorkCases);
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
