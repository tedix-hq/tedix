import { and, asc, eq, exists, notInArray, sql } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import {
	supportConfiguration,
	supportTickets,
	type SupportTicketRow,
} from "../schema/support";
import { projects } from "../schema/projects";
import { workItems, workEvents, workItemComments } from "../schema/work-items";
import type { SupportConfiguration } from "@tedix/api-contract/schemas/support";

/** Installation singleton, read only by the reviewed support bridge handlers. */
export async function getSupportConfiguration(db: DbQueryClient) {
	return (
		(
			await db
				.select()
				.from(supportConfiguration)
				.where(eq(supportConfiguration.id, "default"))
				.limit(1)
		)[0]?.configuration ?? null
	);
}
export async function putSupportConfiguration(
	db: DbQueryClient,
	configuration: SupportConfiguration,
	now: string,
) {
	await db
		.insert(supportConfiguration)
		.values({ id: "default", configuration, updatedAt: now })
		.onConflictDoUpdate({
			target: supportConfiguration.id,
			set: { configuration, updatedAt: now },
		});
}
export async function ensureSupportProject(
	db: DbQueryClient,
	p: {
		id: string;
		orgId: string;
		key: string;
		ownerTediId?: string;
		now: string;
	},
) {
	await db
		.insert(projects)
		.values({
			id: p.id,
			orgId: p.orgId,
			key: p.key,
			name: "Support",
			leadTediId: p.ownerTediId,
			createdAt: p.now,
		})
		.onConflictDoNothing();
	const row = (
		await db
			.select()
			.from(projects)
			.where(and(eq(projects.orgId, p.orgId), eq(projects.key, p.key)))
			.limit(1)
	)[0];
	if (!row || row.status !== "active")
		throw new Error("Support project is unavailable");
	return row;
}
export async function getSupportTicket(
	db: DbQueryClient,
	orgId: string,
	id: string,
	reporterKey?: string,
) {
	return (
		(
			await db
				.select()
				.from(supportTickets)
				.where(
					and(
						eq(supportTickets.orgId, orgId),
						eq(supportTickets.id, id),
						reporterKey
							? eq(supportTickets.reporterKey, reporterKey)
							: undefined,
					),
				)
				.limit(1)
		)[0] ?? null
	);
}
/** Ticket-scoped staff read. The caller must be the configured Support tedi/admin. */
export async function getStaffSupportTicket(
	db: DbQueryClient,
	platformOrgId: string,
	id: string,
) {
	return (
		(
			await db
				.select()
				.from(supportTickets)
				.where(
					and(
						eq(supportTickets.platformOrgId, platformOrgId),
						eq(supportTickets.id, id),
					),
				)
				.limit(1)
		)[0] ?? null
	);
}
export async function listSupportTickets(
	db: DbQueryClient,
	p: {
		orgId: string;
		reporterKey?: string;
		staff?: boolean;
		includeClosed?: boolean;
		limit: number;
	},
) {
	return db
		.select()
		.from(supportTickets)
		.where(
			and(
				p.staff
					? eq(supportTickets.platformOrgId, p.orgId)
					: eq(supportTickets.orgId, p.orgId),
				p.reporterKey
					? eq(supportTickets.reporterKey, p.reporterKey)
					: undefined,
				p.staff && !p.includeClosed
					? notInArray(supportTickets.status, [
							"resolved",
							"closed-without-confirmation",
						])
					: undefined,
			),
		)
		.orderBy(asc(supportTickets.nextUpdateDue))
		.limit(p.limit);
}
export async function createSupportTicket(
	db: DbQueryClient,
	ticket: typeof supportTickets.$inferInsert,
) {
	await db.batch([
		db
			.insert(workItems)
			.values({
				id: ticket.workItemId,
				orgId: ticket.orgId,
				projectId: ticket.projectId,
				title: ticket.report.title,
				description: JSON.stringify(ticket.report),
				workKind: "operations",
				disposition: "accepted",
				riskLevel: "low",
				workClass: "maintenance",
				acceptanceContract: {
					version: 1,
					doneLooksLike:
						"Provide a cited answer or a clear next step; record the reporter's retest separately.",
				},
				sourceIntentId: `support:${ticket.id}`,
				createdAt: ticket.createdAt,
				acceptedAt: ticket.createdAt,
			})
			.onConflictDoNothing(),
		db.insert(supportTickets).values(ticket).onConflictDoNothing(),
	]);
	return getSupportTicket(db, ticket.orgId, ticket.id);
}
/** Idempotent outbox delivery: only consented fields enter platform Work. */
export async function deliverSupportMirror(
	db: DbQueryClient,
	ticket: SupportTicketRow,
	p: { projectId: string; tediId: string; eventId: string; now: string },
) {
	await db.batch([
		db
			.insert(workItems)
			.values({
				id: ticket.mirrorWorkItemId,
				orgId: ticket.platformOrgId,
				projectId: p.projectId,
				title: ticket.report.title,
				description: JSON.stringify({
					supportId: ticket.id,
					report: ticket.report,
				}),
				workKind: "operations",
				disposition: "accepted",
				riskLevel: "low",
				workClass: "maintenance",
				accountableOwnerType: "tedi",
				accountableOwnerId: p.tediId,
				deadline: ticket.nextUpdateDue,
				acceptanceContract: {
					version: 1,
					doneLooksLike:
						"Triage this consented support ticket. Draft a cited answer or escalate with a clear next step. Human replies require the designated admin to publish.",
				},
				sourceIntentId: `support-mirror:${ticket.id}`,
				createdAt: ticket.createdAt,
				acceptedAt: ticket.createdAt,
			})
			.onConflictDoNothing(),
		db.insert(workEvents).select(
			db
				.select({
					id: sql<string>`${p.eventId}`.as("id"),
					orgId: sql<string>`${ticket.platformOrgId}`.as("org_id"),
					workItemId: sql<string>`${ticket.mirrorWorkItemId}`.as(
						"work_item_id",
					),
					attemptId: sql<null>`NULL`.as("attempt_id"),
					eventType: sql<string>`'work.accepted'`.as("event_type"),
					actorType: sql<"system">`'system'`.as("actor_type"),
					actorId: sql<string>`'support-intake'`.as("actor_id"),
					actorSessionId: sql<null>`NULL`.as("actor_session_id"),
					payload: sql`'{}'`.as("payload"),
					occurredAt: sql<string>`${p.now}`.as("occurred_at"),
				})
				.from(supportTickets)
				.where(
					and(
						eq(supportTickets.orgId, ticket.orgId),
						eq(supportTickets.id, ticket.id),
						eq(supportTickets.mirrorDelivery, "pending"),
					),
				),
		),
		db
			.update(supportTickets)
			.set({ mirrorDelivery: "delivered" })
			.where(
				and(
					eq(supportTickets.orgId, ticket.orgId),
					eq(supportTickets.id, ticket.id),
				),
			),
	]);
}
export async function listPendingSupportMirrors(
	db: DbQueryClient,
	platformOrgId: string,
) {
	return db
		.select()
		.from(supportTickets)
		.where(
			and(
				eq(supportTickets.platformOrgId, platformOrgId),
				eq(supportTickets.mirrorDelivery, "pending"),
			),
		)
		.orderBy(asc(supportTickets.createdAt))
		.limit(50);
}

/** CAS + keyed comments/events share one D1 transaction. A losing writer emits nothing. */
export async function updateSupportTicket(
	db: DbQueryClient,
	old: SupportTicketRow,
	p: {
		key: string;
		actorId: string;
		actorType: "user" | "tedi" | "external_agent" | "system";
		now: string;
		patch: Partial<
			Pick<
				SupportTicketRow,
				| "report"
				| "consentReference"
				| "payloadDigest"
				| "draft"
				| "status"
				| "publicUpdates"
				| "reporterVerification"
				| "nextUpdateDue"
				| "escalationWorkItemId"
				| "interactionId"
			>
		>;
		commentId: string;
		commentBody: string;
		publicComment?: boolean;
		eventId: string;
	},
) {
	if (old.updateKeys.includes(p.key)) return old;
	if (old.updateKeys.length >= 200)
		throw new Error("Support ticket update limit reached");
	const guard = and(
		eq(supportTickets.orgId, old.orgId),
		eq(supportTickets.id, old.id),
		eq(supportTickets.version, old.version + 1),
		sql`json_extract(${supportTickets.updateKeys}, '$[#-1]') = ${p.key}`,
		sql`NOT EXISTS (SELECT 1 FROM work_events WHERE id = ${p.eventId})`,
	);
	const workId = p.publicComment ? old.workItemId : old.mirrorWorkItemId;
	const orgId = p.publicComment ? old.orgId : old.platformOrgId;
	const [changed] = await db.batch([
		db
			.update(supportTickets)
			.set({
				...p.patch,
				version: old.version + 1,
				updateKeys: [...old.updateKeys, p.key],
				updatedAt: p.now,
			})
			.where(
				and(
					eq(supportTickets.orgId, old.orgId),
					eq(supportTickets.id, old.id),
					eq(supportTickets.version, old.version),
				),
			)
			.returning(),
		...[
			{ orgId: old.orgId, id: old.workItemId },
			{ orgId: old.platformOrgId, id: old.mirrorWorkItemId },
		].map((work) =>
			db
				.update(workItems)
				.set({
					disposition:
						(p.patch.status ?? old.status) === "resolved"
							? "completed"
							: "accepted",
					completedAt:
						(p.patch.status ?? old.status) === "resolved" ? p.now : null,
					deadline: p.patch.nextUpdateDue ?? old.nextUpdateDue,
					title: p.patch.report?.title,
					description: p.patch.report
						? JSON.stringify(p.patch.report)
						: undefined,
					updatedAt: p.now,
					version: sql`${workItems.version}+1`,
				})
				.where(
					and(
						eq(workItems.orgId, work.orgId),
						eq(workItems.id, work.id),
						exists(
							db
								.select({ id: supportTickets.id })
								.from(supportTickets)
								.where(guard),
						),
					),
				),
		),
		db
			.insert(workItemComments)
			.select(
				db
					.select({
						id: sql<string>`${p.commentId}`.as("id"),
						workItemId: sql<string>`${workId}`.as("work_item_id"),
						orgId: sql<string>`${orgId}`.as("org_id"),
						authorType: sql<typeof p.actorType>`${p.actorType}`.as(
							"author_type",
						),
						authorId: sql<string>`${p.actorId}`.as("author_id"),
						body: sql<string>`${p.commentBody}`.as("body"),
						metadata: sql`'{}'`.as("metadata"),
						createdAt: sql<string>`${p.now}`.as("created_at"),
					})
					.from(supportTickets)
					.where(guard),
			)
			.onConflictDoNothing(),
		db
			.insert(workEvents)
			.select(
				db
					.select({
						id: sql<string>`${p.eventId}`.as("id"),
						orgId: sql<string>`${old.platformOrgId}`.as("org_id"),
						workItemId: sql<string>`${old.mirrorWorkItemId}`.as("work_item_id"),
						attemptId: sql<null>`NULL`.as("attempt_id"),
						eventType: sql<string>`'work.specification_updated'`.as(
							"event_type",
						),
						actorType: sql<typeof p.actorType>`${p.actorType}`.as("actor_type"),
						actorId: sql<string>`${p.actorId}`.as("actor_id"),
						actorSessionId: sql<null>`NULL`.as("actor_session_id"),
						payload: sql`'{}'`.as("payload"),
						occurredAt: sql<string>`${p.now}`.as("occurred_at"),
					})
					.from(supportTickets)
					.where(and(guard, eq(supportTickets.mirrorDelivery, "delivered"))),
			)
			.onConflictDoNothing(),
	]);
	return changed[0] ?? null;
}
