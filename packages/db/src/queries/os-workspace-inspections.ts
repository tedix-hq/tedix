/**
 * Read-only inspection of a workspace by an organization owner or admin.
 *
 * The inspection is its own audit row (`os.workspace.inspected`): there is no
 * separate grant to forget to record. Whoever wrote such a row for a workspace
 * in the last hour, and is still an active owner or admin of its organization,
 * may read that workspace. Every check rereads both, so a demotion or the end
 * of the hour ends the inspection at the next read.
 */
import {
	OS_WORKSPACE_INSPECTION_ACTION,
	OS_WORKSPACE_INSPECTION_MS,
} from "@tedix/api-contract/schemas/os-workspace-inspections";
import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import type { DbClient } from "../client";
import type { DbQueryClient } from "../query-client";
import { insertAuditEvent } from "./audit";
import { auditEvents } from "../schema/audit-events";
import { organizationMembers } from "../schema/organization-members";
import { osWorkspaces } from "../schema/os-workspaces";

const RESOURCE_TYPE = "os_workspace";

/**
 * Record one inspection. The row is what lets its author read the workspace,
 * so a failed write must fail the request.
 */
export async function recordOsWorkspaceInspection(
	db: DbClient,
	event: {
		organizationId: string;
		workspaceId: string;
		userId: string;
		metadata: Record<string, JsonValue>;
		ipAddress?: string | null;
		userAgent?: string | null;
	},
): Promise<{ id: string; startedAt: Date }> {
	const startedAt = new Date();
	const id = await insertAuditEvent(db, {
		organizationId: event.organizationId,
		actorId: event.userId,
		actorType: "user",
		action: OS_WORKSPACE_INSPECTION_ACTION,
		resourceType: RESOURCE_TYPE,
		resourceId: event.workspaceId,
		metadata: event.metadata,
		ipAddress: event.ipAddress ?? null,
		userAgent: event.userAgent ?? null,
		occurredAt: startedAt,
	});
	return { id, startedAt };
}

/** An active human owner or admin of the organization. */
export async function isOrganizationInspector(
	db: DbQueryClient,
	organizationId: string,
	userId: string,
): Promise<boolean> {
	const [member] = await db
		.select({
			role: organizationMembers.role,
			status: organizationMembers.status,
			kind: organizationMembers.kind,
		})
		.from(organizationMembers)
		.where(
			and(
				eq(organizationMembers.organizationId, organizationId),
				eq(organizationMembers.descopeUserId, userId),
			),
		)
		.limit(1);
	return (
		member?.status === "active" &&
		member.kind === "human" &&
		(member.role === "owner" || member.role === "admin")
	);
}

/**
 * True while `userId` may read this workspace as an inspector: the workspace
 * is active, they are still an active owner or admin, and they recorded an
 * inspection of it within the last hour.
 */
export async function hasActiveOsWorkspaceInspection(
	db: DbQueryClient,
	scope: { organizationId: string; workspaceId: string },
	userId: string,
	now = Date.now(),
): Promise<boolean> {
	if (!userId) return false;
	const [workspace] = await db
		.select({ status: osWorkspaces.status })
		.from(osWorkspaces)
		.where(
			and(
				eq(osWorkspaces.organizationId, scope.organizationId),
				eq(osWorkspaces.id, scope.workspaceId),
			),
		)
		.limit(1);
	if (workspace?.status !== "active") return false;
	if (!(await isOrganizationInspector(db, scope.organizationId, userId)))
		return false;
	const [record] = await db
		.select({ id: auditEvents.id })
		.from(auditEvents)
		.where(
			and(
				eq(auditEvents.organizationId, scope.organizationId),
				eq(auditEvents.resourceType, RESOURCE_TYPE),
				eq(auditEvents.resourceId, scope.workspaceId),
				eq(auditEvents.action, OS_WORKSPACE_INSPECTION_ACTION),
				eq(auditEvents.actorType, "user"),
				eq(auditEvents.actorId, userId),
				gte(auditEvents.timestamp, new Date(now - OS_WORKSPACE_INSPECTION_MS)),
			),
		)
		.limit(1);
	return Boolean(record);
}

/** Every active workspace of the organization, private ones included. */
export async function listOsWorkspacesForInspection(
	db: DbQueryClient,
	organizationId: string,
	limit = 500,
) {
	return db
		.select({
			id: osWorkspaces.id,
			name: osWorkspaces.name,
			visibility: osWorkspaces.visibility,
			ownerName: sql<
				string | null
			>`coalesce(${organizationMembers.name}, ${organizationMembers.email})`.as(
				"owner_name",
			),
		})
		.from(osWorkspaces)
		.leftJoin(
			organizationMembers,
			and(
				eq(organizationMembers.organizationId, osWorkspaces.organizationId),
				eq(organizationMembers.descopeUserId, osWorkspaces.ownerUserId),
			),
		)
		.where(
			and(
				eq(osWorkspaces.organizationId, organizationId),
				eq(osWorkspaces.status, "active"),
			),
		)
		.orderBy(asc(osWorkspaces.name))
		.limit(limit);
}

/** Recorded inspections of one workspace, newest first, with who made them. */
export async function listOsWorkspaceInspections(
	db: DbQueryClient,
	scope: { organizationId: string; workspaceId: string },
	limit = 20,
) {
	return db
		.select({
			id: auditEvents.id,
			at: auditEvents.timestamp,
			inspectorName: sql<
				string | null
			>`coalesce(${organizationMembers.name}, ${organizationMembers.email})`.as(
				"inspector_name",
			),
		})
		.from(auditEvents)
		.leftJoin(
			organizationMembers,
			and(
				eq(organizationMembers.organizationId, auditEvents.organizationId),
				eq(organizationMembers.descopeUserId, auditEvents.actorId),
			),
		)
		.where(
			and(
				eq(auditEvents.organizationId, scope.organizationId),
				eq(auditEvents.resourceType, RESOURCE_TYPE),
				eq(auditEvents.resourceId, scope.workspaceId),
				eq(auditEvents.action, OS_WORKSPACE_INSPECTION_ACTION),
			),
		)
		.orderBy(desc(auditEvents.timestamp), desc(auditEvents.id))
		.limit(limit);
}
