import { anyIds } from "../core-store/dialect";
import { coreTable } from "../core-store/client";
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
import {
	auditReadColumns,
	auditReadTable,
	readAuditStores,
} from "./audit-delivery";
import { compareTimestampId, mergeLogStoreRows } from "../utils/log-store";
import { organizationMembers as schemaOrganizationMembers } from "../schema/organization-members";
import { osWorkspaces as schemaOsWorkspaces } from "../schema/os-workspaces";

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
	const organizationMembers = coreTable(db, schemaOrganizationMembers);
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
	const osWorkspaces = coreTable(db, schemaOsWorkspaces);
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
	const records = await inspectionEvents(db, scope, 1, {
		userId,
		since: new Date(now - OS_WORKSPACE_INSPECTION_MS),
	});
	const record = records[0];
	return Boolean(record);
}

/** Every active workspace of the organization, private ones included. */
export async function listOsWorkspacesForInspection(
	db: DbQueryClient,
	organizationId: string,
	limit = 500,
) {
	const osWorkspaces = coreTable(db, schemaOsWorkspaces);
	const organizationMembers = coreTable(db, schemaOrganizationMembers);
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
	const events = await inspectionEvents(db, scope, limit);
	if (!events.length) return [];
	const organizationMembers = coreTable(db, schemaOrganizationMembers);
	const members = await db
		.select({
			id: organizationMembers.descopeUserId,
			name: organizationMembers.name,
			email: organizationMembers.email,
		})
		.from(organizationMembers)
		.where(
			and(
				eq(organizationMembers.organizationId, scope.organizationId),
				anyIds(
					db,
					organizationMembers.descopeUserId,
					events.map((event) => event.actorId),
				),
			),
		);
	const names = new Map(
		members.map((member) => [member.id, member.name ?? member.email]),
	);
	return events.map((event) => ({
		id: event.id,
		at: event.timestamp,
		inspectorName: names.get(event.actorId) ?? null,
	}));
}

async function inspectionEvents(
	db: DbQueryClient,
	scope: { organizationId: string; workspaceId: string },
	limit: number,
	filter?: { userId: string; since: Date },
) {
	const read = async (store: DbQueryClient) => {
		const auditEvents = auditReadTable(store);
		return store
			.select(auditReadColumns(store))
			.from(auditEvents)
			.where(
				and(
					eq(auditEvents.organizationId, scope.organizationId),
					eq(auditEvents.resourceType, RESOURCE_TYPE),
					eq(auditEvents.resourceId, scope.workspaceId),
					eq(auditEvents.action, OS_WORKSPACE_INSPECTION_ACTION),
					filter
						? and(
								eq(auditEvents.actorType, "user"),
								eq(auditEvents.actorId, filter.userId),
								gte(auditEvents.timestamp, filter.since),
							)
						: undefined,
				),
			)
			.orderBy(desc(auditEvents.timestamp), desc(auditEvents.id))
			.limit(limit);
	};
	const pages = await readAuditStores(db, read);
	return pages
		? mergeLogStoreRows(pages, { compare: compareTimestampId("desc"), limit })
		: read(db);
}
