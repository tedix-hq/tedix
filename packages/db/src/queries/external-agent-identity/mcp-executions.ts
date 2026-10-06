import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, eq, sql } from "drizzle-orm";
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
	const inserted = (await db.all(sql`
		INSERT INTO ${externalAgentAttributions} (
			id, organization_id, principal_id, session_id, target_type,
			target_id, role, work_item_id, metadata, occurred_at
		)
		SELECT
			${input.id}, ${input.organizationId}, ${input.principalId},
			${input.sessionId}, 'mcp_execution', ${input.targetId}, 'executor',
			NULL, ${JSON.stringify(metadata)}, ${input.occurredAt}
		FROM ${externalAgentMcpCredentials} AS authorized_credential
		JOIN ${externalAgentSessions} AS authorized_session
			ON authorized_session.organization_id = authorized_credential.organization_id
			AND authorized_session.principal_id = authorized_credential.principal_id
			AND authorized_session.id = authorized_credential.session_id
		WHERE authorized_credential.organization_id = ${input.organizationId}
			AND authorized_credential.principal_id = ${input.principalId}
			AND authorized_credential.session_id = ${input.sessionId}
			AND authorized_credential.client_record_id = ${input.clientRecordId}
			AND authorized_credential.issued_at <= ${input.occurredAt}
			AND authorized_credential.expires_at >= ${input.occurredAt}
			AND (
				authorized_credential.revoked_at IS NULL
				OR authorized_credential.revoked_at >= ${input.occurredAt}
			)
			AND authorized_session.started_at <= ${input.occurredAt}
			AND (
				authorized_session.ended_at IS NULL
				OR authorized_session.ended_at >= ${input.occurredAt}
			)
		ON CONFLICT DO NOTHING
		RETURNING id
	`)) as Array<{ id: string }>;
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
