import { DatabaseSync } from "node:sqlite";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import { workAttempts } from "../schema/work-items";
import { createD1Facade } from "../test/d1-facade";
import {
	recordExternalAgentAttribution,
	resolveExternalAgentAttributionStamp,
} from "./external-agent-identity/attribution";
import { getExternalAgentContextualReputation } from "./external-agent-identity/contextual-reputation";
import {
	endExternalAgentSession,
	recordExternalAgentKnowledgeCheckpoint,
	recordExternalAgentKnowledgeDisposition,
} from "./external-agent-identity/knowledge-lifecycle";
import {
	acquireExternalAgentMcpIssuanceLease,
	listActiveExternalAgentMcpCredentials,
	refreshExternalAgentMcpCredentialUnderLease,
	recordExternalAgentMcpCredential,
	recordExternalAgentMcpCredentialUnderLease,
	releaseExternalAgentMcpIssuanceLease,
	resolveAuthorizedExternalAgentMcpSession,
	revokeExternalAgentMcpCredential,
} from "./external-agent-identity/mcp-credentials";
import { recordVerifiedExternalAgentMcpExecution } from "./external-agent-identity/mcp-executions";
import {
	createExternalAgentPrincipal,
	type ExternalAgentIdentityError,
	setExternalAgentPrincipalStatus,
} from "./external-agent-identity/principals";
import {
	recordExternalAgentReviewEvidence,
	remediateExternalAgentReviewEvidence,
} from "./external-agent-identity/review-evidence";
import {
	hasExternalAgentSessionWorkAttempt,
	hasExternalAgentWorkAttempt,
	heartbeatExternalAgentSession,
	openExternalAgentSession,
	resolveActiveExternalAgentSession,
} from "./external-agent-identity/sessions";

const DDL = `
CREATE TABLE external_agent_principals (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, key TEXT NOT NULL,
 display_name TEXT NOT NULL, status TEXT NOT NULL,
 credential_binding_type TEXT NOT NULL, credential_binding_id TEXT NOT NULL,
 created_by_type TEXT NOT NULL, created_by_id TEXT NOT NULL, metadata TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uniq_external_agent_principal_key
 ON external_agent_principals (organization_id, key);
CREATE UNIQUE INDEX uniq_external_agent_credential_binding
 ON external_agent_principals
 (organization_id, credential_binding_type, credential_binding_id);
CREATE TABLE external_agent_sessions (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, principal_id TEXT NOT NULL,
 external_session_key TEXT NOT NULL, harness TEXT NOT NULL,
 harness_version TEXT NOT NULL, model_provider TEXT NOT NULL,
 model_id TEXT NOT NULL, model_version TEXT NOT NULL,
 identity_source TEXT NOT NULL, status TEXT NOT NULL,
 credit_eligible INTEGER NOT NULL, started_at TEXT NOT NULL,
 last_seen_at TEXT NOT NULL, ended_at TEXT, metadata TEXT NOT NULL
);
CREATE TABLE work_attempts (id TEXT PRIMARY KEY, admission_id TEXT, work_item_id TEXT NOT NULL, org_id TEXT NOT NULL, executor_type TEXT NOT NULL, executor_id TEXT NOT NULL, executor_session_id TEXT, external_session_key TEXT, run_id TEXT, runtime_state TEXT NOT NULL DEFAULT 'running', outcome TEXT, attempt_number INTEGER NOT NULL DEFAULT 1, started_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL, expires_at TEXT, finished_at TEXT, summary TEXT, version INTEGER NOT NULL DEFAULT 1, metadata TEXT NOT NULL DEFAULT '{}');
CREATE UNIQUE INDEX uniq_external_agent_session_key
 ON external_agent_sessions (organization_id, harness, external_session_key);
CREATE TABLE external_agent_mcp_credentials (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, principal_id TEXT NOT NULL,
 session_id TEXT NOT NULL, client_record_id TEXT NOT NULL,
 mcp_server_id TEXT NOT NULL, mcp_server_url TEXT NOT NULL,
 status TEXT NOT NULL, issued_at TEXT NOT NULL, expires_at TEXT NOT NULL,
 revoked_at TEXT
);
CREATE UNIQUE INDEX uniq_external_agent_mcp_client_record
 ON external_agent_mcp_credentials (client_record_id);
CREATE TABLE external_agent_mcp_issuance_leases (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, principal_id TEXT NOT NULL,
 session_id TEXT NOT NULL, mcp_server_id TEXT NOT NULL, owner_token TEXT NOT NULL,
 expires_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uniq_external_agent_mcp_issuance_lease_target
 ON external_agent_mcp_issuance_leases
 (organization_id, principal_id, session_id, mcp_server_id);
CREATE TABLE external_agent_attributions (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, principal_id TEXT NOT NULL,
 session_id TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
 role TEXT NOT NULL, work_item_id TEXT, metadata TEXT NOT NULL,
 occurred_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uniq_external_agent_attribution
 ON external_agent_attributions
 (organization_id, target_type, target_id, role, principal_id);
CREATE TABLE external_agent_review_evidence (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL,
 execution_attribution_id TEXT NOT NULL, subject_principal_id TEXT NOT NULL,
 subject_session_id TEXT NOT NULL, reviewer_principal_type TEXT NOT NULL,
 reviewer_principal_id TEXT NOT NULL, reviewer_session_id TEXT,
 target_type TEXT NOT NULL, target_id TEXT NOT NULL, work_item_id TEXT,
 task_family TEXT NOT NULL, repository_key TEXT NOT NULL,
 repository_version TEXT NOT NULL, risk_level TEXT NOT NULL,
 environment TEXT NOT NULL, outcome TEXT NOT NULL, score REAL NOT NULL,
 policy_violation_severity INTEGER NOT NULL, review_method TEXT NOT NULL,
 evidence_refs TEXT NOT NULL, context_hash TEXT NOT NULL,
 resolution_status TEXT NOT NULL, resolution_evidence_ref TEXT,
 resolved_by_type TEXT, resolved_by_id TEXT, resolved_at TEXT,
 occurred_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uniq_external_agent_review_principal_execution
 ON external_agent_review_evidence
 (organization_id, execution_attribution_id, reviewer_principal_type,
  reviewer_principal_id);
`;

const ORG = "00000000-0000-4000-8000-000000000001";
const NOW = "2026-07-20T00:00:00.000Z";
const LATER = "2026-07-20T00:05:00.000Z";

function fixture(onPrepare?: (query: string) => void): DbClient {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(DDL);
	return createDbClient(createD1Facade(sqlite, { onPrepare }));
}

async function principal(
	db: DbClient,
	id = "00000000-0000-4000-8000-000000000010",
) {
	return createExternalAgentPrincipal(db, {
		id,
		organizationId: ORG,
		key: "codex-primary",
		displayName: "Codex primary",
		credentialBindingType: "api_key",
		credentialBindingId: "key-1",
		createdByType: "user",
		createdById: "owner-1",
		createdAt: NOW,
	});
}

function sessionInput(principalId: string) {
	return {
		id: "00000000-0000-4000-8000-000000000020",
		organizationId: ORG,
		principalId,
		externalSessionKey: "codex:thread-1",
		harness: "codex",
		harnessVersion: "26.715",
		modelProvider: "openai",
		modelId: "gpt-5.6",
		modelVersion: "2026-07-20",
		identitySource: "native" as const,
		startedAt: NOW,
	};
}

const REVIEW_CONTEXT = {
	taskFamily: "typescript-change",
	repositoryKey: "github:tedix/tedix",
	repositoryVersion: "sha:abc123",
	riskLevel: "high" as const,
	environment: "production",
};

async function execution(
	db: DbClient,
	options: {
		principalId?: string;
		sessionId?: string;
		id?: string;
		targetId?: string;
		occurredAt?: string;
	} = {},
) {
	return recordExternalAgentAttribution(db, {
		id: options.id ?? "00000000-0000-4000-8000-000000000030",
		organizationId: ORG,
		principalId: options.principalId ?? "00000000-0000-4000-8000-000000000010",
		sessionId: options.sessionId ?? "00000000-0000-4000-8000-000000000020",
		targetType: "mcp_execution",
		targetId: options.targetId ?? "execution-1",
		role: "executor",
		metadata: { reputationContext: REVIEW_CONTEXT },
		certificationSource: "mcp_gateway",
		occurredAt: options.occurredAt ?? NOW,
	});
}

function reviewInput(
	executionAttributionId: string,
	overrides: Partial<
		Parameters<typeof recordExternalAgentReviewEvidence>[1]
	> = {},
) {
	return {
		id: crypto.randomUUID(),
		organizationId: ORG,
		executionAttributionId,
		reviewerPrincipalType: "user" as const,
		reviewerPrincipalId: "reviewer-1",
		context: REVIEW_CONTEXT,
		outcome: "success" as const,
		score: 1,
		policyViolationSeverity: 0,
		reviewMethod: "independent-reproduction",
		evidenceRefs: ["artifact://review-1"],
		occurredAt: NOW,
		...overrides,
	};
}

describe("external-agent identity", () => {
	it("matches knowledge Work Item checkouts by the full external-agent identity", async () => {
		const db = fixture();
		await db.insert(workAttempts).values({
			id: "00000000-0000-4000-8000-000000000096",
			workItemId: "00000000-0000-4000-8000-000000000099",
			orgId: ORG,
			executorType: "external_agent",
			executorId: "00000000-0000-4000-8000-000000000010",
			executorSessionId: "00000000-0000-4000-8000-000000000020",
			runtimeState: "finished",
			outcome: "succeeded",
			attemptNumber: 1,
			startedAt: NOW,
			heartbeatAt: NOW,
			finishedAt: NOW,
			metadata: {},
		});

		const identity = {
			organizationId: ORG,
			workItemId: "00000000-0000-4000-8000-000000000099",
			principalId: "00000000-0000-4000-8000-000000000010",
			sessionId: "00000000-0000-4000-8000-000000000020",
		};
		await expect(hasExternalAgentWorkAttempt(db, identity)).resolves.toBe(true);
		await expect(
			hasExternalAgentSessionWorkAttempt(db, identity),
		).resolves.toBe(true);
		await expect(
			hasExternalAgentWorkAttempt(db, {
				...identity,
				organizationId: "00000000-0000-4000-8000-000000000002",
			}),
		).resolves.toBe(false);
		await expect(
			hasExternalAgentSessionWorkAttempt(db, {
				organizationId: ORG,
				principalId: identity.principalId,
				sessionId: "00000000-0000-4000-8000-000000000021",
			}),
		).resolves.toBe(false);
		await expect(
			hasExternalAgentWorkAttempt(db, {
				...identity,
				workItemId: "00000000-0000-4000-8000-000000000098",
			}),
		).resolves.toBe(false);
		await expect(
			hasExternalAgentWorkAttempt(db, {
				...identity,
				principalId: "00000000-0000-4000-8000-000000000011",
			}),
		).resolves.toBe(false);
		await expect(
			hasExternalAgentWorkAttempt(db, {
				...identity,
				sessionId: "00000000-0000-4000-8000-000000000021",
			}),
		).resolves.toBe(false);
	});

	it("resolves composite session relations without join-shaped rows", async () => {
		const db = fixture();
		const actor = await principal(db);
		const run = await openExternalAgentSession(db, sessionInput(actor.id));
		const credential = await recordExternalAgentMcpCredential(db, {
			id: "00000000-0000-4000-8000-000000000040",
			organizationId: ORG,
			principalId: actor.id,
			sessionId: run.id,
			clientRecordId: "aih-client-record-rqb",
			mcpServerId: "aih-server-1",
			mcpServerUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
			issuedAt: NOW,
			expiresAt: "2026-07-20T01:00:00.000Z",
		});

		await expect(
			resolveActiveExternalAgentSession(db, {
				organizationId: ORG,
				principalId: actor.id,
				sessionId: run.id,
			}),
		).resolves.toMatchObject({
			principal: { id: actor.id, status: "active" },
			session: { id: run.id, externalSessionKey: run.externalSessionKey },
		});
		await expect(
			resolveExternalAgentAttributionStamp(db, {
				organizationId: ORG,
				principalId: actor.id,
				sessionId: run.id,
				clientRecordId: credential.clientRecordId,
			}),
		).resolves.toEqual({
			externalSessionKey: run.externalSessionKey,
			harness: run.harness,
			clientRecordId: credential.clientRecordId,
		});

		await setExternalAgentPrincipalStatus(db, {
			organizationId: ORG,
			principalId: actor.id,
			status: "suspended",
			updatedAt: LATER,
		});
		await expect(
			resolveActiveExternalAgentSession(db, {
				organizationId: ORG,
				principalId: actor.id,
				sessionId: run.id,
			}),
		).resolves.toBeNull();
	});

	it("keeps one stable principal per credential binding", async () => {
		const db = fixture();
		const first = await principal(db);
		const replay = await principal(db, "00000000-0000-4000-8000-000000000011");
		expect(replay.id).toBe(first.id);

		await expect(
			createExternalAgentPrincipal(db, {
				id: "00000000-0000-4000-8000-000000000012",
				organizationId: ORG,
				key: "impersonator",
				displayName: "Impersonator",
				credentialBindingType: "api_key",
				credentialBindingId: "key-1",
				createdByType: "user",
				createdById: "owner-1",
				createdAt: NOW,
			}),
		).rejects.toMatchObject<Partial<ExternalAgentIdentityError>>({
			reason: "binding_conflict",
		});
	});

	it("makes Agent-Session tuples immutable and exact replays idempotent", async () => {
		const db = fixture();
		const actor = await principal(db);
		const input = sessionInput(actor.id);
		const first = await openExternalAgentSession(db, input);
		const replay = await openExternalAgentSession(db, {
			...input,
			id: "00000000-0000-4000-8000-000000000021",
		});
		expect(replay.id).toBe(first.id);

		await expect(
			openExternalAgentSession(db, {
				...input,
				id: "00000000-0000-4000-8000-000000000022",
				modelVersion: "changed-under-same-session",
			}),
		).rejects.toMatchObject<Partial<ExternalAgentIdentityError>>({
			reason: "immutable_session_conflict",
		});
	});

	it("reopens existing sessions without writes and still rejects suspended principals", async () => {
		const queries: string[] = [];
		const db = fixture((query) => queries.push(query));
		const actor = await principal(db);
		const input = sessionInput(actor.id);
		const first = await openExternalAgentSession(db, input);
		queries.length = 0;
		expect(
			await openExternalAgentSession(db, { ...input, id: crypto.randomUUID() }),
		).toEqual(first);
		expect(queries.length).toBeGreaterThan(0);
		expect(queries.every((query) => /^\s*select\b/i.test(query))).toBe(true);
		await setExternalAgentPrincipalStatus(db, {
			organizationId: ORG,
			principalId: actor.id,
			status: "suspended",
			updatedAt: LATER,
		});
		await expect(openExternalAgentSession(db, input)).rejects.toMatchObject({
			reason: "principal_inactive",
		});
	});

	it("arbitrates simultaneous first opens with the unique session constraint", async () => {
		const db = fixture();
		const actor = await principal(db);
		const input = sessionInput(actor.id);
		const sessions = await Promise.all([
			openExternalAgentSession(db, input),
			openExternalAgentSession(db, { ...input, id: crypto.randomUUID() }),
		]);
		expect(sessions[0]).toEqual(sessions[1]);
	});

	it("tracks derived sessions without credit eligibility", async () => {
		const db = fixture();
		const actor = await principal(db);
		const run = await openExternalAgentSession(db, {
			...sessionInput(actor.id),
			identitySource: "derived",
		});
		expect(run.creditEligible).toBe(false);
	});

	it("records bounded idempotent knowledge checkpoints and immutable disposition", async () => {
		const db = fixture();
		const actor = await principal(db);
		const run = await openExternalAgentSession(db, sessionInput(actor.id));
		const checkpoint = {
			idempotencyKey: "checkpoint-1",
			workItemId: "00000000-0000-4000-8000-000000000097",
			summary: "Confirmed the session lifecycle boundary.",
			evidenceRefs: ["commit:abc"],
			artifactRef: null,
			recordedAt: NOW,
		};
		expect(
			await recordExternalAgentKnowledgeCheckpoint(db, {
				organizationId: ORG,
				principalId: actor.id,
				sessionId: run.id,
				checkpoint,
			}),
		).toEqual(checkpoint);
		expect(
			await recordExternalAgentKnowledgeCheckpoint(db, {
				organizationId: ORG,
				principalId: actor.id,
				sessionId: run.id,
				checkpoint: { ...checkpoint, recordedAt: LATER },
			}),
		).toEqual(checkpoint);

		const disposition = {
			type: "no_handoff" as const,
			idempotencyKey: "finish-1",
			workItemId: checkpoint.workItemId,
			reason: "Only lifecycle test data was produced.",
			recordedAt: LATER,
		};
		expect(
			await recordExternalAgentKnowledgeDisposition(db, {
				organizationId: ORG,
				principalId: actor.id,
				sessionId: run.id,
				disposition,
			}),
		).toEqual(disposition);
		await expect(
			recordExternalAgentKnowledgeDisposition(db, {
				organizationId: ORG,
				principalId: actor.id,
				sessionId: run.id,
				disposition: { ...disposition, reason: "Conflicting reason." },
			}),
		).rejects.toMatchObject<Partial<ExternalAgentIdentityError>>({
			reason: "knowledge_disposition_conflict",
		});
	});

	it("ends sessions permanently", async () => {
		const db = fixture();
		const actor = await principal(db);
		const input = sessionInput(actor.id);
		const run = await openExternalAgentSession(db, input);
		await expect(
			endExternalAgentSession(db, {
				organizationId: ORG,
				principalId: actor.id,
				sessionId: run.id,
				endedAt: LATER,
			}),
		).rejects.toMatchObject<Partial<ExternalAgentIdentityError>>({
			reason: "knowledge_disposition_required",
		});
		await recordExternalAgentKnowledgeDisposition(db, {
			organizationId: ORG,
			principalId: actor.id,
			sessionId: run.id,
			disposition: {
				type: "no_handoff",
				idempotencyKey: "end-test",
				workItemId: "00000000-0000-4000-8000-000000000099",
				reason: "Test session contains no reusable knowledge.",
				recordedAt: NOW,
			},
		});
		await db.insert(workAttempts).values({
			id: "00000000-0000-4000-8000-000000000096",
			workItemId: "00000000-0000-4000-8000-000000000099",
			orgId: ORG,
			executorType: "external_agent",
			executorId: actor.id,
			executorSessionId: run.id,
			runtimeState: "running",
			attemptNumber: 1,
			startedAt: NOW,
			heartbeatAt: NOW,
			metadata: {},
		});
		await expect(
			endExternalAgentSession(db, {
				organizationId: ORG,
				principalId: actor.id,
				sessionId: run.id,
				endedAt: LATER,
			}),
		).rejects.toMatchObject<Partial<ExternalAgentIdentityError>>({
			reason: "active_work_item_attempt",
		});
		await db
			.update(workAttempts)
			.set({
				runtimeState: "finished",
				outcome: "succeeded",
				finishedAt: LATER,
			})
			.where(eq(workAttempts.executorSessionId, run.id));
		const ended = await endExternalAgentSession(db, {
			organizationId: ORG,
			principalId: actor.id,
			sessionId: run.id,
			endedAt: LATER,
		});
		expect(ended.status).toBe("ended");
		await expect(
			heartbeatExternalAgentSession(db, {
				organizationId: ORG,
				principalId: actor.id,
				sessionId: run.id,
				seenAt: LATER,
			}),
		).rejects.toMatchObject<Partial<ExternalAgentIdentityError>>({
			reason: "session_ended",
		});
		await expect(
			openExternalAgentSession(db, {
				...input,
				id: "00000000-0000-4000-8000-000000000023",
				startedAt: LATER,
			}),
		).rejects.toMatchObject<Partial<ExternalAgentIdentityError>>({
			reason: "session_ended",
		});
	});

	it("atomically ends and idempotently replays a zero-work session", async () => {
		const db = fixture();
		const actor = await principal(db);
		const run = await openExternalAgentSession(db, sessionInput(actor.id));
		const zeroWorkDisposition = {
			idempotencyKey: "diagnostic-session-v1",
			reason: "The session never acquired a Work Item checkout.",
		};
		const ended = await endExternalAgentSession(db, {
			organizationId: ORG,
			principalId: actor.id,
			sessionId: run.id,
			endedAt: NOW,
			zeroWorkDisposition,
		});
		expect(ended).toMatchObject({
			status: "ended",
			metadata: {
				knowledgeLifecycle: {
					disposition: {
						type: "zero_work",
						...zeroWorkDisposition,
					},
				},
			},
		});
		await expect(
			endExternalAgentSession(db, {
				organizationId: ORG,
				principalId: actor.id,
				sessionId: run.id,
				endedAt: LATER,
				zeroWorkDisposition,
			}),
		).resolves.toMatchObject({ status: "ended", endedAt: NOW });
		await expect(
			endExternalAgentSession(db, {
				organizationId: ORG,
				principalId: actor.id,
				sessionId: run.id,
				endedAt: LATER,
				zeroWorkDisposition: {
					...zeroWorkDisposition,
					reason: "A conflicting replay.",
				},
			}),
		).rejects.toMatchObject<Partial<ExternalAgentIdentityError>>({
			reason: "knowledge_disposition_conflict",
		});
	});

	it.each(["active", "released"] as const)(
		"rejects zero-work close after a %s checkout",
		async (status) => {
			const db = fixture();
			const actor = await principal(db);
			const run = await openExternalAgentSession(db, sessionInput(actor.id));
			await db.insert(workAttempts).values({
				id: "00000000-0000-4000-8000-000000000096",
				workItemId: "00000000-0000-4000-8000-000000000099",
				orgId: ORG,
				executorType: "external_agent",
				executorId: actor.id,
				executorSessionId: run.id,
				runtimeState: status === "active" ? "running" : "finished",
				...(status === "released" ? { outcome: "succeeded" as const } : {}),
				attemptNumber: 1,
				startedAt: NOW,
				heartbeatAt: NOW,
				...(status === "released" ? { finishedAt: LATER } : {}),
				metadata: {},
			});
			await expect(
				endExternalAgentSession(db, {
					organizationId: ORG,
					principalId: actor.id,
					sessionId: run.id,
					endedAt: LATER,
					zeroWorkDisposition: {
						idempotencyKey: `zero-work-${status}`,
						reason: "This session has checkout history.",
					},
				}),
			).rejects.toMatchObject<Partial<ExternalAgentIdentityError>>({
				reason: "knowledge_disposition_conflict",
			});
		},
	);

	it("blocks new work immediately when a principal is suspended", async () => {
		const db = fixture();
		const actor = await principal(db);
		const run = await openExternalAgentSession(db, sessionInput(actor.id));
		await setExternalAgentPrincipalStatus(db, {
			organizationId: ORG,
			principalId: actor.id,
			status: "suspended",
			updatedAt: LATER,
		});
		await expect(
			heartbeatExternalAgentSession(db, {
				organizationId: ORG,
				principalId: actor.id,
				sessionId: run.id,
				seenAt: LATER,
			}),
		).rejects.toMatchObject<Partial<ExternalAgentIdentityError>>({
			reason: "principal_inactive",
		});
		await setExternalAgentPrincipalStatus(db, {
			organizationId: ORG,
			principalId: actor.id,
			status: "active",
			updatedAt: "2026-07-20T00:06:00.000Z",
		});
		await expect(
			openExternalAgentSession(db, {
				...sessionInput(actor.id),
				id: "00000000-0000-4000-8000-000000000025",
				startedAt: "2026-07-20T00:06:00.000Z",
			}),
		).rejects.toMatchObject<Partial<ExternalAgentIdentityError>>({
			reason: "session_ended",
		});
	});

	it("rejects attribution replay from a different immutable session", async () => {
		const db = fixture();
		const actor = await principal(db);
		const first = await openExternalAgentSession(db, sessionInput(actor.id));
		const second = await openExternalAgentSession(db, {
			...sessionInput(actor.id),
			id: "00000000-0000-4000-8000-000000000024",
			externalSessionKey: "codex:thread-2",
		});
		const attribution = {
			id: "00000000-0000-4000-8000-000000000030",
			organizationId: ORG,
			principalId: actor.id,
			sessionId: first.id,
			targetType: "mcp_execution" as const,
			targetId: "execution-1",
			role: "executor" as const,
			metadata: { tool: "work_claim" },
			occurredAt: NOW,
		};
		const created = await recordExternalAgentAttribution(db, attribution);
		expect(
			await recordExternalAgentAttribution(db, {
				...attribution,
				id: "00000000-0000-4000-8000-000000000031",
			}),
		).toEqual(created);
		await expect(
			recordExternalAgentAttribution(db, {
				...attribution,
				id: "00000000-0000-4000-8000-000000000032",
				sessionId: second.id,
			}),
		).rejects.toMatchObject<Partial<ExternalAgentIdentityError>>({
			reason: "immutable_session_conflict",
		});
	});

	it("shares one commit attribution across a multi-item commit's settlements", async () => {
		const db = fixture();
		const actor = await principal(db);
		const first = await openExternalAgentSession(db, sessionInput(actor.id));
		const second = await openExternalAgentSession(db, {
			...sessionInput(actor.id),
			id: "00000000-0000-4000-8000-000000000024",
			externalSessionKey: "codex:thread-2",
		});
		const attribution = {
			id: "00000000-0000-4000-8000-000000000030",
			organizationId: ORG,
			principalId: actor.id,
			sessionId: first.id,
			targetType: "commit" as const,
			targetId: "11dbaaebff5fd538e84a1b3c9edbc42a9f65001d",
			role: "executor" as const,
			workItemId: undefined,
			metadata: { source: "work-item-attempt" },
			certificationSource: "work_item_attempt" as const,
			occurredAt: NOW,
		};
		const created = await recordExternalAgentAttribution(db, attribution);
		// Second Work-Item trailer on the same commit: different item binding,
		// same session — shares the commit's single executor attribution.
		expect(
			await recordExternalAgentAttribution(db, {
				...attribution,
				id: "00000000-0000-4000-8000-000000000031",
				metadata: { source: "work-item-attempt", other: "item" },
				sharedTargetOk: true,
			}),
		).toEqual(created);
		// Without the flag the immutability contract still holds…
		await expect(
			recordExternalAgentAttribution(db, {
				...attribution,
				id: "00000000-0000-4000-8000-000000000032",
				metadata: { source: "work-item-attempt", other: "item" },
			}),
		).rejects.toMatchObject<Partial<ExternalAgentIdentityError>>({
			reason: "immutable_session_conflict",
		});
		// …and a DIFFERENT session can never share the row, flag or not.
		await expect(
			recordExternalAgentAttribution(db, {
				...attribution,
				id: "00000000-0000-4000-8000-000000000033",
				sessionId: second.id,
				sharedTargetOk: true,
			}),
		).rejects.toMatchObject<Partial<ExternalAgentIdentityError>>({
			reason: "immutable_session_conflict",
		});
	});

	it("revokes MCP authorization immediately but preserves historical execution proof", async () => {
		const db = fixture();
		const actor = await principal(db);
		const run = await openExternalAgentSession(db, sessionInput(actor.id));
		const credential = await recordExternalAgentMcpCredential(db, {
			id: "00000000-0000-4000-8000-000000000040",
			organizationId: ORG,
			principalId: actor.id,
			sessionId: run.id,
			clientRecordId: "aih-client-record-1",
			mcpServerId: "aih-server-1",
			mcpServerUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
			issuedAt: NOW,
			expiresAt: "2026-07-20T01:00:00.000Z",
		});
		expect(
			await recordExternalAgentMcpCredential(db, {
				id: "00000000-0000-4000-8000-000000000049",
				organizationId: ORG,
				principalId: actor.id,
				sessionId: run.id,
				clientRecordId: "aih-client-record-1",
				mcpServerId: "aih-server-1",
				mcpServerUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
				issuedAt: NOW,
				expiresAt: "2026-07-20T01:00:00.000Z",
			}),
		).toEqual(credential);
		expect(
			await resolveAuthorizedExternalAgentMcpSession(db, {
				organizationId: ORG,
				principalId: actor.id,
				sessionId: run.id,
				clientRecordId: credential.clientRecordId,
				now: "2026-07-20T00:01:00.000Z",
			}),
		).not.toBeNull();

		await revokeExternalAgentMcpCredential(db, {
			organizationId: ORG,
			principalId: actor.id,
			sessionId: run.id,
			clientRecordId: credential.clientRecordId,
			revokedAt: "2026-07-20T00:02:00.000Z",
		});
		expect(
			await resolveAuthorizedExternalAgentMcpSession(db, {
				organizationId: ORG,
				principalId: actor.id,
				sessionId: run.id,
				clientRecordId: credential.clientRecordId,
				now: "2026-07-20T00:02:01.000Z",
			}),
		).toBeNull();
		await recordExternalAgentKnowledgeDisposition(db, {
			organizationId: ORG,
			principalId: actor.id,
			sessionId: run.id,
			disposition: {
				type: "no_handoff",
				idempotencyKey: "credential-revocation-test",
				workItemId: "00000000-0000-4000-8000-000000000098",
				reason: "Credential lifecycle test has no reusable knowledge.",
				recordedAt: "2026-07-20T00:02:30.000Z",
			},
		});
		await endExternalAgentSession(db, {
			organizationId: ORG,
			principalId: actor.id,
			sessionId: run.id,
			endedAt: "2026-07-20T00:03:00.000Z",
		});

		const historical = await recordVerifiedExternalAgentMcpExecution(db, {
			id: "00000000-0000-4000-8000-000000000041",
			organizationId: ORG,
			principalId: actor.id,
			sessionId: run.id,
			clientRecordId: credential.clientRecordId,
			targetId: "execution-before-revocation",
			occurredAt: "2026-07-20T00:01:30.000Z",
		});
		expect(historical.targetId).toBe("execution-before-revocation");
		await expect(
			recordVerifiedExternalAgentMcpExecution(db, {
				id: "00000000-0000-4000-8000-000000000042",
				organizationId: ORG,
				principalId: actor.id,
				sessionId: run.id,
				clientRecordId: credential.clientRecordId,
				targetId: "execution-after-revocation",
				occurredAt: "2026-07-20T00:02:30.000Z",
			}),
		).rejects.toMatchObject<Partial<ExternalAgentIdentityError>>({
			reason: "credential_inactive",
		});
	});

	it("selects the newest active MCP client for reuse", async () => {
		const db = fixture();
		const actor = await principal(db);
		const run = await openExternalAgentSession(db, sessionInput(actor.id));
		for (const [id, clientRecordId, issuedAt] of [
			["00000000-0000-4000-8000-000000000040", "client-old", NOW],
			["00000000-0000-4000-8000-000000000041", "client-new", LATER],
		] as const) {
			await recordExternalAgentMcpCredential(db, {
				id,
				organizationId: ORG,
				principalId: actor.id,
				sessionId: run.id,
				clientRecordId,
				mcpServerId: "aih-server-1",
				mcpServerUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
				issuedAt,
				expiresAt: "2026-07-20T01:00:00.000Z",
			});
		}

		const active = await listActiveExternalAgentMcpCredentials(db, {
			organizationId: ORG,
			principalId: actor.id,
			sessionId: run.id,
			mcpServerId: "aih-server-1",
		});
		expect(active.map((row) => row.clientRecordId)).toEqual([
			"client-new",
			"client-old",
		]);
	});

	it("fences concurrent MCP issuance and permits takeover only after expiry", async () => {
		const db = fixture();
		const actor = await principal(db);
		const run = await openExternalAgentSession(db, sessionInput(actor.id));
		const target = {
			organizationId: ORG,
			principalId: actor.id,
			sessionId: run.id,
			mcpServerId: "aih-server-1",
		};
		expect(
			await acquireExternalAgentMcpIssuanceLease(db, {
				...target,
				id: "lease-1",
				ownerToken: "owner-1",
				now: NOW,
				expiresAt: LATER,
			}),
		).toBe(true);
		expect(
			await acquireExternalAgentMcpIssuanceLease(db, {
				...target,
				id: "lease-2",
				ownerToken: "owner-2",
				now: NOW,
				expiresAt: LATER,
			}),
		).toBe(false);
		expect(
			await acquireExternalAgentMcpIssuanceLease(db, {
				...target,
				id: "lease-2",
				ownerToken: "owner-2",
				now: "2026-07-20T00:06:00.000Z",
				expiresAt: "2026-07-20T00:11:00.000Z",
			}),
		).toBe(true);
		await releaseExternalAgentMcpIssuanceLease(db, {
			...target,
			ownerToken: "owner-1",
		});
		const credentialInput = {
			id: "00000000-0000-4000-8000-000000000042",
			...target,
			clientRecordId: "client-fenced",
			mcpServerUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
			issuedAt: "2026-07-20T00:06:00.000Z",
			expiresAt: "2026-07-20T00:16:00.000Z",
		};
		await expect(
			recordExternalAgentMcpCredentialUnderLease(db, {
				...credentialInput,
				leaseOwnerToken: "owner-1",
				leaseNow: "2026-07-20T00:06:00.000Z",
			}),
		).rejects.toThrow("no longer owns");
		await recordExternalAgentMcpCredentialUnderLease(db, {
			...credentialInput,
			leaseOwnerToken: "owner-2",
			leaseNow: "2026-07-20T00:06:00.000Z",
		});
		await expect(
			refreshExternalAgentMcpCredentialUnderLease(db, {
				organizationId: ORG,
				principalId: actor.id,
				sessionId: run.id,
				mcpServerId: target.mcpServerId,
				clientRecordId: credentialInput.clientRecordId,
				issuedAt: "2026-07-20T00:07:00.000Z",
				expiresAt: "2026-07-20T00:17:00.000Z",
				leaseOwnerToken: "owner-1",
				leaseNow: "2026-07-20T00:07:00.000Z",
			}),
		).rejects.toThrow("no longer owns");
	});

	it("rejects self-review plus derived reviewer and subject sessions", async () => {
		const db = fixture();
		const actor = await principal(db);
		const run = await openExternalAgentSession(db, sessionInput(actor.id));
		const proof = await execution(db, {
			principalId: actor.id,
			sessionId: run.id,
		});
		await expect(
			recordExternalAgentReviewEvidence(
				db,
				reviewInput(proof.id, {
					reviewerPrincipalType: "external_agent",
					reviewerPrincipalId: actor.id,
					reviewerSessionId: run.id,
				}),
			),
		).rejects.toMatchObject<Partial<ExternalAgentIdentityError>>({
			reason: "review_conflict",
		});

		const derivedReviewer = await createExternalAgentPrincipal(db, {
			id: "00000000-0000-4000-8000-000000000011",
			organizationId: ORG,
			key: "derived-reviewer",
			displayName: "Derived reviewer",
			credentialBindingType: "api_key",
			credentialBindingId: "key-derived-reviewer",
			createdByType: "user",
			createdById: "owner-1",
			createdAt: NOW,
		});
		const derivedReviewerRun = await openExternalAgentSession(db, {
			...sessionInput(derivedReviewer.id),
			id: "00000000-0000-4000-8000-000000000021",
			externalSessionKey: "codex:derived-reviewer",
			identitySource: "derived",
		});
		await expect(
			recordExternalAgentReviewEvidence(
				db,
				reviewInput(proof.id, {
					reviewerPrincipalType: "external_agent",
					reviewerPrincipalId: derivedReviewer.id,
					reviewerSessionId: derivedReviewerRun.id,
				}),
			),
		).rejects.toMatchObject<Partial<ExternalAgentIdentityError>>({
			reason: "review_conflict",
		});

		const derivedDb = fixture();
		const derivedActor = await principal(derivedDb);
		const derivedRun = await openExternalAgentSession(derivedDb, {
			...sessionInput(derivedActor.id),
			identitySource: "derived",
		});
		const derivedProof = await execution(derivedDb, {
			principalId: derivedActor.id,
			sessionId: derivedRun.id,
		});
		await expect(
			recordExternalAgentReviewEvidence(
				derivedDb,
				reviewInput(derivedProof.id),
			),
		).rejects.toMatchObject<Partial<ExternalAgentIdentityError>>({
			reason: "review_conflict",
		});
	});

	it("counts one stable external reviewer across immutable sessions", async () => {
		const db = fixture();
		const actor = await principal(db);
		const subjectRun = await openExternalAgentSession(
			db,
			sessionInput(actor.id),
		);
		const proof = await execution(db, {
			principalId: actor.id,
			sessionId: subjectRun.id,
		});
		const reviewer = await createExternalAgentPrincipal(db, {
			id: "00000000-0000-4000-8000-000000000011",
			organizationId: ORG,
			key: "reviewer-agent",
			displayName: "Reviewer agent",
			credentialBindingType: "api_key",
			credentialBindingId: "key-reviewer",
			createdByType: "user",
			createdById: "owner-1",
			createdAt: NOW,
		});
		const firstReviewRun = await openExternalAgentSession(db, {
			...sessionInput(reviewer.id),
			id: "00000000-0000-4000-8000-000000000021",
			externalSessionKey: "codex:review-1",
		});
		const secondReviewRun = await openExternalAgentSession(db, {
			...sessionInput(reviewer.id),
			id: "00000000-0000-4000-8000-000000000022",
			externalSessionKey: "codex:review-2",
		});
		const first = await recordExternalAgentReviewEvidence(
			db,
			reviewInput(proof.id, {
				reviewerPrincipalType: "external_agent",
				reviewerPrincipalId: reviewer.id,
				reviewerSessionId: firstReviewRun.id,
			}),
		);
		expect(first.reviewerPrincipalId).toBe(reviewer.id);
		await expect(
			recordExternalAgentReviewEvidence(
				db,
				reviewInput(proof.id, {
					reviewerPrincipalType: "external_agent",
					reviewerPrincipalId: reviewer.id,
					reviewerSessionId: secondReviewRun.id,
				}),
			),
		).rejects.toMatchObject<Partial<ExternalAgentIdentityError>>({
			reason: "review_conflict",
		});
	});

	it("keeps subject-authored attributions visible but reputation-ineligible", async () => {
		const db = fixture();
		const actor = await principal(db);
		const run = await openExternalAgentSession(db, sessionInput(actor.id));
		const asserted = await recordExternalAgentAttribution(db, {
			id: "00000000-0000-4000-8000-000000000030",
			organizationId: ORG,
			principalId: actor.id,
			sessionId: run.id,
			targetType: "commit",
			targetId: "subject-asserted-commit",
			role: "executor",
			metadata: {
				reputationContext: REVIEW_CONTEXT,
				provenanceCertification: {
					source: "git_tie",
					verifier: "forged",
				},
			},
			occurredAt: NOW,
		});
		expect(asserted.metadata).not.toHaveProperty("provenanceCertification");
		await expect(
			recordExternalAgentReviewEvidence(db, reviewInput(asserted.id)),
		).rejects.toThrow(/Only Tedix-certified/);
	});

	it("requires exact immutable execution context and exact version queries", async () => {
		const db = fixture();
		const actor = await principal(db);
		const run = await openExternalAgentSession(db, sessionInput(actor.id));
		const proof = await execution(db, {
			principalId: actor.id,
			sessionId: run.id,
		});
		await expect(
			recordExternalAgentReviewEvidence(
				db,
				reviewInput(proof.id, {
					context: { ...REVIEW_CONTEXT, repositoryVersion: "sha:other" },
				}),
			),
		).rejects.toMatchObject<Partial<ExternalAgentIdentityError>>({
			reason: "review_conflict",
		});
		await recordExternalAgentReviewEvidence(db, reviewInput(proof.id));
		await recordExternalAgentReviewEvidence(
			db,
			reviewInput(proof.id, {
				id: "00000000-0000-4000-8000-000000000032",
				reviewerPrincipalId: "reviewer-2",
				score: 0.8,
				evidenceRefs: ["artifact://review-2"],
			}),
		);
		const exact = await getExternalAgentContextualReputation(db, {
			organizationId: ORG,
			subjectPrincipalId: actor.id,
			context: {
				...REVIEW_CONTEXT,
				harness: run.harness,
				harnessVersion: run.harnessVersion,
				modelProvider: run.modelProvider,
				modelId: run.modelId,
				modelVersion: run.modelVersion,
			},
			now: LATER,
			halfLifeDays: 90,
		});
		expect(exact.rawReviewCount).toBe(2);
		expect(exact.reviewedExecutions).toBe(1);
		expect(exact.distinctReviewerPrincipals).toBe(2);
		expect(exact.weightedMeanScore).toBeCloseTo(0.8);
		const otherVersion = await getExternalAgentContextualReputation(db, {
			organizationId: ORG,
			subjectPrincipalId: actor.id,
			now: LATER,
			halfLifeDays: 90,
			context: {
				...exact.context,
				repositoryVersion: "sha:other",
			},
		});
		expect(otherVersion.rawReviewCount).toBe(0);
	});

	it("decays stale positive evidence in absolute effective sample size", async () => {
		const db = fixture();
		const actor = await principal(db);
		const old = "2026-01-01T00:00:00.000Z";
		const run = await openExternalAgentSession(db, {
			...sessionInput(actor.id),
			startedAt: old,
		});
		for (let index = 0; index < 5; index += 1) {
			const proof = await execution(db, {
				principalId: actor.id,
				sessionId: run.id,
				id: crypto.randomUUID(),
				targetId: `old-execution-${index}`,
				occurredAt: old,
			});
			await recordExternalAgentReviewEvidence(
				db,
				reviewInput(proof.id, {
					id: crypto.randomUUID(),
					evidenceRefs: [`artifact://old-${index}`],
					occurredAt: old,
				}),
			);
		}
		const result = await getExternalAgentContextualReputation(db, {
			organizationId: ORG,
			subjectPrincipalId: actor.id,
			context: {
				...REVIEW_CONTEXT,
				harness: run.harness,
				harnessVersion: run.harnessVersion,
				modelProvider: run.modelProvider,
				modelId: run.modelId,
				modelVersion: run.modelVersion,
			},
			now: "2026-07-20T00:00:00.000Z",
			halfLifeDays: 30,
		});
		expect(result.reviewedExecutions).toBe(5);
		expect(result.effectiveSampleSize).toBeLessThan(1);
		expect(result.status).toBe("insufficient");
	});

	it("keeps old critical negatives blocking until explicit remediation", async () => {
		const db = fixture();
		const actor = await principal(db);
		const old = "2026-01-01T00:00:00.000Z";
		const run = await openExternalAgentSession(db, {
			...sessionInput(actor.id),
			startedAt: old,
		});
		const proof = await execution(db, {
			principalId: actor.id,
			sessionId: run.id,
			occurredAt: old,
		});
		const negative = await recordExternalAgentReviewEvidence(
			db,
			reviewInput(proof.id, {
				outcome: "policy_violation",
				score: 0,
				policyViolationSeverity: 10,
				evidenceRefs: ["incident://critical-1"],
				occurredAt: old,
			}),
		);
		const query = {
			organizationId: ORG,
			subjectPrincipalId: actor.id,
			context: {
				...REVIEW_CONTEXT,
				harness: run.harness,
				harnessVersion: run.harnessVersion,
				modelProvider: run.modelProvider,
				modelId: run.modelId,
				modelVersion: run.modelVersion,
			},
			now: "2026-07-20T00:00:00.000Z",
			halfLifeDays: 30,
		};
		expect(
			(await getExternalAgentContextualReputation(db, query))
				.blockedByCriticalNegative,
		).toBe(true);
		await remediateExternalAgentReviewEvidence(db, {
			organizationId: ORG,
			reviewId: negative.id,
			evidenceRef: "artifact://remediation-1",
			resolvedByType: "user",
			resolvedById: "owner-1",
			resolvedAt: "2026-07-20T00:01:00.000Z",
		});
		expect(
			(await getExternalAgentContextualReputation(db, query))
				.blockedByCriticalNegative,
		).toBe(false);
	});
});
