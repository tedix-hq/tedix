import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { loadDescopeMcpServer } from "@tedix/auth/aih-client";
import { createDbClient } from "@tedix/db/client";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import {
	externalAgentIdentityContractRouter,
	resolveExternalAgentMcpClientScopes,
	selectReusableExternalAgentMcpCredential,
} from "./external-agent-identity";

vi.mock("@tedix/auth/aih-client", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/auth/aih-client")>()),
	loadDescopeMcpServer: vi.fn(),
}));

const ORG = "00000000-0000-4000-8000-000000000001";
const SUBJECT = "00000000-0000-4000-8000-000000000010";
const SUBJECT_SESSION = "00000000-0000-4000-8000-000000000020";
const EXECUTION = "00000000-0000-4000-8000-000000000030";
const REVIEWER = "00000000-0000-4000-8000-000000000011";
const REVIEWER_SESSION = "00000000-0000-4000-8000-000000000021";
const CONTEXT = {
	taskFamily: "typescript-change",
	repositoryKey: "github:tedix/tedix",
	repositoryVersion: "sha:abc123",
	riskLevel: "high" as const,
	environment: "production",
};

const DDL = `
CREATE TABLE external_agent_principals (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, key TEXT NOT NULL,
 display_name TEXT NOT NULL, status TEXT NOT NULL,
 credential_binding_type TEXT NOT NULL, credential_binding_id TEXT NOT NULL,
 created_by_type TEXT NOT NULL, created_by_id TEXT NOT NULL, metadata TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE external_agent_sessions (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, principal_id TEXT NOT NULL,
 external_session_key TEXT NOT NULL, harness TEXT NOT NULL,
 harness_version TEXT NOT NULL, model_provider TEXT NOT NULL,
 model_id TEXT NOT NULL, model_version TEXT NOT NULL,
 identity_source TEXT NOT NULL, status TEXT NOT NULL,
 credit_eligible INTEGER NOT NULL, started_at TEXT NOT NULL,
 last_seen_at TEXT NOT NULL, ended_at TEXT, metadata TEXT NOT NULL
);
CREATE TABLE external_agent_mcp_credentials (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, principal_id TEXT NOT NULL,
 session_id TEXT NOT NULL, client_record_id TEXT NOT NULL,
 mcp_server_id TEXT NOT NULL, mcp_server_url TEXT NOT NULL,
 status TEXT NOT NULL, issued_at TEXT NOT NULL, expires_at TEXT NOT NULL,
 revoked_at TEXT
);
CREATE TABLE external_agent_mcp_issuance_leases (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, principal_id TEXT NOT NULL,
 session_id TEXT NOT NULL, mcp_server_id TEXT NOT NULL, owner_token TEXT NOT NULL,
 expires_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE (organization_id, principal_id, session_id, mcp_server_id)
);
CREATE TABLE work_attempts (
 id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL, org_id TEXT NOT NULL,
 executor_type TEXT NOT NULL, executor_id TEXT NOT NULL,
 executor_session_id TEXT, run_id TEXT, runtime_state TEXT NOT NULL,
 outcome TEXT, attempt_number INTEGER NOT NULL, started_at TEXT NOT NULL,
 heartbeat_at TEXT, expires_at TEXT, finished_at TEXT, summary TEXT,
 version INTEGER NOT NULL, metadata TEXT NOT NULL
);
CREATE TABLE external_agent_attributions (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, principal_id TEXT NOT NULL,
 session_id TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
 role TEXT NOT NULL, work_item_id TEXT, metadata TEXT NOT NULL,
 occurred_at TEXT NOT NULL
);
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
CREATE TABLE audit_events (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, actor_id TEXT NOT NULL,
 actor_type TEXT NOT NULL, action TEXT NOT NULL, resource_type TEXT NOT NULL,
 resource_id TEXT, metadata TEXT, ip_address TEXT, user_agent TEXT,
 timestamp INTEGER NOT NULL
);
CREATE UNIQUE INDEX uniq_external_agent_review_principal_execution
 ON external_agent_review_evidence
 (organization_id, execution_attribution_id, reviewer_principal_type,
  reviewer_principal_id);
`;

function d1Facade(db: DatabaseSync): D1Database {
	const wrap = (sql: string) => {
		const stmt = db.prepare(sql);
		let bound: Array<null | number | bigint | string | Uint8Array> = [];
		const prepared = {
			bind: (...values: unknown[]) => {
				bound = values as typeof bound;
				return prepared;
			},
			all: async () => ({
				results: stmt.all(...bound),
				success: true,
				meta: {},
			}),
			run: async () => {
				const result = stmt.run(...bound);
				return {
					success: true,
					meta: {
						changes: Number(result.changes),
						last_row_id: Number(result.lastInsertRowid),
						duration: 0,
					},
				};
			},
			first: async (column?: string) => {
				const row = stmt.get(...bound) as Record<string, unknown> | undefined;
				return column ? (row?.[column] ?? null) : (row ?? null);
			},
			raw: async () =>
				(stmt.all(...bound) as Array<Record<string, unknown>>).map((row) =>
					Object.values(row),
				),
		};
		return prepared;
	};
	return {
		prepare: wrap,
		batch: async (statements: Array<{ all: () => Promise<unknown> }>) =>
			Promise.all(statements.map((statement) => statement.all())),
		exec: async (sql: string) => {
			db.exec(sql);
			return { count: 0, duration: 0 };
		},
		dump: async () => new ArrayBuffer(0),
	} as unknown as D1Database;
}

let sqlite: DatabaseSync;

function seedIdentity(): void {
	const insertPrincipal = sqlite.prepare(`INSERT INTO external_agent_principals
		(id, organization_id, key, display_name, status, credential_binding_type,
		 credential_binding_id, created_by_type, created_by_id, metadata, created_at,
		 updated_at) VALUES (?, ?, ?, ?, 'active', 'api_key', ?, 'user', 'owner',
		 '{}', '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z')`);
	insertPrincipal.run(SUBJECT, ORG, "subject", "Subject", "subject-key");
	insertPrincipal.run(REVIEWER, ORG, "reviewer", "Reviewer", "reviewer-key");
	const insertSession = sqlite.prepare(`INSERT INTO external_agent_sessions
		(id, organization_id, principal_id, external_session_key, harness,
		 harness_version, model_provider, model_id, model_version, identity_source,
		 status, credit_eligible, started_at, last_seen_at, metadata)
		 VALUES (?, ?, ?, ?, 'codex', '1', 'openai', 'gpt-5.6', '2026-07-20',
		 'explicit', 'active', 1, '2026-07-20T00:00:00.000Z',
		 '2026-07-20T00:00:00.000Z', '{}')`);
	insertSession.run(SUBJECT_SESSION, ORG, SUBJECT, "codex:subject");
	insertSession.run(REVIEWER_SESSION, ORG, REVIEWER, "codex:reviewer");
	const insertCredential =
		sqlite.prepare(`INSERT INTO external_agent_mcp_credentials
		(id, organization_id, principal_id, session_id, client_record_id,
		 mcp_server_id, mcp_server_url, status, issued_at, expires_at)
		 VALUES (?, ?, ?, ?, ?, 'resource', 'https://tedix-unified.mcp.tedix.dev/mcp',
		 'active', '2026-07-20T00:00:00.000Z', '2099-07-20T00:00:00.000Z')`);
	insertCredential.run(
		"subject-credential",
		ORG,
		SUBJECT,
		SUBJECT_SESSION,
		"subject-client",
	);
	insertCredential.run(
		"reviewer-credential",
		ORG,
		REVIEWER,
		REVIEWER_SESSION,
		"reviewer-client",
	);
	sqlite
		.prepare(
			`INSERT INTO work_attempts
			 (id, work_item_id, org_id, executor_type, executor_id,
			  executor_session_id, runtime_state, attempt_number, started_at, version, metadata)
			 VALUES (?, ?, ?, 'external_agent', ?, ?, 'running', 1,
			  '2026-07-20T00:00:00.000Z', 1, '{}')`,
		)
		.run(
			"00000000-0000-4000-8000-000000000091",
			"00000000-0000-4000-8000-000000000090",
			ORG,
			SUBJECT,
			SUBJECT_SESSION,
		);
	sqlite
		.prepare(`INSERT INTO external_agent_attributions
			(id, organization_id, principal_id, session_id, target_type, target_id,
			 role, metadata, occurred_at)
			VALUES (?, ?, ?, ?, 'commit', 'abc123', 'executor', ?,
			 '2026-07-20T00:01:00.000Z')`)
		.run(
			EXECUTION,
			ORG,
			SUBJECT,
			SUBJECT_SESSION,
			JSON.stringify({
				reputationContext: CONTEXT,
				provenanceCertification: {
					source: "git_tie",
					verifier: "tedix",
				},
			}),
		);
}

function context(
	auth: { type: "user"; id: string } | { type: "apikey"; id: string },
): BaseContext {
	return {
		authType: auth.type,
		apiKey:
			auth.type === "apikey"
				? { id: auth.id, name: "agent", organizationId: ORG, scopes: ["*"] }
				: undefined,
		user: auth.type === "user" ? ({ sub: auth.id } as never) : undefined,
		userRole: auth.type === "user" ? "admin" : undefined,
		organizationId: ORG,
		db: createDbClient(d1Facade(sqlite)) as BaseContext["db"],
		env: { ENVIRONMENT: "test" } as CloudflareEnv,
		headers: new Headers(),
		rateLimiter: { limit: async () => ({ success: true }) } as RateLimit,
		url: new URL("https://api.tedix.test/rpc/external-agents"),
		waitUntil: () => {},
	} as unknown as BaseContext;
}

function input() {
	return {
		organizationId: ORG,
		executionAttributionId: EXECUTION,
		...CONTEXT,
		outcome: "success" as const,
		score: 1,
		policyViolationSeverity: 0,
		reviewMethod: "independent-reproduction",
		evidenceRefs: ["artifact://review"],
	};
}

function externalContext(
	principalId: string,
	sessionId: string,
	clientRecordId: string,
): BaseContext {
	const value = context({ type: "apikey", id: "unused" });
	value.authType = "service-binding";
	value.apiKey = undefined;
	value.headers = new Headers({
		"X-Service-Binding": "true",
		"X-Tedix-Caller-Type": "mcp-edge-external-agent",
		"X-Tedix-External-Agent-Principal-Id": principalId,
		"X-Tedix-External-Agent-Session-Id": sessionId,
		"X-Tedix-External-Agent-Client-Record-Id": clientRecordId,
		"X-Tedix-Org-Id": ORG,
	});
	value.url = new URL("https://api/rpc/externalAgentIdentity/endSession");
	return value;
}

beforeEach(() => {
	vi.mocked(loadDescopeMcpServer).mockReset();
	sqlite = new DatabaseSync(":memory:");
	sqlite.exec(DDL);
	seedIdentity();
});

describe("external-agent review API identity", () => {
	it("derives a human reviewer from authenticated user identity", async () => {
		const client = createRouterClient(externalAgentIdentityContractRouter, {
			context: context({ type: "user", id: "user-reviewer" }),
		});
		const review = await client.recordReview(input());
		expect(review).toMatchObject({
			reviewerPrincipalType: "user",
			reviewerPrincipalId: "user-reviewer",
			reviewerSessionId: null,
		});
	});

	it("rejects a non-governing human reviewer", async () => {
		const memberContext = context({ type: "user", id: "user-member" });
		memberContext.userRole = "member";
		const client = createRouterClient(externalAgentIdentityContractRouter, {
			context: memberContext,
		});
		await expect(client.recordReview(input())).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});

	it("derives a bound external reviewer and rejects self-review", async () => {
		const reviewerClient = createRouterClient(
			externalAgentIdentityContractRouter,
			{
				context: context({ type: "apikey", id: "reviewer-key" }),
			},
		);
		const review = await reviewerClient.recordReview({
			...input(),
			reviewerSessionId: REVIEWER_SESSION,
		});
		expect(review).toMatchObject({
			reviewerPrincipalType: "external_agent",
			reviewerPrincipalId: REVIEWER,
			reviewerSessionId: REVIEWER_SESSION,
		});

		const subjectClient = createRouterClient(
			externalAgentIdentityContractRouter,
			{
				context: context({ type: "apikey", id: "subject-key" }),
			},
		);
		await expect(
			subjectClient.recordReview({
				...input(),
				reviewerSessionId: SUBJECT_SESSION,
			}),
		).rejects.toThrow(/cannot review its own execution/);
	});
});

describe("external-agent knowledge lifecycle", () => {
	it("lets an org admin retire an abandoned zero-work session with audit", async () => {
		const client = createRouterClient(externalAgentIdentityContractRouter, {
			context: context({ type: "user", id: "owner-admin" }),
		});
		const result = await client.retireAbandonedSession({
			organizationId: ORG,
			principalId: REVIEWER,
			sessionId: REVIEWER_SESSION,
			reason: "Synthetic workflow lost its ephemeral credential.",
		});
		expect(result).toMatchObject({
			session: { id: REVIEWER_SESSION, status: "ended" },
			revokedCredentialCount: 1,
		});
		expect(
			sqlite
				.prepare(
					"SELECT status FROM external_agent_mcp_credentials WHERE client_record_id = ?",
				)
				.get("reviewer-client"),
		).toEqual({ status: "revoked" });
		const audit = sqlite
			.prepare(
				"SELECT actor_id, actor_type, action, resource_id, metadata FROM audit_events WHERE resource_id = ?",
			)
			.get(REVIEWER_SESSION) as Record<string, unknown>;
		expect(audit).toMatchObject({
			actor_id: "owner-admin",
			actor_type: "user",
			action: "external_agent.session.retired_abandoned",
			resource_id: REVIEWER_SESSION,
		});
		expect(String(audit.metadata)).not.toContain("accessToken");
	});

	it("lets an org admin retire an abandoned session after terminal Work with an explicit disposition", async () => {
		sqlite
			.prepare(
				"UPDATE work_attempts SET runtime_state = 'finished', outcome = 'succeeded', finished_at = ? WHERE executor_session_id = ?",
			)
			.run("2026-07-20T00:02:00.000Z", SUBJECT_SESSION);
		const client = createRouterClient(externalAgentIdentityContractRouter, {
			context: context({ type: "user", id: "owner-admin" }),
		});
		const result = await client.retireAbandonedSession({
			organizationId: ORG,
			principalId: SUBJECT,
			sessionId: SUBJECT_SESSION,
			reason: "The credential holder was lost after execution settled.",
			workDisposition: {
				type: "no_handoff",
				idempotencyKey: "governed-retirement-work-v1",
				workItemId: "00000000-0000-4000-8000-000000000090",
				reason: "No reusable knowledge remained outside the Work evidence.",
			},
		});

		expect(result.session).toMatchObject({
			id: SUBJECT_SESSION,
			status: "ended",
			metadata: {
				knowledgeLifecycle: {
					disposition: { type: "no_handoff" },
				},
			},
		});
	});

	it("reconciles an active credential left behind for an already-ended session", async () => {
		const subjectClient = createRouterClient(
			externalAgentIdentityContractRouter,
			{
				context: externalContext(REVIEWER, REVIEWER_SESSION, "reviewer-client"),
			},
		);
		await subjectClient.endSession({
			organizationId: ORG,
			principalId: REVIEWER,
			sessionId: REVIEWER_SESSION,
			zeroWorkDisposition: {
				idempotencyKey: "ended-before-recovery-v1",
				reason: "Synthetic self-teardown completed before credential cleanup.",
			},
		});
		sqlite
			.prepare(
				"UPDATE external_agent_mcp_credentials SET status = 'active', revoked_at = NULL WHERE client_record_id = ?",
			)
			.run("reviewer-client");

		const adminClient = createRouterClient(
			externalAgentIdentityContractRouter,
			{
				context: context({ type: "user", id: "owner-admin" }),
			},
		);
		const result = await adminClient.retireAbandonedSession({
			organizationId: ORG,
			principalId: REVIEWER,
			sessionId: REVIEWER_SESSION,
			reason: "Reconcile a credential left active after partial teardown.",
		});

		expect(result).toMatchObject({
			session: { id: REVIEWER_SESSION, status: "ended" },
			revokedCredentialCount: 1,
		});
		expect(
			sqlite
				.prepare(
					"SELECT status FROM external_agent_mcp_credentials WHERE client_record_id = ?",
				)
				.get("reviewer-client"),
		).toEqual({ status: "revoked" });
	});

	it("rejects abandoned-session retirement without governance authority", async () => {
		const member = context({ type: "user", id: "member" });
		member.userRole = "member";
		const client = createRouterClient(externalAgentIdentityContractRouter, {
			context: member,
		});
		await expect(
			client.retireAbandonedSession({
				organizationId: ORG,
				principalId: REVIEWER,
				sessionId: REVIEWER_SESSION,
				reason: "must fail",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("atomically ends a session with an explicit zero-work disposition", async () => {
		const client = createRouterClient(externalAgentIdentityContractRouter, {
			context: externalContext(REVIEWER, REVIEWER_SESSION, "reviewer-client"),
		});
		const ended = await client.endSession({
			organizationId: ORG,
			principalId: REVIEWER,
			sessionId: REVIEWER_SESSION,
			zeroWorkDisposition: {
				idempotencyKey: "diagnostic-session-v1",
				reason: "The diagnostic session never claimed board work.",
			},
		});
		expect(ended).toMatchObject({
			status: "ended",
			id: REVIEWER_SESSION,
			metadata: {
				knowledgeLifecycle: {
					disposition: {
						type: "zero_work",
						idempotencyKey: "diagnostic-session-v1",
					},
				},
			},
		});
		expect(
			sqlite
				.prepare(
					"SELECT status FROM external_agent_mcp_credentials WHERE client_record_id = ?",
				)
				.get("reviewer-client"),
		).toEqual({ status: "revoked" });
	});

	it("rejects zero-work close after the session owned board work", async () => {
		const client = createRouterClient(externalAgentIdentityContractRouter, {
			context: externalContext(SUBJECT, SUBJECT_SESSION, "subject-client"),
		});
		await expect(
			client.endSession({
				organizationId: ORG,
				principalId: SUBJECT,
				sessionId: SUBJECT_SESSION,
				zeroWorkDisposition: {
					idempotencyKey: "invalid-zero-work-v1",
					reason: "This must not erase the Work Item attribution requirement.",
				},
			}),
		).rejects.toThrow(/invalid after.*owned a Work Item attempt/i);
	});

	it("gates session end on an idempotent final disposition", async () => {
		const client = createRouterClient(externalAgentIdentityContractRouter, {
			context: externalContext(SUBJECT, SUBJECT_SESSION, "subject-client"),
		});
		const workItemId = "00000000-0000-4000-8000-000000000090";
		const checkpoint = await client.recordKnowledgeCheckpoint({
			organizationId: ORG,
			principalId: SUBJECT,
			sessionId: SUBJECT_SESSION,
			idempotencyKey: "checkpoint-v1",
			workItemId,
			summary: "Captured the relevant evidence.",
			evidenceRefs: ["artifact://research"],
		});
		expect(checkpoint).toMatchObject({
			idempotencyKey: "checkpoint-v1",
			workItemId,
		});
		await expect(
			client.endSession({
				organizationId: ORG,
				principalId: SUBJECT,
				sessionId: SUBJECT_SESSION,
			}),
		).rejects.toThrow(/cannot end until it records/i);
		await client.recordKnowledgeDisposition({
			organizationId: ORG,
			principalId: SUBJECT,
			sessionId: SUBJECT_SESSION,
			type: "no_handoff",
			idempotencyKey: "finish-v1",
			workItemId,
			reason: "The checkpoint contains no reusable organizational knowledge.",
		});
		sqlite
			.prepare(
				"UPDATE work_attempts SET runtime_state = 'finished', outcome = 'succeeded', finished_at = '2026-07-20T00:05:00.000Z' WHERE executor_session_id = ?",
			)
			.run(SUBJECT_SESSION);
		const ended = await client.endSession({
			organizationId: ORG,
			principalId: SUBJECT,
			sessionId: SUBJECT_SESSION,
		});
		expect(ended).toMatchObject({ status: "ended", id: SUBJECT_SESSION });
	});

	it.each([
		"owner OAuth",
		"wrong organization",
		"wrong principal",
		"wrong session",
		"missing client",
		"malformed client",
	])(
		"rejects self teardown with %s before ending or revoking",
		async (scenario) => {
			const ctx =
				scenario === "owner OAuth"
					? context({ type: "user", id: "owner-admin" })
					: externalContext(REVIEWER, REVIEWER_SESSION, "reviewer-client");
			if (scenario === "missing client")
				ctx.headers.delete("X-Tedix-External-Agent-Client-Record-Id");
			if (scenario === "malformed client")
				ctx.headers.set(
					"X-Tedix-External-Agent-Client-Record-Id",
					"invalid/client",
				);
			const client = createRouterClient(externalAgentIdentityContractRouter, {
				context: ctx,
			});
			await expect(
				client.endSession({
					organizationId:
						scenario === "wrong organization"
							? "00000000-0000-4000-8000-000000000099"
							: ORG,
					principalId: scenario === "wrong principal" ? SUBJECT : REVIEWER,
					sessionId:
						scenario === "wrong session" ? SUBJECT_SESSION : REVIEWER_SESSION,
					zeroWorkDisposition: {
						idempotencyKey: "must-not-end",
						reason: "Diagnostic isolation.",
					},
				}),
			).rejects.toMatchObject({
				code: scenario.endsWith("client") ? "UNAUTHORIZED" : "FORBIDDEN",
			});
			expect(
				sqlite
					.prepare("SELECT status FROM external_agent_sessions WHERE id = ?")
					.get(REVIEWER_SESSION),
			).toEqual({ status: "active" });
			expect(
				sqlite
					.prepare(
						"SELECT status FROM external_agent_mcp_credentials WHERE client_record_id = ?",
					)
					.get("reviewer-client"),
			).toEqual({ status: "active" });
		},
	);

	it("rejects lifecycle calls whose tuple does not match the gateway identity", async () => {
		const client = createRouterClient(externalAgentIdentityContractRouter, {
			context: externalContext(REVIEWER, REVIEWER_SESSION, "reviewer-client"),
		});
		await expect(
			client.recordKnowledgeCheckpoint({
				organizationId: ORG,
				principalId: SUBJECT,
				sessionId: SUBJECT_SESSION,
				idempotencyKey: "mismatch",
				workItemId: "00000000-0000-4000-8000-000000000090",
				summary: "must not be written",
				evidenceRefs: [],
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});

describe("external-agent MCP client scopes", () => {
	it("returns BAD_REQUEST for a scope removed from the target after the session started and releases the lease", async () => {
		const requestContext = context({ type: "apikey", id: "subject-key" });
		requestContext.env = {
			ENVIRONMENT: "test",
			DESCOPE_PROJECT_ID: "test-project",
			DESCOPE_MANAGEMENT_KEY: "test-key",
		} as CloudflareEnv;
		vi.spyOn(
			requestContext.db.query.externalAgentSessions,
			"findFirst",
		).mockResolvedValue({
			principal: { displayName: "Subject" },
			harness: "codex",
		} as never);
		vi.spyOn(requestContext.db.query.apps, "findFirst").mockResolvedValue({
			metadata: { mcpConfig: { descopeResourceId: "resource" } },
		} as never);
		vi.mocked(loadDescopeMcpServer).mockResolvedValueOnce({
			approvedScopes: { connectionsScopes: [{ name: "mcp:skills" }] },
		} as Awaited<ReturnType<typeof loadDescopeMcpServer>>);
		const client = createRouterClient(externalAgentIdentityContractRouter, {
			context: requestContext,
		});

		await expect(
			client.issueMcpCredential({
				organizationId: ORG,
				principalId: SUBJECT,
				sessionId: SUBJECT_SESSION,
				mcpServerUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
				scopes: ["mcp:stale"],
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringContaining("mcp:stale"),
		});
		expect(loadDescopeMcpServer).toHaveBeenCalledWith(
			expect.objectContaining({ DESCOPE_PROJECT_ID: "test-project" }),
			"resource",
		);
		expect(
			sqlite
				.prepare(
					"SELECT count(*) AS count FROM external_agent_mcp_issuance_leases",
				)
				.get(),
		).toEqual({ count: 0 });
	});

	it("reuses only the newest active client with the exact scope envelope", () => {
		const tags = [
			"external-agent",
			`external-agent-org:${ORG}`,
			`external-agent-principal:${SUBJECT}`,
			`external-agent-session:${SUBJECT_SESSION}`,
		];
		const credentials = [
			{ clientRecordId: "newest" },
			{ clientRecordId: "older" },
		];
		expect(
			selectReusableExternalAgentMcpCredential(
				credentials,
				[
					{
						id: "newest",
						status: "verified",
						scopes: ["mcp:skills"],
						tags,
					},
					{
						id: "older",
						status: "verified",
						scopes: ["mcp:skills", "mcp:observe"],
						tags,
					},
				],
				["mcp:skills"],
				tags,
			),
		).toBe(credentials[0]);
		expect(
			selectReusableExternalAgentMcpCredential(
				credentials,
				[{ id: "newest", status: "disabled", scopes: ["mcp:skills"], tags }],
				["mcp:skills"],
				tags,
			),
		).toBeNull();
		expect(
			selectReusableExternalAgentMcpCredential(
				credentials,
				[
					{
						id: "newest",
						status: "verified",
						scopes: ["mcp:skills"],
						tags: [...tags.slice(0, -1), "tedi:conflict"],
					},
				],
				["mcp:skills"],
				tags,
			),
		).toBeNull();
	});

	it("rejects authority absent from the target MCP resource", () => {
		expect(() =>
			resolveExternalAgentMcpClientScopes(["platform:admin"], {
				permissionsScopes: [],
				attributesScopes: [],
				connectionsScopes: [{ name: "mcp:skills" }, { name: "mcp:observe" }],
			}),
		).toThrow("not approved by the target resource");
	});

	it("preserves platform:admin when the target resource approves it", () => {
		expect(
			resolveExternalAgentMcpClientScopes(["platform:admin"], {
				connectionsScopes: [
					{ name: "mcp:observe" },
					{ name: "platform:admin" },
				],
			}),
		).toEqual(["platform:admin"]);
	});

	it("does not broaden a non-admin principal", () => {
		expect(
			resolveExternalAgentMcpClientScopes(["mcp:skills"], {
				connectionsScopes: [{ name: "mcp:observe" }, { name: "mcp:skills" }],
			}),
		).toEqual(["mcp:skills"]);
	});
});
