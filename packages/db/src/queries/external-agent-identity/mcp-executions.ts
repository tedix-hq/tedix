import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { DbClient } from "../../client";
import {
	type ExternalAgentAttribution,
	externalAgentAttributions,
	externalAgentMcpCredentials,
	externalAgentSessions,
} from "../../schema/external-agent-identity";
import { ExternalAgentIdentityError } from "./principals";

function stableJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableJson(item)).join(",")}]`;
	}
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "undefined";
}

export async function recordVerifiedExternalAgentMcpExecution(
	db: DbClient,
	input: {
		id: string;
		organizationId: string;
		principalId: string;
		sessionId: string;
		clientRecordId: string;
		targetId: string;
		metadata?: Record<string, JsonValue>;
		occurredAt: string;
	},
): Promise<ExternalAgentAttribution> {
	const {
		provenanceCertification: _untrustedCertification,
		...providedMetadata
	} = input.metadata ?? {};
	const metadata = {
		...providedMetadata,
		externalAgentClientRecordId: input.clientRecordId,
		provenanceCertification: {
			source: "mcp_gateway",
			verifier: "tedix",
		},
	};
	const authorizedCredential = alias(
		externalAgentMcpCredentials,
		"authorized_credential",
	);
	const authorizedSession = alias(externalAgentSessions, "authorized_session");
	const inserted = await db
		.insert(externalAgentAttributions)
		.select(
			db
				.select({
					id: sql<string>`${input.id}`.as("id"),
					organizationId: sql<string>`${input.organizationId}`.as(
						"organization_id",
					),
					principalId: sql<string>`${input.principalId}`.as("principal_id"),
					sessionId: sql<string>`${input.sessionId}`.as("session_id"),
					targetType: sql<"mcp_execution">`'mcp_execution'`.as("target_type"),
					targetId: sql<string>`${input.targetId}`.as("target_id"),
					role: sql<"executor">`'executor'`.as("role"),
					workItemId: sql<null>`NULL`.as("work_item_id"),
					metadata: sql<
						Record<string, JsonValue>
					>`${JSON.stringify(metadata)}`.as("metadata"),
					occurredAt: sql<string>`${input.occurredAt}`.as("occurred_at"),
				})
				.from(authorizedCredential)
				.innerJoin(
					authorizedSession,
					and(
						eq(
							authorizedSession.organizationId,
							authorizedCredential.organizationId,
						),
						eq(authorizedSession.principalId, authorizedCredential.principalId),
						eq(authorizedSession.id, authorizedCredential.sessionId),
					),
				)
				.where(
					and(
						eq(authorizedCredential.organizationId, input.organizationId),
						eq(authorizedCredential.principalId, input.principalId),
						eq(authorizedCredential.sessionId, input.sessionId),
						eq(authorizedCredential.clientRecordId, input.clientRecordId),
						lte(authorizedCredential.issuedAt, input.occurredAt),
						gte(authorizedCredential.expiresAt, input.occurredAt),
						or(
							isNull(authorizedCredential.revokedAt),
							gte(authorizedCredential.revokedAt, input.occurredAt),
						),
						lte(authorizedSession.startedAt, input.occurredAt),
						or(
							isNull(authorizedSession.endedAt),
							gte(authorizedSession.endedAt, input.occurredAt),
						),
					),
				),
		)
		.onConflictDoNothing()
		.returning({ id: externalAgentAttributions.id });
	if (inserted[0]) {
		const created = await db
			.select()
			.from(externalAgentAttributions)
			.where(eq(externalAgentAttributions.id, inserted[0].id))
			.limit(1);
		return created[0]!;
	}
	const rows = await db
		.select()
		.from(externalAgentAttributions)
		.where(
			and(
				eq(externalAgentAttributions.organizationId, input.organizationId),
				eq(externalAgentAttributions.targetType, "mcp_execution"),
				eq(externalAgentAttributions.targetId, input.targetId),
				eq(externalAgentAttributions.role, "executor"),
				eq(externalAgentAttributions.principalId, input.principalId),
			),
		)
		.limit(1);
	const existing = rows[0];
	if (
		existing?.sessionId === input.sessionId &&
		stableJson(existing.metadata) === stableJson(metadata)
	) {
		return existing;
	}
	throw new ExternalAgentIdentityError(
		"credential_inactive",
		"MCP execution was not authorized by this credential at occurrence time",
	);
}
