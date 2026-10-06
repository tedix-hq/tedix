import { DatabaseSync } from "node:sqlite";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import { projects } from "../schema/projects";
import { workAttempts, workEvents, workItems } from "../schema/work-items";
import { createD1Facade } from "../test/d1-facade";
import {
	buildGrantScope,
	buildGrantScopeCandidates,
	consumeGrant,
	createGrant,
	findActiveGrant,
	OWNED_CHANNEL_AUTHORIZATION_EVENT,
	OWNED_CHANNEL_AUTHORIZATION_PROOF_KEY,
	OWNED_CHANNEL_AUTHORIZATION_REVOKED_EVENT,
	resolveToolApprovalGrant,
	resolveWorkItemAuthorization,
	signOwnedChannelAuthorizationProof,
} from "./mcp-governance";

/**
 * MCP tool-approval grant lifecycle against a REAL in-memory SQLite engine via
 * the production createDbClient path (mirrors work-items-lease-sweep.test.ts).
 *
 * Invariants under test (see the CRITICAL SECURITY INVARIANTS in the batch
 * task): exact-scope matching (no prefix/substring leakage), org isolation,
 * exactly-once consumption of a "once" grant under a real concurrent race,
 * expiry enforcement, and fail-closed behavior on absence/malformed input.
 */

const REAL_DDL = `
CREATE TABLE mcp_tool_approval_grants (
	id TEXT PRIMARY KEY NOT NULL,
	organization_id TEXT NOT NULL,
	subject_id TEXT NOT NULL,
	tool_id TEXT NOT NULL,
	grant_kind TEXT NOT NULL,
	consumed_at TEXT,
	expires_at TEXT,
	reason TEXT,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_mcp_tool_approval_grants_lookup
	ON mcp_tool_approval_grants (organization_id, subject_id, tool_id);
CREATE INDEX idx_mcp_tool_approval_grants_expiry
	ON mcp_tool_approval_grants (expires_at);
CREATE TABLE work_items (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT,
 disposition TEXT NOT NULL DEFAULT 'proposed', work_kind TEXT NOT NULL DEFAULT 'other', risk_level TEXT NOT NULL DEFAULT 'medium', acceptance_contract TEXT,
 required_capabilities TEXT NOT NULL DEFAULT '[]', required_authorities TEXT NOT NULL DEFAULT '[]', admission_spec_revision TEXT NOT NULL DEFAULT 'test-revision',
 priority TEXT NOT NULL DEFAULT 'medium', accountable_owner_type TEXT, accountable_owner_id TEXT, steward_type TEXT, steward_id TEXT, reviewer_type TEXT, reviewer_id TEXT, reviewer_lease_expires_at TEXT,
 objective_id TEXT, work_class TEXT, purpose_exception_expires_at TEXT, project_id TEXT, parent_work_item_id TEXT, source_session_key TEXT, source_intent_id TEXT, due_date TEXT, deadline TEXT, start_at TEXT, duration_days INTEGER,
 provenance TEXT DEFAULT '{}', metadata TEXT DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT, accepted_at TEXT, completed_at TEXT, cancelled_at TEXT, version INTEGER NOT NULL DEFAULT 1, UNIQUE (org_id, id)
);
CREATE TABLE projects (
	id TEXT PRIMARY KEY NOT NULL,
	org_id TEXT NOT NULL,
	key TEXT NOT NULL,
	name TEXT NOT NULL,
	description TEXT,
	status TEXT NOT NULL DEFAULT 'active',
	lead_tedi_id TEXT,
	owner_user_id TEXT,
	objective_id TEXT,
	target_date TEXT,
	metadata TEXT DEFAULT '{}',
	created_at TEXT NOT NULL,
	updated_at TEXT,
	archived_at TEXT
);
CREATE TABLE tedis (
	id TEXT PRIMARY KEY NOT NULL,
	organization_id TEXT NOT NULL,
	slug TEXT NOT NULL,
	status TEXT
);
CREATE TABLE work_attempts (id TEXT PRIMARY KEY, admission_id TEXT, work_item_id TEXT NOT NULL, org_id TEXT NOT NULL, executor_type TEXT NOT NULL, executor_id TEXT NOT NULL, executor_session_id TEXT, external_session_key TEXT, run_id TEXT, runtime_state TEXT NOT NULL DEFAULT 'running', outcome TEXT, attempt_number INTEGER NOT NULL DEFAULT 1, started_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL, expires_at TEXT, finished_at TEXT, summary TEXT, version INTEGER NOT NULL DEFAULT 1, metadata TEXT NOT NULL DEFAULT '{}');
CREATE TABLE work_events (
	sequence INTEGER PRIMARY KEY AUTOINCREMENT,
	id TEXT UNIQUE NOT NULL,
	work_item_id TEXT NOT NULL,
	org_id TEXT NOT NULL,
	attempt_id TEXT,
	event_type TEXT NOT NULL,
	actor_type TEXT NOT NULL,
	actor_id TEXT,
	actor_session_id TEXT,
	payload TEXT NOT NULL DEFAULT '{}',
	occurred_at TEXT NOT NULL
);
`;

const sqliteByDb = new WeakMap<object, DatabaseSync>();

function realDb(
	beforePrepare?: (sql: string, sqlite: DatabaseSync) => void,
): DbClient {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(REAL_DDL);
	const db = createDbClient(
		createD1Facade(sqlite, { onPrepare: beforePrepare }),
	);
	sqliteByDb.set(db, sqlite);
	return db;
}

const ORG = "org-1";
const OTHER_ORG = "org-2";
const SUBJECT = "tedi-1";
const APP = "shop";
const TOOL = "delete_order";
const NOW = "2026-07-25T12:00:00.000Z";
const AUTHORIZATION_SIGNING_SECRET = "owned-channel-test-signing-key";

async function seedActiveTediLeaf(
	db: DbClient,
	input: {
		id?: string;
		subjectId?: string;
		status?: "claimed" | "in_progress";
		parentWorkItemId?: string;
	} = {},
): Promise<string> {
	const id = input.id ?? "leaf-1";
	const subjectId = input.subjectId ?? SUBJECT;
	const sqlite = sqliteByDb.get(db);
	if (!sqlite) throw new Error("missing test sqlite");
	sqlite
		.prepare(
			"INSERT OR IGNORE INTO tedis (id, organization_id, slug, status) VALUES (?, ?, 'cmo', 'active')",
		)
		.run(subjectId, ORG);
	await db
		.insert(projects)
		.values({
			id: "project-1",
			orgId: ORG,
			key: "MARKETING",
			name: "Marketing",
			status: "active",
			createdAt: "2026-07-25T08:00:00.000Z",
		})
		.onConflictDoNothing();
	await db.insert(workItems).values({
		id,
		orgId: ORG,
		title: "Improve the owned-channel campaign",
		workKind: "communication",
		disposition:
			input.status === "done"
				? "completed"
				: input.status === "cancelled"
					? "cancelled"
					: "accepted",
		priority: "high",
		projectId: "project-1",
		accountableOwnerType: "tedi",
		accountableOwnerId: subjectId,
		acceptedAt: "2026-07-25T10:00:00.000Z",
		parentWorkItemId: input.parentWorkItemId,
		metadata: {
			marketingCampaign: { key: "promptwatch-repositioning" },
		},
		createdAt: "2026-07-25T09:00:00.000Z",
	});
	await db.insert(workAttempts).values({
		id: `checkout-${id}`,
		workItemId: id,
		orgId: ORG,
		executorType: "tedi",
		executorId: subjectId,
		runtimeState: "running",
		attemptNumber: 1,
		startedAt: "2026-07-25T10:00:00.000Z",
		heartbeatAt: "2026-07-25T10:00:00.000Z",
		metadata: {},
	});
	return id;
}

function authorizationBody(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		version: 1,
		campaignKey: "promptwatch-repositioning",
		channel: "tedix.dev/blog",
		allowedAction: "content_publish",
		contentRisk: "low",
		collection: "posts",
		contentIds: ["post-1"],
		validUntil: "2026-08-01T12:00:00.000Z",
		...overrides,
	});
}

async function seedAuthorization(
	db: DbClient,
	workItemId: string,
	input: {
		authorType?: "user" | "tedi" | "external_agent" | "system";
		authorId?: string | null;
		body?: string;
		createdAt?: string;
		eventType?: string;
		sign?: boolean;
	} = {},
): Promise<void> {
	const id = crypto.randomUUID();
	const authorId =
		input.authorId === undefined ? "owner-user-1" : input.authorId;
	const body = input.body ?? authorizationBody();
	const eventType = input.eventType ?? OWNED_CHANNEL_AUTHORIZATION_EVENT;
	const createdAt = input.createdAt ?? "2026-07-25T11:00:00.000Z";
	const signature =
		input.sign !== false &&
		authorId &&
		(eventType === OWNED_CHANNEL_AUTHORIZATION_EVENT ||
			eventType === OWNED_CHANNEL_AUTHORIZATION_REVOKED_EVENT)
			? await signOwnedChannelAuthorizationProof(AUTHORIZATION_SIGNING_SECRET, {
					commentId: id,
					workItemId,
					organizationId: ORG,
					authorId,
					eventType,
					body,
					createdAt,
				})
			: null;
	await db.insert(workEvents).values({
		id,
		workItemId,
		orgId: ORG,
		actorType: input.authorType ?? "user",
		actorId: authorId,
		eventType,
		payload: signature
			? {
					body,
					[OWNED_CHANNEL_AUTHORIZATION_PROOF_KEY]: {
						version: 1,
						signature,
					},
				}
			: { body },
		occurredAt: createdAt,
	});
}

const ownedChannelCall = {
	organizationId: ORG,
	subjectId: SUBJECT,
	appSlug: "tedix-unified",
	toolId: "cms_landing__content_publish",
	args: { collection: "posts", id: "post-1" },
	authorizationSigningSecret: AUTHORIZATION_SIGNING_SECRET,
	nowIso: NOW,
};

describe("buildGrantScope / buildGrantScopeCandidates", () => {
	it("normalizes case and whitespace", () => {
		expect(buildGrantScope(" Shop ", " Delete_Order ")).toBe(
			"shop:delete_order",
		);
	});

	it("builds specificity-ordered candidates: exact, app-wildcard, global", () => {
		expect(buildGrantScopeCandidates(APP, TOOL)).toEqual([
			"shop:delete_order",
			"shop:*",
			"*:*",
		]);
	});

	it("rejects a half-open '*:tool' pattern (would leak across apps)", () => {
		expect(() => buildGrantScope("*", TOOL)).toThrow();
	});

	it("allows the fully-global '*:*' pattern", () => {
		expect(buildGrantScope("*", "*")).toBe("*:*");
	});
});

describe("MCP tool-approval grants — real SQLite lifecycle", () => {
	it("an exact-scope 'always' grant approves repeatedly without consumption", async () => {
		const db = realDb();
		const grant = await createGrant(db, {
			organizationId: ORG,
			subjectId: SUBJECT,
			appSlug: APP,
			toolId: TOOL,
			grantKind: "always",
			reason: "operator pre-approved bulk cleanup",
		});
		expect(grant.consumedAt).toBeNull();

		for (let i = 0; i < 3; i++) {
			const found = await findActiveGrant(db, {
				organizationId: ORG,
				subjectId: SUBJECT,
				appSlug: APP,
				toolId: TOOL,
				grantKind: "always",
			});
			expect(found?.id).toBe(grant.id);
		}
	});

	it("a grant for tool A never satisfies a call to tool B (exact match only)", async () => {
		const db = realDb();
		await createGrant(db, {
			organizationId: ORG,
			subjectId: SUBJECT,
			appSlug: APP,
			toolId: "delete_order",
			grantKind: "always",
		});

		const forDifferentTool = await findActiveGrant(db, {
			organizationId: ORG,
			subjectId: SUBJECT,
			appSlug: APP,
			toolId: "delete_orders_bulk", // shares a prefix with "delete_order" — must NOT match
			grantKind: "always",
		});
		expect(forDifferentTool).toBeUndefined();

		const forPrefixedApp = await findActiveGrant(db, {
			organizationId: ORG,
			subjectId: SUBJECT,
			appSlug: "shopify", // shares a prefix with "shop" — must NOT match
			toolId: TOOL,
			grantKind: "always",
		});
		expect(forPrefixedApp).toBeUndefined();
	});

	it("an app-wildcard grant covers any tool in that app but not other apps", async () => {
		const db = realDb();
		await createGrant(db, {
			organizationId: ORG,
			subjectId: SUBJECT,
			appSlug: APP,
			toolId: "*",
			grantKind: "always",
		});

		const inApp = await findActiveGrant(db, {
			organizationId: ORG,
			subjectId: SUBJECT,
			appSlug: APP,
			toolId: "any_tool_at_all",
			grantKind: "always",
		});
		expect(inApp).toBeDefined();

		const otherApp = await findActiveGrant(db, {
			organizationId: ORG,
			subjectId: SUBJECT,
			appSlug: "other-app",
			toolId: TOOL,
			grantKind: "always",
		});
		expect(otherApp).toBeUndefined();
	});

	it("a grant scoped to organization X never satisfies a call under organization Y", async () => {
		const db = realDb();
		await createGrant(db, {
			organizationId: ORG,
			subjectId: SUBJECT,
			appSlug: APP,
			toolId: TOOL,
			grantKind: "always",
		});

		const crossOrg = await findActiveGrant(db, {
			organizationId: OTHER_ORG,
			subjectId: SUBJECT,
			appSlug: APP,
			toolId: TOOL,
			grantKind: "always",
		});
		expect(crossOrg).toBeUndefined();
	});

	it("a grant issued to one subject never satisfies a call from a different subject", async () => {
		const db = realDb();
		await createGrant(db, {
			organizationId: ORG,
			subjectId: SUBJECT,
			appSlug: APP,
			toolId: TOOL,
			grantKind: "always",
		});

		const otherSubject = await findActiveGrant(db, {
			organizationId: ORG,
			subjectId: "tedi-2",
			appSlug: APP,
			toolId: TOOL,
			grantKind: "always",
		});
		expect(otherSubject).toBeUndefined();
	});

	it("an expired grant never satisfies a call", async () => {
		const db = realDb();
		await createGrant(db, {
			organizationId: ORG,
			subjectId: SUBJECT,
			appSlug: APP,
			toolId: TOOL,
			grantKind: "always",
			expiresAt: "2026-01-01T00:00:00.000Z",
		});

		const expired = await findActiveGrant(db, {
			organizationId: ORG,
			subjectId: SUBJECT,
			appSlug: APP,
			toolId: TOOL,
			grantKind: "always",
			nowIso: "2026-06-01T00:00:00.000Z",
		});
		expect(expired).toBeUndefined();

		const stillValid = await findActiveGrant(db, {
			organizationId: ORG,
			subjectId: SUBJECT,
			appSlug: APP,
			toolId: TOOL,
			grantKind: "always",
			nowIso: "2025-06-01T00:00:00.000Z",
		});
		expect(stillValid).toBeDefined();
	});

	it("a NULL expiry never expires", async () => {
		const db = realDb();
		await createGrant(db, {
			organizationId: ORG,
			subjectId: SUBJECT,
			appSlug: APP,
			toolId: TOOL,
			grantKind: "always",
			expiresAt: null,
		});
		const found = await findActiveGrant(db, {
			organizationId: ORG,
			subjectId: SUBJECT,
			appSlug: APP,
			toolId: TOOL,
			grantKind: "always",
			nowIso: "2099-01-01T00:00:00.000Z",
		});
		expect(found).toBeDefined();
	});

	it("grantKind must match exactly — an 'always' grant does not satisfy an 'once' lookup and vice versa", async () => {
		const db = realDb();
		await createGrant(db, {
			organizationId: ORG,
			subjectId: SUBJECT,
			appSlug: APP,
			toolId: TOOL,
			grantKind: "always",
		});
		const onceLookup = await findActiveGrant(db, {
			organizationId: ORG,
			subjectId: SUBJECT,
			appSlug: APP,
			toolId: TOOL,
			grantKind: "once",
		});
		expect(onceLookup).toBeUndefined();
	});

	it("consumeGrant is a CAS: a second consume on the same grant fails", async () => {
		const db = realDb();
		const grant = await createGrant(db, {
			organizationId: ORG,
			subjectId: SUBJECT,
			appSlug: APP,
			toolId: TOOL,
			grantKind: "once",
		});

		const first = await consumeGrant(db, {
			grantId: grant.id,
			organizationId: ORG,
		});
		expect(first.consumed).toBe(true);

		const second = await consumeGrant(db, {
			grantId: grant.id,
			organizationId: ORG,
		});
		expect(second.consumed).toBe(false);
	});

	it("consumeGrant never consumes a grant under the wrong organization", async () => {
		const db = realDb();
		const grant = await createGrant(db, {
			organizationId: ORG,
			subjectId: SUBJECT,
			appSlug: APP,
			toolId: TOOL,
			grantKind: "once",
		});
		const wrongOrg = await consumeGrant(db, {
			grantId: grant.id,
			organizationId: OTHER_ORG,
		});
		expect(wrongOrg.consumed).toBe(false);

		// Still consumable under the correct org afterward.
		const rightOrg = await consumeGrant(db, {
			grantId: grant.id,
			organizationId: ORG,
		});
		expect(rightOrg.consumed).toBe(true);
	});

	it("a consumed 'once' grant is inactive: findActiveGrant no longer returns it", async () => {
		const db = realDb();
		const grant = await createGrant(db, {
			organizationId: ORG,
			subjectId: SUBJECT,
			appSlug: APP,
			toolId: TOOL,
			grantKind: "once",
		});
		await consumeGrant(db, { grantId: grant.id, organizationId: ORG });

		const found = await findActiveGrant(db, {
			organizationId: ORG,
			subjectId: SUBJECT,
			appSlug: APP,
			toolId: TOOL,
			grantKind: "once",
		});
		expect(found).toBeUndefined();
	});

	it("a 'once' grant is consumable EXACTLY ONCE under a real concurrent race (20 racers, 1 winner)", async () => {
		const db = realDb();
		const grant = await createGrant(db, {
			organizationId: ORG,
			subjectId: SUBJECT,
			appSlug: APP,
			toolId: TOOL,
			grantKind: "once",
		});

		const RACERS = 20;
		const results = await Promise.all(
			Array.from({ length: RACERS }, () =>
				consumeGrant(db, { grantId: grant.id, organizationId: ORG }),
			),
		);

		const winners = results.filter((r) => r.consumed);
		expect(winners).toHaveLength(1);
		expect(results.filter((r) => !r.consumed)).toHaveLength(RACERS - 1);
	});

	it("resolveToolApprovalGrant races: exactly one of two concurrent 'once' calls is approved", async () => {
		const db = realDb();
		await createGrant(db, {
			organizationId: ORG,
			subjectId: SUBJECT,
			appSlug: APP,
			toolId: TOOL,
			grantKind: "once",
		});

		const [a, b] = await Promise.all([
			resolveToolApprovalGrant(db, {
				organizationId: ORG,
				subjectId: SUBJECT,
				appSlug: APP,
				toolId: TOOL,
				grantKind: "once",
			}),
			resolveToolApprovalGrant(db, {
				organizationId: ORG,
				subjectId: SUBJECT,
				appSlug: APP,
				toolId: TOOL,
				grantKind: "once",
			}),
		]);

		const approvedCount = [a, b].filter((r) => r.approved).length;
		expect(approvedCount).toBe(1);
	});

	it("resolveToolApprovalGrant returns approved:false (fail-closed) when no grant exists", async () => {
		const db = realDb();
		const result = await resolveToolApprovalGrant(db, {
			organizationId: ORG,
			subjectId: SUBJECT,
			appSlug: APP,
			toolId: TOOL,
			grantKind: "once",
		});
		expect(result).toEqual({ approved: false, grantId: null });
	});

	it("resolveToolApprovalGrant with an 'always' grant approves without consuming — repeatable", async () => {
		const db = realDb();
		const grant = await createGrant(db, {
			organizationId: ORG,
			subjectId: SUBJECT,
			appSlug: APP,
			toolId: TOOL,
			grantKind: "always",
		});

		const first = await resolveToolApprovalGrant(db, {
			organizationId: ORG,
			subjectId: SUBJECT,
			appSlug: APP,
			toolId: TOOL,
			grantKind: "always",
		});
		const second = await resolveToolApprovalGrant(db, {
			organizationId: ORG,
			subjectId: SUBJECT,
			appSlug: APP,
			toolId: TOOL,
			grantKind: "always",
		});
		expect(first).toEqual({ approved: true, grantId: grant.id });
		expect(second).toEqual({ approved: true, grantId: grant.id });
	});

	it("most-specific scope wins: an exact-tool grant is returned over a same-app wildcard grant", async () => {
		const db = realDb();
		await createGrant(db, {
			organizationId: ORG,
			subjectId: SUBJECT,
			appSlug: APP,
			toolId: "*",
			grantKind: "always",
			reason: "wildcard",
		});
		const exact = await createGrant(db, {
			organizationId: ORG,
			subjectId: SUBJECT,
			appSlug: APP,
			toolId: TOOL,
			grantKind: "always",
			reason: "exact",
		});

		const found = await findActiveGrant(db, {
			organizationId: ORG,
			subjectId: SUBJECT,
			appSlug: APP,
			toolId: TOOL,
			grantKind: "always",
		});
		expect(found?.id).toBe(exact.id);
	});
});

describe("Work Item owned-channel authorization — real SQLite", () => {
	it("approves a matching user receipt on the one active tedi-owned leaf", async () => {
		const db = realDb();
		const leafId = await seedActiveTediLeaf(db);
		await seedAuthorization(db, leafId);

		await expect(
			resolveWorkItemAuthorization(db, ownedChannelCall),
		).resolves.toMatchObject({
			approved: true,
			reason: "active_user_receipt",
			workItemId: leafId,
			campaignKey: "promptwatch-repositioning",
		});
	});

	it("admits the exact landing tool id emitted by the aggregate gateway", async () => {
		const db = realDb();
		const leafId = await seedActiveTediLeaf(db);
		await seedAuthorization(db, leafId);

		await expect(
			resolveWorkItemAuthorization(db, {
				...ownedChannelCall,
				toolId: "cms_landing__content_publish",
			}),
		).resolves.toMatchObject({ approved: true, workItemId: leafId });
	});

	it("refuses every retired blog publishing route", async () => {
		for (const route of [
			{ appSlug: "tedix-unified", toolId: "cms_tedix__content_publish" },
			{ appSlug: "tedix-unified", toolId: "cms-tedix__content_publish" },
			{ appSlug: "cms-tedix", toolId: "content_publish" },
		]) {
			const db = realDb();
			const leafId = await seedActiveTediLeaf(db);
			await seedAuthorization(db, leafId);
			await expect(
				resolveWorkItemAuthorization(db, { ...ownedChannelCall, ...route }),
			).resolves.toMatchObject({
				approved: false,
				reason: "tool_scope_mismatch",
			});
		}
	});

	it("does not carry old-domain authorization receipts into the new lane", async () => {
		const db = realDb();
		const leafId = await seedActiveTediLeaf(db);
		await seedAuthorization(db, leafId, {
			body: authorizationBody({ channel: "blog.tedix.dev" }),
		});
		await expect(
			resolveWorkItemAuthorization(db, ownedChannelCall),
		).resolves.toMatchObject({
			approved: false,
			reason: "no_current_user_authorization",
		});
	});

	it("admits the direct per-tenant CMS routes the edge boundary also accepts", async () => {
		for (const toolId of ["cms__content_publish", "content_publish"]) {
			const db = realDb();
			const leafId = await seedActiveTediLeaf(db);
			await seedAuthorization(db, leafId);
			await expect(
				resolveWorkItemAuthorization(db, {
					...ownedChannelCall,
					appSlug: "cms-tedix-landing",
					toolId,
				}),
			).resolves.toMatchObject({ approved: true, workItemId: leafId });
		}
	});

	it("stays an allowlist: a neighbouring publish tool or app is still refused", async () => {
		const cases = [
			// Right shape, wrong app — the edge's connection-label catch-all is
			// deliberately NOT reproduced here, so this must not slip through.
			{ appSlug: "cms-other", toolId: "cms_other__content_publish" },
			// Right app, adjacent tool.
			{ appSlug: "tedix-unified", toolId: "cms_landing__content_unpublish" },
			{ appSlug: "tedix-unified", toolId: "cms_landing__content_update" },
		];
		for (const scope of cases) {
			const db = realDb();
			const leafId = await seedActiveTediLeaf(db);
			await seedAuthorization(db, leafId);
			await expect(
				resolveWorkItemAuthorization(db, { ...ownedChannelCall, ...scope }),
			).resolves.toMatchObject({
				approved: false,
				reason: "tool_scope_mismatch",
			});
		}
	});

	it("rejects historical unsigned receipts and receipts changed after signing", async () => {
		for (const mutation of ["unsigned", "changed"] as const) {
			const db = realDb();
			const leafId = await seedActiveTediLeaf(db);
			await seedAuthorization(db, leafId, {
				sign: mutation !== "unsigned",
			});
			if (mutation === "changed") {
				await db
					.update(workEvents)
					.set({
						payload: {
							body: authorizationBody({
								contentIds: ["post-1", "post-forged"],
							}),
						},
					})
					.where(eq(workEvents.workItemId, leafId));
			}
			await expect(
				resolveWorkItemAuthorization(db, ownedChannelCall),
			).resolves.toMatchObject({
				approved: false,
				reason: "no_current_user_authorization",
			});
		}
	});

	it("sees a signed revocation inserted at the final SQLite linearization point", async () => {
		const revocationId = "revocation-at-linearization";
		const revocationBody = JSON.stringify({
			version: 1,
			campaignKey: "promptwatch-repositioning",
			reason: "owner stopped the lane during authorization",
		});
		const revocationCreatedAt = "2026-07-25T11:30:00.000Z";
		const signature = await signOwnedChannelAuthorizationProof(
			AUTHORIZATION_SIGNING_SECRET,
			{
				commentId: revocationId,
				workItemId: "leaf-1",
				organizationId: ORG,
				authorId: "owner-user-1",
				eventType: OWNED_CHANNEL_AUTHORIZATION_REVOKED_EVENT,
				body: revocationBody,
				createdAt: revocationCreatedAt,
			},
		);
		let injected = false;
		const db = realDb((statement, sqlite) => {
			if (injected || !statement.includes("owned-channel-linearization")) {
				return;
			}
			injected = true;
			sqlite
				.prepare(
					`INSERT INTO work_events
					 (id, work_item_id, org_id, actor_type, actor_id, event_type, payload, occurred_at)
					 VALUES (?, 'leaf-1', ?, 'user', 'owner-user-1', ?, ?, ?)`,
				)
				.run(
					revocationId,
					ORG,
					OWNED_CHANNEL_AUTHORIZATION_REVOKED_EVENT,
					JSON.stringify({
						body: revocationBody,
						[OWNED_CHANNEL_AUTHORIZATION_PROOF_KEY]: {
							version: 1,
							signature,
						},
					}),
					revocationCreatedAt,
				);
		});
		const leafId = await seedActiveTediLeaf(db);
		await seedAuthorization(db, leafId);

		await expect(
			resolveWorkItemAuthorization(db, ownedChannelCall),
		).resolves.toMatchObject({
			approved: false,
			reason: "authorization_revoked",
			workItemId: leafId,
		});
		expect(injected).toBe(true);
	});

	it("lets one bounded owner/admin campaign receipt authorize a verified descendant leaf", async () => {
		const db = realDb();
		await db.insert(workItems).values({
			id: "campaign-1",
			orgId: ORG,
			title: "PromptWatch repositioning campaign",
			workKind: "communication",
			disposition: "accepted",
			accountableOwnerType: "tedi",
			accountableOwnerId: SUBJECT,
			acceptedAt: "2026-07-25T08:00:00.000Z",
			priority: "high",
			projectId: "project-1",
			metadata: {
				marketingCampaign: { key: "promptwatch-repositioning" },
			},
			createdAt: "2026-07-25T08:00:00.000Z",
		});
		const leafId = await seedActiveTediLeaf(db, {
			parentWorkItemId: "campaign-1",
		});
		await seedAuthorization(db, "campaign-1");

		await expect(
			resolveWorkItemAuthorization(db, ownedChannelCall),
		).resolves.toMatchObject({
			approved: true,
			workItemId: leafId,
			authorizationScopeWorkItemId: "campaign-1",
			attemptId: `checkout-${leafId}`,
		});
	});

	it("honors a later owner/admin revocation on the authorized campaign scope", async () => {
		const db = realDb();
		const leafId = await seedActiveTediLeaf(db);
		await seedAuthorization(db, leafId, {
			createdAt: "2026-07-25T10:30:00.000Z",
		});
		await seedAuthorization(db, leafId, {
			eventType: OWNED_CHANNEL_AUTHORIZATION_REVOKED_EVENT,
			body: JSON.stringify({
				version: 1,
				campaignKey: "promptwatch-repositioning",
				reason: "owner paused the campaign",
			}),
			createdAt: "2026-07-25T11:30:00.000Z",
		});

		await expect(
			resolveWorkItemAuthorization(db, ownedChannelCall),
		).resolves.toMatchObject({
			approved: false,
			reason: "authorization_revoked",
			workItemId: leafId,
		});
	});

	it("fails closed when authorization and revocation share a timestamp", async () => {
		const db = realDb();
		const leafId = await seedActiveTediLeaf(db);
		await seedAuthorization(db, leafId, {
			createdAt: "2026-07-25T11:30:00.000Z",
		});
		await seedAuthorization(db, leafId, {
			eventType: OWNED_CHANNEL_AUTHORIZATION_REVOKED_EVENT,
			body: JSON.stringify({
				version: 1,
				campaignKey: "promptwatch-repositioning",
				reason: "owner paused the campaign",
			}),
			createdAt: "2026-07-25T11:30:00.000Z",
		});

		await expect(
			resolveWorkItemAuthorization(db, ownedChannelCall),
		).resolves.toMatchObject({
			approved: false,
			reason: "authorization_revoked",
			workItemId: leafId,
		});
	});

	it("allows a later explicit authorization to supersede an older revocation", async () => {
		const db = realDb();
		const leafId = await seedActiveTediLeaf(db);
		await seedAuthorization(db, leafId, {
			eventType: OWNED_CHANNEL_AUTHORIZATION_REVOKED_EVENT,
			body: JSON.stringify({
				version: 1,
				campaignKey: "promptwatch-repositioning",
				reason: "owner paused the campaign",
			}),
			createdAt: "2026-07-25T10:30:00.000Z",
		});
		await seedAuthorization(db, leafId, {
			createdAt: "2026-07-25T11:30:00.000Z",
		});

		await expect(
			resolveWorkItemAuthorization(db, ownedChannelCall),
		).resolves.toMatchObject({
			approved: true,
			reason: "active_user_receipt",
			workItemId: leafId,
		});
	});

	it("denies when the campaign project is paused", async () => {
		const db = realDb();
		const leafId = await seedActiveTediLeaf(db);
		await seedAuthorization(db, leafId);
		await db
			.update(projects)
			.set({ status: "paused" })
			.where(eq(projects.id, "project-1"));

		await expect(
			resolveWorkItemAuthorization(db, ownedChannelCall),
		).resolves.toMatchObject({
			approved: false,
			reason: "no_active_tedi_leaf",
		});
	});

	it("denies absent, malformed, expired, overlong, and unattributed receipts", async () => {
		const cases = [
			{ body: "not-json" },
			{
				body: authorizationBody({
					validUntil: "2026-07-25T11:59:59.000Z",
				}),
			},
			{
				body: authorizationBody({
					validUntil: "2026-09-01T11:00:00.000Z",
				}),
			},
			// A `system` receipt has no accountable principal behind it and is
			// still refused. `tedi` and `external_agent` moved OUT of this list
			// deliberately — see the separation-of-duties tests below.
			{ authorType: "system" as const },
			{ authorId: null },
			{ authorId: " " },
		];
		for (const entry of cases) {
			const db = realDb();
			const leafId = await seedActiveTediLeaf(db);
			await seedAuthorization(db, leafId, entry);
			await expect(
				resolveWorkItemAuthorization(db, ownedChannelCall),
			).resolves.toMatchObject({
				approved: false,
				reason: "no_current_user_authorization",
				workItemId: leafId,
			});
		}
	});

	// The default fixture window is 7 days + 1 hour, which a human may grant and
	// an agent may not. Agent approval cases therefore state their own window.
	const withinAgentWindow = authorizationBody({
		validUntil: "2026-07-30T12:00:00.000Z",
	});

	it("approves an external-agent receipt — the authorizer need not be human", async () => {
		const db = realDb();
		const leafId = await seedActiveTediLeaf(db);
		await seedAuthorization(db, leafId, {
			authorType: "external_agent",
			authorId: "external-agent-principal-1",
			body: withinAgentWindow,
		});

		await expect(
			resolveWorkItemAuthorization(db, ownedChannelCall),
		).resolves.toMatchObject({
			approved: true,
			workItemId: leafId,
			campaignKey: "promptwatch-repositioning",
		});
	});

	it("approves a tedi receipt authored by a DIFFERENT tedi than the publisher", async () => {
		const db = realDb();
		const leafId = await seedActiveTediLeaf(db);
		await seedAuthorization(db, leafId, {
			authorType: "tedi",
			authorId: "tedi-reviewer",
			body: withinAgentWindow,
		});

		await expect(
			resolveWorkItemAuthorization(db, ownedChannelCall),
		).resolves.toMatchObject({
			approved: true,
			workItemId: leafId,
		});
	});

	it("SEPARATION OF DUTIES: denies a tedi receipt authored by the publishing tedi itself", async () => {
		const db = realDb();
		const leafId = await seedActiveTediLeaf(db);
		// SUBJECT is the tedi that holds the leaf and will publish. Authorizing
		// its own publish would collapse a two-party control into one party.
		await seedAuthorization(db, leafId, {
			authorType: "tedi",
			authorId: SUBJECT,
		});

		await expect(
			resolveWorkItemAuthorization(db, ownedChannelCall),
		).resolves.toMatchObject({
			approved: false,
			reason: "no_current_user_authorization",
			workItemId: leafId,
		});
	});

	it("holds a non-human authorizer to the shorter agent window, not the 30-day human ceiling", async () => {
		// 14 days out: comfortably inside the human ceiling, past the agent one.
		const beyondAgentWindow = authorizationBody({
			validUntil: "2026-08-08T11:00:00.000Z",
		});
		for (const authorType of ["external_agent", "tedi"] as const) {
			const db = realDb();
			const leafId = await seedActiveTediLeaf(db);
			await seedAuthorization(db, leafId, {
				authorType,
				authorId: `${authorType}-principal`,
				body: beyondAgentWindow,
			});
			await expect(
				resolveWorkItemAuthorization(db, ownedChannelCall),
			).resolves.toMatchObject({
				approved: false,
				reason: "no_current_user_authorization",
				workItemId: leafId,
			});
		}

		// The identical window from a human authorizer is still fine, which is
		// what proves the ceiling is author-derived and not just "too long".
		const db = realDb();
		const leafId = await seedActiveTediLeaf(db);
		await seedAuthorization(db, leafId, { body: beyondAgentWindow });
		await expect(
			resolveWorkItemAuthorization(db, ownedChannelCall),
		).resolves.toMatchObject({ approved: true, workItemId: leafId });
	});

	it("honours a revocation authored by an agent, not only by a human", async () => {
		const db = realDb();
		const leafId = await seedActiveTediLeaf(db);
		await seedAuthorization(db, leafId);
		await seedAuthorization(db, leafId, {
			authorType: "external_agent",
			authorId: "external-agent-principal-1",
			eventType: OWNED_CHANNEL_AUTHORIZATION_REVOKED_EVENT,
			body: JSON.stringify({
				version: 1,
				campaignKey: "promptwatch-repositioning",
				reason: "reviewing agent stopped the lane",
			}),
			createdAt: "2026-07-25T11:30:00.000Z",
		});

		await expect(
			resolveWorkItemAuthorization(db, ownedChannelCall),
		).resolves.toMatchObject({
			approved: false,
			workItemId: leafId,
		});
	});

	it("denies a receipt on another leaf or for another tedi", async () => {
		const db = realDb();
		const cmoLeaf = await seedActiveTediLeaf(db);
		const otherLeaf = await seedActiveTediLeaf(db, {
			id: "leaf-2",
			subjectId: "tedi-2",
		});
		await seedAuthorization(db, otherLeaf);

		await expect(
			resolveWorkItemAuthorization(db, ownedChannelCall),
		).resolves.toMatchObject({
			approved: false,
			reason: "no_current_user_authorization",
			workItemId: cmoLeaf,
		});
	});

	it("denies an ambiguous active claim instead of choosing a receipt", async () => {
		const db = realDb();
		const first = await seedActiveTediLeaf(db);
		await seedAuthorization(db, first);
		await seedActiveTediLeaf(db, { id: "leaf-2" });

		await expect(
			resolveWorkItemAuthorization(db, ownedChannelCall),
		).resolves.toMatchObject({
			approved: false,
			reason: "ambiguous_active_tedi_leaf",
		});
	});

	it("denies released, expired, non-CMO, and non-leaf claim projections", async () => {
		for (const mutation of ["released", "expired", "non-cmo", "non-leaf"]) {
			const db = realDb();
			const leafId = await seedActiveTediLeaf(db);
			await seedAuthorization(db, leafId);
			const sqlite = sqliteByDb.get(db)!;
			if (mutation === "released") {
				sqlite
					.prepare(
						"UPDATE work_attempts SET runtime_state = 'finished', outcome = 'succeeded', finished_at = ? WHERE work_item_id = ?",
					)
					.run(NOW, leafId);
			} else if (mutation === "expired") {
				sqlite
					.prepare(
						"UPDATE work_attempts SET expires_at = '2026-07-25T11:59:59.000Z' WHERE work_item_id = ?",
					)
					.run(leafId);
			} else if (mutation === "non-cmo") {
				sqlite
					.prepare("UPDATE tedis SET slug = 'cto' WHERE id = ?")
					.run(SUBJECT);
			} else {
				await db.insert(workItems).values({
					id: "child-1",
					orgId: ORG,
					title: "Child",
					workKind: "communication",
					disposition: "accepted",
					accountableOwnerType: "tedi",
					accountableOwnerId: SUBJECT,
					acceptedAt: "2026-07-25T11:00:00.000Z",
					priority: "low",
					projectId: "project-1",
					parentWorkItemId: leafId,
					createdAt: "2026-07-25T11:00:00.000Z",
				});
			}

			await expect(
				resolveWorkItemAuthorization(db, ownedChannelCall),
			).resolves.toMatchObject({
				approved: false,
				reason: "no_active_tedi_leaf",
			});
		}
	});

	it("denies a receipt whose campaign key is not canonical on its scope", async () => {
		const db = realDb();
		const leafId = await seedActiveTediLeaf(db);
		await seedAuthorization(db, leafId, {
			body: authorizationBody({ campaignKey: "unrelated-campaign" }),
		});
		await expect(
			resolveWorkItemAuthorization(db, ownedChannelCall),
		).resolves.toMatchObject({
			approved: false,
			reason: "no_current_user_authorization",
		});
	});

	it("denies the wrong gateway tool or publish arguments", async () => {
		const db = realDb();
		const leafId = await seedActiveTediLeaf(db);
		await seedAuthorization(db, leafId);

		await expect(
			resolveWorkItemAuthorization(db, {
				...ownedChannelCall,
				toolId: "cms_landing__content_unpublish",
			}),
		).resolves.toMatchObject({
			approved: false,
			reason: "tool_scope_mismatch",
		});
		await expect(
			resolveWorkItemAuthorization(db, {
				...ownedChannelCall,
				args: { collection: "pages", id: "page-1" },
			}),
		).resolves.toMatchObject({
			approved: false,
			reason: "argument_scope_mismatch",
		});
		await expect(
			resolveWorkItemAuthorization(db, {
				...ownedChannelCall,
				args: { collection: "posts", id: "post-not-authorized" },
			}),
		).resolves.toMatchObject({
			approved: false,
			reason: "no_current_user_authorization",
		});
	});
});
