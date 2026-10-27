import { and, asc, eq, isNull, sql, type SQL } from "drizzle-orm";
import {
	ConnectionAccessRequestSchema,
	type ConnectionAccessRequest,
} from "@tedix/api-contract/schemas/connections";
import type { DbQueryClient } from "../query-client";
import { organizationMembers } from "../schema/organization-members";
import { connectionInstances } from "../schema/connection-instances";
import { connectionProviders } from "../schema/connection-providers";
import { organizations } from "../schema/organizations";
import { users } from "../schema/users";
import { tedis } from "../schema/tedis";
import { skillEntries } from "../schema/cognitive";
import {
	workInteractionResponses,
	type WorkInteraction,
} from "../schema/work-factory";
import { createWorkItem, getWorkItemById } from "./work-items/crud";
import {
	createWorkInteraction,
	getWorkInteraction,
} from "./work-items/interactions";
import { personalConnectionGrantsPath } from "./personal-connection-grants";
import { WorkControlError } from "./work-items/factory-validation";

export async function getConnectionAccessOwner(
	db: DbQueryClient,
	input: {
		organizationId: string;
		providerId: string;
		connectionInstanceId?: string;
		personalUserId?: string;
	},
) {
	const instance = input.connectionInstanceId
		? (
				await db
					.select()
					.from(connectionInstances)
					.where(
						and(
							eq(connectionInstances.id, input.connectionInstanceId),
							eq(connectionInstances.providerId, input.providerId),
							input.personalUserId
								? and(
										isNull(connectionInstances.organizationId),
										eq(connectionInstances.ownerUserId, input.personalUserId),
									)
								: eq(connectionInstances.organizationId, input.organizationId),
						),
					)
					.limit(1)
			)[0]
		: undefined;
	if (input.connectionInstanceId && !instance) return undefined;
	const subject = input.personalUserId ?? instance?.ownerUserId;
	const [owner] = await db
		.select({ userId: organizationMembers.userId })
		.from(organizationMembers)
		.where(
			and(
				eq(organizationMembers.organizationId, input.organizationId),
				eq(organizationMembers.status, "active"),
				eq(organizationMembers.kind, "human"),
				subject
					? eq(organizationMembers.descopeUserId, subject)
					: eq(organizationMembers.role, "owner"),
			),
		)
		.orderBy(asc(organizationMembers.id))
		.limit(1);
	return owner?.userId ?? undefined;
}

export async function createConnectionAccessRequest(
	db: DbQueryClient,
	input: ConnectionAccessRequest,
	workItemId?: string | null,
) {
	const request = ConnectionAccessRequestSchema.parse(input);
	const [tedi] = await db
		.select({ name: tedis.name })
		.from(tedis)
		.where(
			and(
				eq(tedis.id, request.tediId),
				eq(tedis.organizationId, request.organizationId),
				isNull(tedis.retiredAt),
			),
		)
		.limit(1);
	if (!tedi) return;
	const key = JSON.stringify(request);
	const hash = Array.from(
		new Uint8Array(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)),
		),
		(byte) => byte.toString(16).padStart(2, "0"),
	).join("");
	const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
	const existing = await getWorkInteraction(db, {
		orgId: request.organizationId,
		interactionId: id,
	});
	if (existing) return existing;
	const [provider] = await db
		.select({ name: connectionProviders.name })
		.from(connectionProviders)
		.where(eq(connectionProviders.descopeAppId, request.providerId))
		.limit(1);
	const [skill] = request.skill
		? await db
				.select({ title: skillEntries.title })
				.from(skillEntries)
				.where(
					and(
						eq(skillEntries.id, request.skill.id),
						eq(skillEntries.organizationId, request.organizationId),
					),
				)
				.limit(1)
		: [];
	const [account] = request.connectionInstanceId
		? await db
				.select({ label: connectionInstances.label })
				.from(connectionInstances)
				.where(
					and(
						eq(connectionInstances.id, request.connectionInstanceId),
						eq(connectionInstances.providerId, request.providerId),
						request.scope === "user"
							? and(
									isNull(connectionInstances.organizationId),
									sql`EXISTS (SELECT 1 FROM ${organizationMembers} WHERE ${organizationMembers.userId}=${request.ownerUserId} AND ${organizationMembers.organizationId}=${request.organizationId} AND ${organizationMembers.descopeUserId}=${connectionInstances.ownerUserId})`,
								)
							: eq(connectionInstances.organizationId, request.organizationId),
					),
				)
				.limit(1)
		: [];
	const connectionName = account?.label ?? provider?.name ?? request.providerId;
	const now = new Date().toISOString();
	const consumer = request.skill
		? `${tedi.name}, running ${skill?.title ?? "a skill"} revision ${request.skill.revision},`
		: tedi.name;
	const prompt = `${consumer} needs your permission to use ${request.scope === "user" ? "your personal" : "the organization’s"} ${connectionName} connection. Approve to allow ${request.skill ? "only this skill revision" : "this tedi"}. Decline to keep access blocked.`;
	let work = workItemId
		? await getWorkItemById(db, workItemId, request.organizationId)
		: null;
	if (!work) {
		// Calls outside a skill run still need a durable Work parent for the inbox.
		work = await getWorkItemById(db, id, request.organizationId);
		if (!work) {
			try {
				work = await createWorkItem(db, {
					id,
					orgId: request.organizationId,
					title: "Connection access",
					description: prompt,
					workKind: "communication",
					riskLevel: "low",
					workClass: "maintenance",
					purposeExceptionExpiresAt: new Date(
						Date.parse(now) + 7 * 86400000,
					).toISOString(),
					accountableOwnerType: "user",
					accountableOwnerId: request.ownerUserId,
					sourceIntentId: `connection-access:${id}`,
					createdAt: now,
				});
			} catch (error) {
				work = await getWorkItemById(db, id, request.organizationId);
				if (!work) throw error;
			}
		}
	}
	return createWorkInteraction(db, {
		id,
		orgId: request.organizationId,
		workItemId: work.id,
		kind: "handoff",
		subject: `${tedi.name} requests connection access`,
		prompt,
		creator: { type: "system", id: "tedix" },
		targetType: "user",
		targetId: request.ownerUserId,
		metadata: {
			connectionAccess: request,
			reason: "Only the connection owner can allow another agent to use it",
		},
		now,
	});
}

/** Run in the same D1 batch as the winning inbox response. */
export async function buildConnectionAccessGrantStatements(
	db: DbQueryClient,
	request: WorkInteraction,
	responseId: string,
	responder: { type: string; id: string },
) {
	const input = ConnectionAccessRequestSchema.parse(
		request.metadata.connectionAccess,
	);
	if (
		request.creatorType !== "system" ||
		request.creatorId !== "tedix" ||
		input.organizationId !== request.orgId ||
		responder.type !== "user" ||
		responder.id !== input.ownerUserId
	)
		throw new WorkControlError(
			"INVALID_PRINCIPAL",
			"Only the connection owner can approve access",
		);
	const [member] = await db
		.select({ subject: organizationMembers.descopeUserId })
		.from(organizationMembers)
		.where(
			and(
				eq(organizationMembers.organizationId, request.orgId),
				eq(organizationMembers.userId, input.ownerUserId),
				eq(organizationMembers.status, "active"),
				eq(organizationMembers.kind, "human"),
			),
		)
		.limit(1);
	if (!member)
		throw new WorkControlError(
			"INVALID_PRINCIPAL",
			"Connection owner is no longer active",
		);
	const owner = await getConnectionAccessOwner(db, {
		...input,
		personalUserId: input.scope === "user" ? member.subject : undefined,
	});
	if (owner !== input.ownerUserId)
		throw new WorkControlError(
			"CONFLICT",
			"Connection ownership changed; request access again",
		);
	const liveConsumer = sql`EXISTS (SELECT 1 FROM ${tedis} WHERE ${tedis.id}=${input.tediId} AND ${tedis.organizationId}=${input.organizationId} AND ${tedis.retiredAt} IS NULL)`;
	const liveSkill = input.skill
		? sql`EXISTS (SELECT 1 FROM ${skillEntries} WHERE ${skillEntries.id}=${input.skill.id} AND ${skillEntries.organizationId}=${input.organizationId} AND ${skillEntries.revision}=${input.skill.revision})`
		: sql`1=1`;
	const liveOwner = sql`EXISTS (SELECT 1 FROM ${organizationMembers} WHERE ${organizationMembers.organizationId}=${input.organizationId} AND ${organizationMembers.userId}=${input.ownerUserId} AND ${organizationMembers.descopeUserId}=${member.subject} AND ${organizationMembers.status}='active' AND ${organizationMembers.kind}='human' ${input.scope === "tenant" && !input.connectionInstanceId ? sql`AND ${organizationMembers.role}='owner'` : sql``})`;
	const liveAccount = input.connectionInstanceId
		? sql`EXISTS (SELECT 1 FROM ${connectionInstances} WHERE ${connectionInstances.id}=${input.connectionInstanceId} AND ${connectionInstances.providerId}=${input.providerId} AND ${connectionInstances.ownerUserId}=${member.subject} AND ${input.scope === "user" ? sql`${connectionInstances.organizationId} IS NULL` : sql`${connectionInstances.organizationId}=${input.organizationId}`})`
		: sql`1=1`;
	const valid = and(liveConsumer, liveSkill, liveOwner, liveAccount)!;
	const receipt = sql`EXISTS (SELECT 1 FROM ${workInteractionResponses} WHERE ${workInteractionResponses.orgId}=${request.orgId} AND ${workInteractionResponses.id}=${responseId} AND ${workInteractionResponses.interactionId}=${request.id} AND ${workInteractionResponses.responderType}='user' AND ${workInteractionResponses.responderId}=${input.ownerUserId} AND ${workInteractionResponses.responseKind}='handoff_accepted' AND ${workInteractionResponses.resolvesRequest}=1)`;
	const table = input.scope === "user" ? users : organizations;
	const capacities: SQL[] = [];
	const statements = [
		undefined,
		...(input.connectionInstanceId ? [input.connectionInstanceId] : []),
	].map((instanceId) => {
		const path =
			input.scope === "user"
				? personalConnectionGrantsPath(
						input.organizationId,
						input.providerId,
						instanceId,
					)
				: `$.connectionConsumerGrants."${encodeURIComponent(input.providerId)}:${encodeURIComponent(instanceId ?? "")}"`;
		const arrayPath = `${path}.${input.skill ? "skills" : "tediIds"}`;
		const consumer = input.skill
			? JSON.stringify(input.skill)
			: JSON.stringify(input.tediId);
		const same = input.skill
			? sql`json_extract(value, '$.id')=${input.skill.id} AND json_extract(value, '$.revision')=${input.skill.revision}`
			: sql`value=${input.tediId}`;
		capacities.push(
			sql`EXISTS (SELECT 1 FROM ${table} WHERE ${table.id}=${input.scope === "user" ? input.ownerUserId : input.organizationId} AND (json_extract(${table.metadata}, ${`${path}.mode`}) IS NULL OR json_extract(${table.metadata}, ${`${path}.mode`})='all' OR (json_array_length(json_extract(${table.metadata}, ${arrayPath}))<100 OR EXISTS (SELECT 1 FROM json_each(json_extract(${table.metadata}, ${arrayPath})) WHERE ${same}))))`,
		);
		return db
			.update(table)
			.set({
				metadata: sql`json_insert(${table.metadata}, ${`${arrayPath}[#]`}, json(${consumer}))`,
				updatedAt: new Date().toISOString(),
			})
			.where(
				and(
					eq(
						table.id,
						input.scope === "user" ? input.ownerUserId : input.organizationId,
					),
					receipt,
					valid,
					sql`json_extract(${table.metadata}, ${`${path}.mode`})='selected'`,
					sql`NOT EXISTS (SELECT 1 FROM json_each(json_extract(${table.metadata}, ${arrayPath})) WHERE ${same})`,
				),
			);
	});
	return { statements, valid: and(valid, ...capacities)! };
}
