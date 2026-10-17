import { and, eq, exists, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { agentSessionRequests } from "../../schema/agent-session-requests";
import { externalAgentPrincipals } from "../../schema/external-agent-identity";
import { workAgentSessions } from "../../schema/work-agent-sessions";
import { workInteractions } from "../../schema/work-factory";
import {
	workAttempts,
	type WorkAttempt,
	type WorkItem,
} from "../../schema/work-items";
import { requireActivePrincipal, WorkControlError } from "./factory-validation";

/** Resolve the requester from stored provenance, never a display name or a caller-supplied target. */
export async function prepareLaneHandoff(
	db: DbQueryClient,
	p: {
		work: WorkItem;
		attempt: WorkAttempt;
		nextClick: string;
		requestId?: string;
		now: string;
	},
) {
	const { work, attempt } = p;
	const [origin] = work.sourceIntentId
		? await db
				.select()
				.from(agentSessionRequests)
				.where(
					and(
						eq(agentSessionRequests.organizationId, work.orgId),
						eq(agentSessionRequests.id, work.sourceIntentId),
					),
				)
				.limit(1)
		: [];
	const hostKey = /^(codex|claude-code):/.test(work.sourceSessionKey ?? "")
		? work.sourceSessionKey
		: attempt.externalSessionKey;
	const [session] = hostKey
		? await db
				.select()
				.from(workAgentSessions)
				.where(
					and(
						eq(workAgentSessions.organizationId, work.orgId),
						sql`${workAgentSessions.harness} || ':' || ${workAgentSessions.sessionKey} = ${hostKey}`,
					),
				)
				.limit(1)
		: [];
	const [principal] =
		attempt.executorType === "external_agent"
			? await db
					.select()
					.from(externalAgentPrincipals)
					.where(
						and(
							eq(externalAgentPrincipals.organizationId, work.orgId),
							eq(externalAgentPrincipals.id, attempt.executorId),
							eq(externalAgentPrincipals.credentialBindingType, "owner_user"),
							eq(externalAgentPrincipals.status, "active"),
						),
					)
					.limit(1)
			: [];
	const userId =
		origin?.userId ??
		(hostKey === work.sourceSessionKey ? session?.userId : undefined) ??
		(work.accountableOwnerType === "user" ? work.accountableOwnerId : null) ??
		session?.userId ??
		principal?.credentialBindingId;
	if (!userId)
		throw new WorkControlError(
			"NOT_ELIGIBLE",
			"Lane handoff needs a recorded requesting user",
		);
	await requireActivePrincipal(db, {
		orgId: work.orgId,
		type: "user",
		id: userId,
	});
	const requestId = p.requestId ?? work.sourceIntentId;
	const [request] = requestId
		? await db
				.select()
				.from(agentSessionRequests)
				.where(
					and(
						eq(agentSessionRequests.organizationId, work.orgId),
						eq(agentSessionRequests.userId, userId),
						eq(agentSessionRequests.id, requestId),
					),
				)
				.limit(1)
		: [];
	if (
		(p.requestId && !request) ||
		(request && request.projectId !== work.projectId)
	)
		throw new WorkControlError(
			"NOT_ELIGIBLE",
			"Request must belong to this user and Work project",
		);
	const nextClick = p.nextClick.trim();
	if (!nextClick || nextClick.length > 2_000)
		throw new WorkControlError("NOT_ELIGIBLE", "Supply a bounded next click");
	const key = nextClick.replace(/\s+/g, " ").toLowerCase();
	const [equivalent] = await db
		.select()
		.from(workInteractions)
		.where(
			and(
				eq(workInteractions.orgId, work.orgId),
				eq(workInteractions.workItemId, work.id),
				eq(workInteractions.targetType, "user"),
				eq(workInteractions.targetId, userId),
				eq(workInteractions.status, "open"),
				sql`(${workInteractions.expiresAt} IS NULL OR ${workInteractions.expiresAt}>${p.now})`,
				sql`(coalesce(json_extract(${workInteractions.metadata},'$.laneHandoff.key'),json_extract(${workInteractions.metadata},'$.followThrough.laneHandoff.key'))=${key} OR lower(trim(${workInteractions.prompt}))=${key} OR lower(trim(${workInteractions.subject}))=${key})`,
			),
		)
		.limit(1);
	const hash = new Uint8Array(
		await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(
				JSON.stringify([work.orgId, work.id, userId, key, attempt.id]),
			),
		),
	);
	const hex = [...hash.slice(0, 16)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
	const host = /^(codex|claude-code):(.+)$/.exec(hostKey ?? "");
	const ledgerSession =
		session ?? (host ? { harness: host[1]!, sessionKey: host[2]! } : null);
	return {
		userId,
		request,
		ledgerSession,
		nextClick,
		key,
		interactionId: equivalent?.id ?? id,
		existing: equivalent,
	};
}

/** Statements join the settlement batch. Only its winning version can create the ask or move the ledger. */
export function laneHandoffStatements(
	db: DbQueryClient,
	p: {
		work: WorkItem;
		attempt: WorkAttempt;
		handoff: Awaited<ReturnType<typeof prepareLaneHandoff>>;
		summary?: string;
		now: string;
	},
) {
	const { work, attempt, handoff: h } = p;
	const winner = and(
		eq(workAttempts.orgId, work.orgId),
		eq(workAttempts.id, attempt.id),
		eq(workAttempts.version, attempt.version + 1),
		eq(workAttempts.finishedAt, p.now),
	);
	const equivalent = sql`EXISTS (SELECT 1 FROM work_interactions i WHERE i.org_id=${work.orgId} AND i.work_item_id=${work.id} AND i.target_type='user' AND i.target_id=${h.userId} AND i.status='open' AND (i.expires_at IS NULL OR i.expires_at>${p.now}) AND (coalesce(json_extract(i.metadata,'$.laneHandoff.key'),json_extract(i.metadata,'$.followThrough.laneHandoff.key'))=${h.key} OR lower(trim(i.prompt))=${h.key} OR lower(trim(i.subject))=${h.key}))`;
	const metadata = {
		laneHandoff: {
			key: h.key,
			nextClick: h.nextClick,
			summary: p.summary ?? "Lane result ready.",
			requestId: h.request?.id ?? h.interactionId,
		},
		followThrough: {
			reviewAt: new Date(Date.parse(p.now) + 7 * 86_400_000).toISOString(),
		},
	};
	const insertAsk = db
		.insert(workInteractions)
		.select(
			db
				.select({
					id: sql<string>`${h.interactionId}`.as("id"),
					orgId: workAttempts.orgId,
					workItemId: workAttempts.workItemId,
					kind: sql<string>`'question'`.as("kind"),
					subject: sql<string>`${h.nextClick.slice(0, 300)}`.as("subject"),
					prompt:
						sql<string>`${`${p.summary || "Lane result ready."}\n\nWork: /work/items/${work.id}\n\nNext click: ${h.nextClick}`}`.as(
							"prompt",
						),
					creatorType: workAttempts.executorType,
					creatorId: workAttempts.executorId,
					creatorSessionId: workAttempts.executorSessionId,
					creatorExternalSessionKey: workAttempts.externalSessionKey,
					targetType: sql<string>`'user'`.as("target_type"),
					targetId: sql<string>`${h.userId}`.as("target_id"),
					metadata: sql<string>`${JSON.stringify(metadata)}`.as("metadata"),
					createdAt: sql<string>`${p.now}`.as("created_at"),
				})
				.from(workAttempts)
				.where(and(winner, sql`NOT (${equivalent})`)),
		)
		.onConflictDoNothing();
	const evidence = `/work/interactions/${h.interactionId}`;
	const ledger = h.request
		? db
				.update(agentSessionRequests)
				.set({
					status: "waiting_on_user",
					statusChangedAt: p.now,
					updatedAt: p.now,
					laneRunning: false,
					evidence,
				})
				.where(
					and(
						eq(agentSessionRequests.organizationId, work.orgId),
						eq(agentSessionRequests.userId, h.userId),
						eq(agentSessionRequests.id, h.request.id),
						exists(
							db
								.select({ id: workAttempts.id })
								.from(workAttempts)
								.where(winner),
						),
					),
				)
		: h.ledgerSession
			? db
					.insert(agentSessionRequests)
					.select(
						db
							.select({
								id: sql<string>`${h.interactionId}`.as("id"),
								organizationId: workAttempts.orgId,
								userId: sql<string>`${h.userId}`.as("user_id"),
								harness: sql<string>`${h.ledgerSession.harness}`.as("harness"),
								sessionKey: sql<string>`${h.ledgerSession.sessionKey}`.as(
									"session_key",
								),
								projectId: sql<string | null>`${work.projectId}`.as(
									"project_id",
								),
								kind: sql<string>`'ask'`.as("kind"),
								text: sql<string>`${h.nextClick}`.as("text"),
								status: sql<string>`'waiting_on_user'`.as("status"),
								evidence: sql<string>`${evidence}`.as("evidence"),
								sourceKey: sql<string>`${`lane-handoff:${h.interactionId}`}`.as(
									"source_key",
								),
								sourceAt: sql<string>`${p.now}`.as("source_at"),
								statusChangedAt: sql<string>`${p.now}`.as("status_changed_at"),
							})
							.from(workAttempts)
							.where(winner),
					)
					.onConflictDoNothing()
			: null;
	const adopt =
		h.existing && ["tedi", "external_agent"].includes(h.existing.creatorType)
			? [
					db
						.update(workInteractions)
						.set({
							metadata: sql`json_set(${workInteractions.metadata},'$.followThrough.laneHandoff',json(${JSON.stringify(metadata.laneHandoff)}),'$.followThrough.reviewAt',${metadata.followThrough.reviewAt})`,
						})
						.where(
							and(
								eq(workInteractions.orgId, work.orgId),
								eq(workInteractions.id, h.interactionId),
								eq(workInteractions.status, "open"),
								exists(
									db
										.select({ id: workAttempts.id })
										.from(workAttempts)
										.where(winner),
								),
							),
						),
				]
			: [];
	return [insertAsk, ...adopt, ...(ledger ? [ledger] : [])] as const;
}

/** One morning reminder per unanswered ask per UTC day, using the existing digest surface. */
export async function nudgeLaneHandoffs(db: DbQueryClient, now: string) {
	const hour = new Date(now).getUTCHours();
	if (hour < 8 || hour >= 12) return 0;
	const day = now.slice(0, 10);
	const cutoff = new Date(Date.parse(now) - 86_400_000).toISOString();
	const due = and(
		eq(workInteractions.status, "open"),
		eq(workInteractions.targetType, "user"),
		sql`(json_type(${workInteractions.metadata},'$.laneHandoff')='object' OR json_type(${workInteractions.metadata},'$.followThrough.laneHandoff')='object')`,
		sql`${workInteractions.createdAt}<=${cutoff}`,
		sql`coalesce(json_extract(${workInteractions.metadata},'$.followThrough.lastNudgedDay'),'')<${day}`,
		sql`coalesce(json_extract(${workInteractions.metadata},'$.followThrough.snoozedUntil'),'')<=${now}`,
		sql`json_extract(${workInteractions.metadata},'$.followThrough.reviewAt')>${now}`,
		sql`(${workInteractions.expiresAt} IS NULL OR ${workInteractions.expiresAt}>${now})`,
		sql`NOT EXISTS (SELECT 1 FROM work_items w WHERE w.org_id=${workInteractions.orgId} AND w.id=${workInteractions.workItemId} AND w.disposition IN ('completed','cancelled'))`,
	);
	const rows = await db.select().from(workInteractions).where(due).limit(50);
	let count = 0;
	for (const row of rows) {
		const hash = new Uint8Array(
			await crypto.subtle.digest(
				"SHA-256",
				new TextEncoder().encode(`lane-nudge:${row.id}:${day}`),
			),
		);
		const hex = [...hash.slice(0, 16)]
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
		const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
		const [created] = await db.batch([
			db
				.insert(workInteractions)
				.select(
					db
						.select({
							id: sql<string>`${id}`.as("id"),
							orgId: workInteractions.orgId,
							workItemId: workInteractions.workItemId,
							kind: sql<string>`'coordination'`.as("kind"),
							creatorType: sql<string>`'system'`.as("creator_type"),
							creatorId: sql<string>`'tedix'`.as("creator_id"),
							targetType: workInteractions.targetType,
							targetId: workInteractions.targetId,
							subject:
								sql<string>`substr('Needs you: ' || ${workInteractions.subject},1,300)`.as(
									"subject",
								),
							prompt:
								sql<string>`${`Waiting on you: ${row.subject}\nNext click: /work/interactions/${row.id}\nDone or Snooze 1 day on the original ask.`}`.as(
									"prompt",
								),
							metadata:
								sql<string>`${JSON.stringify({ notification: { state: "digest", requestIds: [row.id] }, laneNudge: { requestId: row.id, day } })}`.as(
									"metadata",
								),
							createdAt: sql<string>`${now}`.as("created_at"),
							expiresAt:
								sql<string>`${new Date(Date.parse(now) + 86_400_000).toISOString()}`.as(
									"expires_at",
								),
						})
						.from(workInteractions)
						.where(
							and(
								due,
								eq(workInteractions.id, row.id),
								eq(workInteractions.orgId, row.orgId),
							),
						),
				)
				.onConflictDoNothing()
				.returning({ id: workInteractions.id }),
			db
				.update(workInteractions)
				.set({
					metadata: sql`json_set(${workInteractions.metadata},'$.followThrough.lastNudgedDay',${day})`,
				})
				.where(
					and(
						eq(workInteractions.orgId, row.orgId),
						eq(workInteractions.id, row.id),
						sql`EXISTS (SELECT 1 FROM work_interactions n WHERE n.org_id=${row.orgId} AND n.id=${id})`,
					),
				),
		]);
		count += created.length;
	}
	return count;
}
