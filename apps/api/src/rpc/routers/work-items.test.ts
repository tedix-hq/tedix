import { createD1Facade } from "@tedix/db/test/d1-facade";
import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { workItemsContractRouter } from "./work-items";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const OBJECTIVE_ID = "44444444-4444-4444-8444-444444444444";
const PURPOSE = { objectiveId: OBJECTIVE_ID } as const;
const DDL = `
CREATE TABLE organization_members (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, user_id TEXT, descope_user_id TEXT NOT NULL, email TEXT NOT NULL, name TEXT, avatar_url TEXT, role TEXT NOT NULL, custom_permissions TEXT, status TEXT NOT NULL DEFAULT 'active', invited_at TEXT, invite_accepted_at TEXT, invited_by TEXT, last_active_at TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE tedi_objectives (id TEXT PRIMARY KEY, org_id TEXT NOT NULL);
CREATE TABLE projects (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, key TEXT NOT NULL, objective_id TEXT, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL);
CREATE TABLE work_items (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT,
 disposition TEXT NOT NULL DEFAULT 'proposed', work_kind TEXT NOT NULL DEFAULT 'other', risk_level TEXT NOT NULL DEFAULT 'medium', acceptance_contract TEXT,
 required_capabilities TEXT NOT NULL DEFAULT '[]', required_authorities TEXT NOT NULL DEFAULT '[]', resource_scopes TEXT NOT NULL DEFAULT '[]', budget_limit_micros INTEGER,
 priority TEXT NOT NULL DEFAULT 'medium', accountable_owner_type TEXT, accountable_owner_id TEXT, steward_type TEXT, steward_id TEXT, reviewer_type TEXT, reviewer_id TEXT, reviewer_lease_expires_at TEXT,
 objective_id TEXT, work_class TEXT, purpose_exception_expires_at TEXT, project_id TEXT, parent_work_item_id TEXT, source_session_key TEXT, source_intent_id TEXT,
 due_date TEXT, deadline TEXT, start_at TEXT, duration_days INTEGER, provenance TEXT DEFAULT '{}', metadata TEXT DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT, accepted_at TEXT,
 completed_at TEXT, cancelled_at TEXT, admission_spec_revision TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))), version INTEGER NOT NULL DEFAULT 1);
CREATE UNIQUE INDEX uniq_work_items_org_source_intent ON work_items(org_id, source_intent_id);
CREATE TABLE work_item_comments (id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL, org_id TEXT NOT NULL, author_type TEXT NOT NULL, author_id TEXT, body TEXT NOT NULL, metadata TEXT DEFAULT '{}', created_at TEXT NOT NULL);
CREATE TABLE work_item_relations (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, from_work_item_id TEXT NOT NULL, to_work_item_id TEXT NOT NULL, relation_type TEXT NOT NULL, metadata TEXT DEFAULT '{}', created_at TEXT NOT NULL);
CREATE UNIQUE INDEX uniq_work_item_relation ON work_item_relations(from_work_item_id,to_work_item_id,relation_type);
CREATE TABLE work_item_corroborations (id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL, org_id TEXT NOT NULL, principal_type TEXT NOT NULL, principal_id TEXT NOT NULL, session_id TEXT, evidence_ref TEXT NOT NULL, stance TEXT NOT NULL DEFAULT 'corroborates', body TEXT NOT NULL, occurred_at TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX uniq_work_item_corroboration_principal ON work_item_corroborations(org_id,work_item_id,principal_type,principal_id);
CREATE TABLE work_item_projections (id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL, org_id TEXT NOT NULL, provider TEXT NOT NULL, direction TEXT NOT NULL DEFAULT 'projection', status TEXT NOT NULL DEFAULT 'pending', external_id TEXT, external_url TEXT, external_project_id TEXT, external_section_id TEXT, last_synced_at TEXT, last_error TEXT, sync_cursor TEXT, provider_state TEXT DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT);
CREATE TABLE work_attempts (id TEXT PRIMARY KEY, admission_id TEXT, work_item_id TEXT NOT NULL, org_id TEXT NOT NULL, executor_type TEXT NOT NULL, executor_id TEXT NOT NULL, executor_session_id TEXT, external_session_key TEXT, run_id TEXT, runtime_state TEXT NOT NULL, outcome TEXT, attempt_number INTEGER NOT NULL, started_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL, expires_at TEXT, finished_at TEXT, summary TEXT, version INTEGER NOT NULL DEFAULT 1, metadata TEXT NOT NULL DEFAULT '{}');
CREATE TABLE work_evidence (id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL, org_id TEXT NOT NULL, attempt_id TEXT, claim_key TEXT NOT NULL, kind TEXT NOT NULL, uri TEXT NOT NULL, digest TEXT, media_type TEXT, label TEXT, submitted_by_type TEXT NOT NULL, submitted_by_id TEXT NOT NULL, submitted_by_session_id TEXT, disposition TEXT NOT NULL DEFAULT 'pending', reviewed_by_type TEXT, reviewed_by_id TEXT, reviewed_by_session_id TEXT, review_reason TEXT, submitted_at TEXT NOT NULL, reviewed_at TEXT, version INTEGER NOT NULL DEFAULT 1, metadata TEXT NOT NULL DEFAULT '{}');
CREATE TABLE work_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, org_id TEXT NOT NULL, work_item_id TEXT NOT NULL, attempt_id TEXT, event_type TEXT NOT NULL, actor_type TEXT NOT NULL, actor_id TEXT NOT NULL, actor_session_id TEXT, payload TEXT NOT NULL DEFAULT '{}', occurred_at TEXT NOT NULL);
CREATE TABLE external_agent_principals (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, key TEXT NOT NULL, display_name TEXT NOT NULL, status TEXT NOT NULL, credential_binding_type TEXT NOT NULL, credential_binding_id TEXT NOT NULL, created_by_type TEXT NOT NULL, created_by_id TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE work_resource_pools (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, resource_key TEXT NOT NULL, allocation_mode TEXT NOT NULL, capacity INTEGER NOT NULL, owner_ref TEXT, enabled INTEGER NOT NULL DEFAULT 1, metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT, version INTEGER NOT NULL DEFAULT 1);
CREATE UNIQUE INDEX uniq_work_resource_pool_org_key ON work_resource_pools(org_id,resource_key);
CREATE TABLE work_resource_reservations (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, admission_id TEXT NOT NULL, work_item_id TEXT NOT NULL, pool_id TEXT NOT NULL, pool_version INTEGER NOT NULL, resource_key TEXT NOT NULL, quantity INTEGER NOT NULL, state TEXT NOT NULL, reserved_at TEXT NOT NULL, expires_at TEXT NOT NULL, settled_at TEXT, version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE work_budget_envelopes (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, scope_type TEXT NOT NULL, scope_id TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'USD', limit_micros INTEGER NOT NULL, reservation_micros INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT, version INTEGER NOT NULL DEFAULT 1);
CREATE UNIQUE INDEX uniq_work_budget_envelope_scope ON work_budget_envelopes(org_id,scope_type,scope_id);
CREATE TABLE work_budget_reservations (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, admission_id TEXT NOT NULL, work_item_id TEXT NOT NULL, envelope_id TEXT NOT NULL, envelope_version INTEGER NOT NULL, amount_micros INTEGER NOT NULL, consumed_micros INTEGER, state TEXT NOT NULL, reserved_at TEXT NOT NULL, expires_at TEXT NOT NULL, settled_at TEXT, version INTEGER NOT NULL DEFAULT 1);
`;

function d1Facade(db: DatabaseSync): D1Database {
	const prepare = (sql: string) => {
		const statement = db.prepare(sql);
		let values: unknown[] = [];
		const wrapped = {
			bind: (...next: unknown[]) => {
				values = next;
				return wrapped;
			},
			all: async () => ({
				results: statement.all(...(values as [])),
				success: true,
				meta: {},
			}),
			run: async () => ({
				success: true,
				meta: { changes: Number(statement.run(...(values as [])).changes) },
			}),
			first: async (column?: string) => {
				const row = statement.get(...(values as [])) as
					| Record<string, unknown>
					| undefined;
				return column ? (row?.[column] ?? null) : (row ?? null);
			},
			raw: async () =>
				(
					statement.all(...(values as [])) as Array<Record<string, unknown>>
				).map(Object.values),
		};
		return wrapped;
	};
	return {
		prepare,
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
function context(kind: "api" | "owner" = "api"): BaseContext {
	const base = {
		db: createDbClient(d1Facade(sqlite)),
		env: { DB: d1Facade(sqlite) } as CloudflareEnv,
		organizationId: ORG_ID,
		headers: new Headers(),
		url: new URL("https://api.test/rpc"),
		rateLimiter: { limit: vi.fn(async () => ({ success: true })) },
		waitUntil: () => {},
	} as unknown as BaseContext;
	if (kind === "api") {
		base.authType = "apikey";
		base.apiKey = {
			id: "key-1",
			name: "board",
			organizationId: ORG_ID,
			scopes: ["*"],
		};
	} else {
		base.authType = "user";
		base.user = { sub: "owner-1" };
		base.userId = "owner-1";
		base.userRole = "owner";
	}
	return base;
}
function client(kind: "api" | "owner" = "api") {
	return createRouterClient(workItemsContractRouter, {
		context: context(kind),
	});
}
function seed(row: {
	id: string;
	orgId?: string;
	title?: string;
	disposition?: string;
	workKind?: string;
	workClass?: string;
	objectiveId?: string;
	projectId?: string;
	createdAt?: string;
}) {
	sqlite
		.prepare(
			`INSERT INTO work_items (id,org_id,title,disposition,work_kind,risk_level,required_capabilities,required_authorities,resource_scopes,priority,work_class,objective_id,project_id,provenance,metadata,created_at,version) VALUES (?,?,?,?,?,'medium','[]','[]','[]','medium',?,?,?,'{}','{}',?,1)`,
		)
		.run(
			row.id,
			row.orgId ?? ORG_ID,
			row.title ?? "Seed",
			row.disposition ?? "proposed",
			row.workKind ?? "other",
			row.workClass ?? null,
			row.objectiveId ?? null,
			row.projectId ?? null,
			row.createdAt ?? "2026-08-20T00:00:00.000Z",
		);
}

beforeEach(() => {
	sqlite = new DatabaseSync(":memory:");
	sqlite.exec(DDL);
	sqlite
		.prepare(
			"INSERT INTO organization_members(id,organization_id,user_id,descope_user_id,email,role,status) VALUES ('m1',?,?,?,'owner@test','owner','active')",
		)
		.run(ORG_ID, "owner-1", "owner-1");
	sqlite
		.prepare("INSERT INTO tedi_objectives(id,org_id) VALUES (?,?)")
		.run(OBJECTIVE_ID, ORG_ID);
});

describe("Work Item router canonical specification reads and writes", () => {
	it("maps concurrent resource-pool create and CAS update races to wire conflicts", async () => {
		const createInput = {
			resourceKey: "browser:chrome",
			allocationMode: "exclusive" as const,
			capacity: 1,
		};
		const created = await Promise.allSettled([
			client("owner").putResourcePool(createInput),
			client("owner").putResourcePool(createInput),
		]);
		expect(
			created.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			created.filter((result) => result.status === "rejected")[0],
		).toMatchObject({
			reason: { code: "CONFLICT" },
		});

		const updates = await Promise.allSettled([
			client("owner").putResourcePool({
				...createInput,
				capacity: 2,
				expectedVersion: 1,
			}),
			client("owner").putResourcePool({
				...createInput,
				capacity: 3,
				expectedVersion: 1,
			}),
		]);
		expect(
			updates.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			updates.filter((result) => result.status === "rejected")[0],
		).toMatchObject({
			reason: { code: "CONFLICT" },
		});
		const projection = await client("owner").listResourcePools({ limit: 10 });
		expect(projection.data).toHaveLength(1);
		expect(projection.data[0]).toMatchObject({
			activeReserved: 0,
			effectiveAvailable: expect.any(Number),
		});
	});

	it("passes exact resource filters to the tenant-scoped query and preserves list paging", async () => {
		const key = "file:tedix:src/target.ts";
		const ids = [
			"60000000-0000-4000-8000-000000000001",
			"60000000-0000-4000-8000-000000000002",
			"60000000-0000-4000-8000-000000000003",
			"60000000-0000-4000-8000-000000000004",
		];
		for (const [i, resourceKey, org, enabled] of [
			[0, "unrelated", ORG_ID, 1],
			[1, key, ORG_ID, 1],
			[2, key, OTHER_ORG_ID, 1],
			[3, "disabled", ORG_ID, 0],
		] as const)
			sqlite
				.prepare(
					"INSERT INTO work_resource_pools (id,org_id,resource_key,allocation_mode,capacity,enabled,created_at) VALUES (?,?,?,'exclusive',1,?,?)",
				)
				.run(ids[i], org, resourceKey, enabled, "2026-09-20T00:00:00.000Z");
		const exact = await client().listResourcePools({
			resourceKey: key,
			limit: 1,
		});
		expect(exact.data).toHaveLength(1);
		expect(exact.data[0]).toMatchObject({
			pool: { id: ids[1], orgId: ORG_ID, resourceKey: key },
			activeReserved: 0,
			effectiveAvailable: 1,
		});
		expect(exact.nextCursor).toBeNull();
		for (const resourceKey of ["absent", "disabled", key + ":suffix"])
			expect(
				(await client().listResourcePools({ resourceKey, limit: 1 })).data,
			).toEqual([]);
		const first = await client().listResourcePools({ limit: 1 });
		expect(first.data[0]?.pool.id).toBe(ids[0]);
		expect(first.nextCursor).toBe(ids[0]);
		const second = await client().listResourcePools({
			limit: 1,
			cursor: first.nextCursor!,
		});
		expect(second.data[0]?.pool.id).toBe(ids[1]);
		expect(second.nextCursor).toBeNull();
		await expect(
			client().listResourcePools({ resourceKey: "" }),
		).rejects.toThrow();
		await expect(
			client("owner").putResourcePool({
				resourceKey: "disabled",
				allocationMode: "exclusive",
				capacity: 1,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(
			sqlite
				.prepare(
					"SELECT enabled FROM work_resource_pools WHERE resource_key='disabled'",
				)
				.get(),
		).toMatchObject({ enabled: 0 });
	});

	it("maps concurrent budget-envelope create and CAS update races to wire conflicts", async () => {
		const createInput = {
			scopeType: "organization" as const,
			scopeId: ORG_ID,
			limitMicros: 1_000,
			reservationMicros: 100,
		};
		const created = await Promise.allSettled([
			client("owner").putBudgetEnvelope(createInput),
			client("owner").putBudgetEnvelope(createInput),
		]);
		expect(
			created.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			created.filter((result) => result.status === "rejected")[0],
		).toMatchObject({
			reason: { code: "CONFLICT" },
		});

		const updates = await Promise.allSettled([
			client("owner").putBudgetEnvelope({
				...createInput,
				limitMicros: 1_100,
				expectedVersion: 1,
			}),
			client("owner").putBudgetEnvelope({
				...createInput,
				limitMicros: 1_200,
				expectedVersion: 1,
			}),
		]);
		expect(
			updates.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			updates.filter((result) => result.status === "rejected")[0],
		).toMatchObject({
			reason: { code: "CONFLICT" },
		});
		const projection = await client("owner").listBudgetEnvelopes({ limit: 10 });
		expect(projection.data).toHaveLength(1);
		expect(projection.data[0]).toMatchObject({
			committedMicros: 0,
			availableMicros: expect.any(Number),
		});
	});

	it("rejects proposed work without a bounded purpose context", async () => {
		await expect(client().create({ title: "Unlinked work" })).rejects.toThrow(
			/PURPOSE_REQUIRED/,
		);
	});
	it("inherits purpose from an in-organization project and rejects a foreign project", async () => {
		const foreignProjectId = "55555555-5555-4555-8555-555555555555";
		sqlite
			.prepare(
				"INSERT INTO projects(id,org_id,key,objective_id,created_at) VALUES (?,?,?,?,?)",
			)
			.run(
				PROJECT_ID,
				ORG_ID,
				"FACTORY",
				OBJECTIVE_ID,
				"2026-08-20T00:00:00.000Z",
			);
		sqlite
			.prepare(
				"INSERT INTO projects(id,org_id,key,objective_id,created_at) VALUES (?,?,?,?,?)",
			)
			.run(
				foreignProjectId,
				OTHER_ORG_ID,
				"FOREIGN",
				null,
				"2026-08-20T00:00:00.000Z",
			);

		const created = await client().create({
			title: "Project-scoped work",
			projectId: PROJECT_ID,
		});
		expect(created).toMatchObject({
			projectId: PROJECT_ID,
			objectiveId: OBJECTIVE_ID,
			workClass: "objective",
		});
		await expect(
			client().create({
				...PURPOSE,
				title: "Cross-organization project",
				projectId: foreignProjectId,
			}),
		).rejects.toThrow(/different organization/);
	});
	it("creates a proposed artifact-neutral Work Item and reads it back", async () => {
		const created = await client().create({
			...PURPOSE,
			title: "Research suppliers",
			workKind: "research",
			riskLevel: "low",
			priority: "high",
			startAt: "2026-09-22T00:00:00.000Z",
			durationDays: 5,
		});
		expect(created).toMatchObject({
			orgId: ORG_ID,
			disposition: "proposed",
			workKind: "research",
			riskLevel: "low",
			priority: "high",
			startAt: "2026-09-22T00:00:00.000Z",
			durationDays: 5,
		});
		const read = await client().getById({ id: created.id });
		expect(read.workItem.id).toBe(created.id);
		expect(read.comments).toEqual([]);
		expect(read.evidence).toEqual([]);
		expect(read.evidenceNextCursor).toBeNull();
		expect(read.projections).toEqual([]);
	});
	it("includes the bounded evidence ledger in the exact Work Item read", async () => {
		const created = await client().create({
			...PURPOSE,
			title: "Review delivery receipts",
		});
		const evidenceId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
		sqlite
			.prepare(
				"INSERT INTO work_evidence(id,work_item_id,org_id,claim_key,kind,uri,submitted_by_type,submitted_by_id,submitted_at) VALUES (?,?,?,?,?,?,?,?,?)",
			)
			.run(
				evidenceId,
				created.id,
				ORG_ID,
				"production",
				"deployment",
				"deployment://api/commit",
				"external_agent",
				"agent-1",
				"2026-09-01T00:00:00.000Z",
			);

		const read = await client().getById({ id: created.id });
		expect(read.evidence).toHaveLength(1);
		expect(read.evidence[0]).toMatchObject({
			id: evidenceId,
			claimKey: "production",
			kind: "deployment",
			uri: "deployment://api/commit",
		});
		expect(read.evidenceNextCursor).toBeNull();
	});
	it("filters by canonical disposition, work kind, project, id and title", async () => {
		seed({
			id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			title: "Browser verification",
			disposition: "accepted",
			workKind: "browser",
			projectId: PROJECT_ID,
		});
		seed({
			id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			title: "Research memo",
			workKind: "research",
			projectId: PROJECT_ID,
		});
		const all = await client().list({});
		expect(all.pagination.total).toBe(2);
		for (const filter of [
			{ disposition: "accepted" as const },
			{ workKind: "browser" as const },
			{ projectId: PROJECT_ID },
			{ idPrefix: "aaaaaaaa" },
			{ titleContains: "VERIFICATION" },
		]) {
			const listed = await client().list(filter);
			expect(
				listed.data.map((item) => item.title),
				JSON.stringify(filter),
			).toContain("Browser verification");
		}
	});
	it("filters, counts and pages in SQL past the old 1,000-row window", async () => {
		// 1,200 rows: the read used to prefetch 1,000 and filter/page them in
		// memory, so `total` reported the window size and the 40 oldest rows were
		// unreachable by any filter. Both are now SQL-side.
		const SCALE = 1_200;
		const ancient = 40;
		for (let index = 0; index < SCALE; index += 1) {
			seed({
				id: `${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`,
				// index 0 is the oldest row, index 1,199 the newest.
				createdAt: new Date(
					Date.UTC(2020, 0, 1) + index * 86_400_000,
				).toISOString(),
				title:
					index < ancient ? `Cohort remediation ${index}` : `Recent ${index}`,
				workClass: index < ancient ? "maintenance" : undefined,
				objectiveId: index < ancient ? OBJECTIVE_ID : undefined,
			});
		}

		const unfiltered = await client().list({ limit: 10 });
		expect(unfiltered.pagination.total).toBe(SCALE);
		expect(unfiltered.data).toHaveLength(10);
		expect(unfiltered.pagination.hasMore).toBe(true);

		for (const filter of [
			{ workClass: "maintenance" as const },
			{ objectiveId: OBJECTIVE_ID },
			{ titleContains: "Cohort remediation" },
		]) {
			const listed = await client().list({ ...filter, limit: 100 });
			expect(listed.pagination.total, JSON.stringify(filter)).toBe(ancient);
			expect(listed.data, JSON.stringify(filter)).toHaveLength(ancient);
			expect(listed.pagination.hasMore, JSON.stringify(filter)).toBe(false);
		}

		// The oldest row in the org resolves by id prefix regardless of its age.
		const oldest = "00000000-0000-4000-8000-000000000000";
		const resolved = await client().list({ idPrefix: oldest.slice(0, 8) });
		expect(resolved.pagination.total).toBe(1);
		expect(resolved.data.map((item) => item.id)).toEqual([oldest]);

		// Offset pages over the filtered set are disjoint and exhaustive.
		const first = await client().list({ workClass: "maintenance", limit: 25 });
		const second = await client().list({
			workClass: "maintenance",
			limit: 25,
			offset: 25,
		});
		expect(first.data).toHaveLength(25);
		expect(second.data).toHaveLength(15);
		expect(second.pagination.hasMore).toBe(false);
		expect(
			new Set([...first.data, ...second.data].map((item) => item.id)).size,
		).toBe(ancient);
	});
	it("pages projections in SQL past the old offset+limit prefetch", async () => {
		// The read used to fetch `offset + limit` rows and slice the page out of
		// them, so a deep page's cost grew linearly with its offset. 260 rows share
		// one created_at, so ordering rests entirely on the id tie-break.
		const SCALE = 260;
		const itemId = "55555555-5555-4555-8555-555555555555";
		seed({ id: itemId, title: "Projected" });
		const insert = sqlite.prepare(
			"INSERT INTO work_item_projections (id,work_item_id,org_id,provider,created_at) VALUES (?,?,?,'github','2026-08-20T00:00:00.000Z')",
		);
		for (let index = 0; index < SCALE; index += 1) {
			insert.run(`proj-${index.toString().padStart(5, "0")}`, itemId, ORG_ID);
		}

		const deep = await client().listProjections({ limit: 10, offset: 250 });
		expect(deep.pagination).toEqual({
			limit: 10,
			offset: 250,
			total: SCALE,
			hasMore: false,
		});
		expect(deep.data.map((row) => row.id)).toEqual([
			"proj-00009",
			"proj-00008",
			"proj-00007",
			"proj-00006",
			"proj-00005",
			"proj-00004",
			"proj-00003",
			"proj-00002",
			"proj-00001",
			"proj-00000",
		]);

		// Offset pages are disjoint and exhaustive, never repeating a row.
		const seen: string[] = [];
		for (let offset = 0; offset < SCALE; offset += 100) {
			const page = await client().listProjections({ limit: 100, offset });
			seen.push(...page.data.map((row) => row.id));
			expect(page.pagination.hasMore).toBe(offset + page.data.length < SCALE);
		}
		expect(seen).toHaveLength(SCALE);
		expect(new Set(seen).size).toBe(SCALE);
	});
	it("rejects malformed id prefixes at the contract boundary", async () => {
		await expect(client().list({ idPrefix: "ABCDEF12" })).rejects.toThrow(
			/Input validation failed/,
		);
		await expect(client().list({ idPrefix: "abc" })).rejects.toThrow(
			/Input validation failed/,
		);
	});
	it("updates specification fields without changing disposition", async () => {
		const created = await client().create({ ...PURPOSE, title: "Draft" });
		const updated = await client("owner").updateSpecification({
			id: created.id,
			title: "Reviewed",
			workKind: "document",
			accountableOwnerType: "user",
			accountableOwnerId: "owner-1",
			startAt: "2026-09-24T00:00:00.000Z",
			durationDays: 3,
		});
		expect(updated).toMatchObject({
			title: "Reviewed",
			workKind: "document",
			disposition: "proposed",
			accountableOwnerId: "owner-1",
			startAt: "2026-09-24T00:00:00.000Z",
			durationDays: 3,
		});
	});
	it("accepts only with a nonempty typed acceptance contract", async () => {
		const created = await client().create({ ...PURPOSE, title: "Ship report" });
		const accepted = await client("owner").accept({
			id: created.id,
			acceptanceContract: {
				version: 1,
				doneLooksLike: "The report is published and linked from the board.",
			},
		});
		expect(accepted.disposition).toBe("accepted");
		const empty = await client().create({ ...PURPOSE, title: "Empty" });
		await expect(
			client("owner").accept({
				id: empty.id,
				acceptanceContract: { version: 1 },
			}),
		).rejects.toThrow(/what done looks like/);
	});
	// Acceptance is what makes a Work Item executable. An org API key is not an
	// accountable principal for it, and never was; since acceptance became
	// principal-typed the refusal comes from the canonical actor resolver rather
	// than the owner/admin membership check, so the message changed while the
	// boundary did not. A gateway-verified agent or tedi may accept only with the
	// explicitly granted work:accept scope — see work-acceptance-scope.test.ts.
	it("refuses acceptance from a principal that is not accountable for it", async () => {
		const created = await client().create({
			...PURPOSE,
			title: "Governed acceptance",
		});
		await expect(
			client().accept({
				id: created.id,
				acceptanceContract: {
					version: 1,
					doneLooksLike: "Done when the named outcome is delivered",
				},
			}),
		).rejects.toThrow(/active user, tedi, or external-agent credential/);
		// The refusal must leave the item unexecutable, not merely error.
		expect(
			(await client().getById({ id: created.id })).workItem.disposition,
		).toBe("proposed");
	});
	it("cancels through the terminal specification operation", async () => {
		const created = await client().create({ ...PURPOSE, title: "Obsolete" });
		const cancelled = await client("owner").cancel({
			id: created.id,
			reason: "superseded",
		});
		expect(cancelled.disposition).toBe("cancelled");
		expect(cancelled.cancelledAt).not.toBeNull();
	});
	it("rejects cross-organization reads", async () => {
		const id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
		seed({ id, orgId: OTHER_ORG_ID });
		await expect(client().getById({ id })).rejects.toThrow();
	});
});

describe("Work Item router collaboration ledgers", () => {
	it("keeps lifecycle events server-authored and comment identity credential-derived", async () => {
		const created = await client().create({
			...PURPOSE,
			title: "Reserved event boundary",
		});
		const comment = await client().addComment({
			id: created.id,
			body: "Caller cannot forge a lifecycle event",
			metadata: {
				eventType: "work.completed",
				actorId: "owner-1",
			},
		});
		expect(comment).toMatchObject({
			authorType: "system",
			authorId: "apikey:key-1",
		});
		const count = sqlite
			.prepare(
				"SELECT count(*) AS count FROM work_events WHERE work_item_id = ?",
			)
			.get(created.id) as { count: number };
		expect(Number(count.count)).toBe(0);
	});
	it("rejects a bound external-agent API key without immutable gateway session identity", async () => {
		const created = await client().create({
			...PURPOSE,
			title: "External corroboration",
		});
		sqlite
			.prepare(
				"INSERT INTO external_agent_principals(id,organization_id,key,display_name,status,credential_binding_type,credential_binding_id,created_by_type,created_by_id,metadata,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
			)
			.run(
				"66666666-6666-4666-8666-666666666666",
				ORG_ID,
				"codex",
				"Codex",
				"active",
				"api_key",
				"key-1",
				"user",
				"owner-1",
				"{}",
				"2026-08-20T00:00:00.000Z",
				"2026-08-20T00:00:00.000Z",
			);
		await expect(
			client().corroborate({
				id: created.id,
				evidenceRef: "artifact://self-claim",
				body: "Attempted direct corroboration",
			}),
		).rejects.toThrow(/active immutable MCP session/);
		expect(await client().listCorroborations({ id: created.id })).toEqual([]);
	});
	it("treats an owner and their owner-host agent as one party for corroboration", async () => {
		const insertPrincipal = sqlite.prepare(
			"INSERT INTO external_agent_principals(id,organization_id,key,display_name,status,credential_binding_type,credential_binding_id,created_by_type,created_by_id,metadata,created_at,updated_at) VALUES (?,?,?,?,'active',?,?,'user','owner-1','{}','2026-08-20T00:00:00.000Z','2026-08-20T00:00:00.000Z')",
		);
		insertPrincipal.run(
			"77777777-7777-4777-8777-777777777777",
			ORG_ID,
			"owner-host-0123456789ab",
			"Plugin hosts of owner",
			"owner_user",
			"owner-1",
		);
		insertPrincipal.run(
			"88888888-8888-4888-8888-888888888888",
			ORG_ID,
			"codex",
			"Codex",
			"api_key",
			"key-other",
		);
		const attempt = sqlite.prepare(
			"INSERT INTO work_attempts(id,work_item_id,org_id,executor_type,executor_id,executor_session_id,runtime_state,attempt_number,started_at,heartbeat_at) VALUES (?,?,?,'external_agent',?,'99999999-9999-4999-8999-999999999999',?,1,'2026-08-20T00:00:00.000Z','2026-08-20T00:00:00.000Z')",
		);
		for (const runtimeState of ["running", "succeeded"]) {
			const created = await client().create({
				...PURPOSE,
				title: `Owner-host ${runtimeState}`,
			});
			attempt.run(
				crypto.randomUUID(),
				created.id,
				ORG_ID,
				"77777777-7777-4777-8777-777777777777",
				runtimeState,
			);
			await expect(
				client("owner").corroborate({
					id: created.id,
					evidenceRef: "artifact://self",
					body: "My own agent did it",
				}),
			).rejects.toMatchObject({ code: "CONFLICT" });
			await expect(
				client("owner").corroborate({
					id: created.id,
					evidenceRef: "artifact://self",
					body: "My own agent got it wrong",
					stance: "contradicts",
				}),
			).resolves.toMatchObject({ principalType: "user" });
		}
		const independent = await client().create({
			...PURPOSE,
			title: "Another agent's work",
		});
		attempt.run(
			crypto.randomUUID(),
			independent.id,
			ORG_ID,
			"88888888-8888-4888-8888-888888888888",
			"running",
		);
		await expect(
			client("owner").corroborate({
				id: independent.id,
				evidenceRef: "artifact://independent",
				body: "Reproduced independently",
			}),
		).resolves.toMatchObject({ principalType: "user", principalId: "owner-1" });
	});
	it("appends authenticated comments and returns them on canonical read", async () => {
		const created = await client().create({ ...PURPOSE, title: "Discuss" });
		const comment = await client().addComment({
			id: created.id,
			body: "Needs legal review",
			metadata: { source: "test" },
		});
		expect(comment).toMatchObject({
			body: "Needs legal review",
			authorType: "system",
			authorId: "apikey:key-1",
		});
		expect((await client().getById({ id: created.id })).comments).toHaveLength(
			1,
		);
	});
	it("adds and lists typed dependency relations", async () => {
		const from = await client().create({ ...PURPOSE, title: "Dependent" });
		const to = await client().create({ ...PURPOSE, title: "Blocker" });
		const relation = await client().addRelation({
			id: from.id,
			toWorkItemId: to.id,
			relationType: "blocks",
		});
		expect(relation).toMatchObject({
			fromWorkItemId: from.id,
			toWorkItemId: to.id,
			relationType: "blocks",
		});
		expect((await client().listRelations({})).relations).toHaveLength(1);
	});
	it("deduplicates organization corroboration across API key rotations", async () => {
		const created = await client().create({
			...PURPOSE,
			title: "Reproduce incident",
		});
		const first = await client().corroborate({
			id: created.id,
			evidenceRef: "artifact://repro-1",
			body: "Reproduced",
		});
		expect(first).toMatchObject({
			principalType: "organization",
			principalId: `organization:${ORG_ID}`,
		});
		await expect(
			client().corroborate({
				id: created.id,
				evidenceRef: "artifact://repro-1",
				body: "Reproduced",
			}),
		).resolves.toMatchObject({ id: first.id });
		await expect(
			client().corroborate({
				id: created.id,
				evidenceRef: "artifact://repro-2",
				body: "Different payload",
			}),
		).resolves.toMatchObject({
			id: first.id,
			evidenceRef: "artifact://repro-2",
			body: "Different payload",
		});
		expect(await client().listCorroborations({ id: created.id })).toEqual([
			expect.objectContaining({
				id: first.id,
				evidenceRef: "artifact://repro-2",
				body: "Different payload",
			}),
		]);
	});
});

describe("bounded CLI projections using owning D1 reads", () => {
	function projectionClient(scopes = ["mcp:work.read"]) {
		const ctx = context();
		const facade = createD1Facade(sqlite);
		ctx.db = createDbClient(facade);
		ctx.env = { ...ctx.env, DB: facade };
		ctx.apiKey!.scopes = scopes;
		return createRouterClient(workItemsContractRouter, { context: ctx });
	}
	it("preserves SQL filters, totals, last page and resolve fields without full records", async () => {
		for (let i = 1; i <= 3; i++)
			seed({
				id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
				title: `CLI ${i}`,
			});
		sqlite
			.prepare(
				"UPDATE work_items SET description=?,metadata=?,acceptance_contract=?",
			)
			.run(
				"x".repeat(20000),
				JSON.stringify({ large: "x".repeat(20000) }),
				JSON.stringify({ version: 1, doneLooksLike: "x".repeat(2000) }),
			);
		const c = projectionClient();
		const first = await c.listCliProjection({
			view: "board",
			titleContains: "CLI",
			limit: 2,
		});
		expect(first.data).toHaveLength(2);
		expect(first.pagination).toMatchObject({ total: 3, hasMore: true });
		expect(first.data[0]).not.toHaveProperty("metadata");
		expect(first.data[0]).not.toHaveProperty("acceptanceContract");
		expect(first.data[0]).toHaveProperty("activeAttempt", null);
		const last = await c.listCliProjection({
			view: "resolve",
			titleContains: "CLI",
			limit: 2,
			offset: 2,
		});
		expect(last.pagination).toMatchObject({ total: 3, hasMore: false });
		expect(last.data).toHaveLength(1);
		expect(last.data[0]).not.toHaveProperty("activeAttempt");
		expect(await c.getCheckpointProjection({ id: first.data[0]!.id })).toEqual({
			id: first.data[0]!.id,
			orgId: ORG_ID,
			projectId: null,
			disposition: "proposed",
		});
	});
	it("retains org and scope refusals instead of returning empty data", async () => {
		const id = "00000000-0000-4000-8000-000000000009";
		seed({ id, orgId: "00000000-0000-4000-8000-000000000099" });
		await expect(
			projectionClient().getCheckpointProjection({ id }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			projectionClient(["mcp:messaging.read"]).listCliProjection({
				view: "board",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it("projects exact ledger rows and continuation while leaving metadata/payload out", async () => {
		const id = "00000000-0000-4000-8000-000000000010";
		seed({ id });
		const at = "2026-10-07T00:00:00.000Z";
		for (let i = 1; i <= 2; i++) {
			const rowId = `00000000-0000-4000-8000-${String(i + 10).padStart(12, "0")}`;
			sqlite
				.prepare(
					"INSERT INTO work_attempts (id,work_item_id,org_id,executor_type,executor_id,runtime_state,attempt_number,started_at,heartbeat_at,metadata) VALUES (?,?,?,'tedi','actor','running',?,?,?,'{}')",
				)
				.run(rowId, id, ORG_ID, i, at, at);
			sqlite
				.prepare(
					"INSERT INTO work_events(id,org_id,work_item_id,event_type,actor_type,actor_id,payload,occurred_at) VALUES (?,?,?,'observed','user','owner',?,?)",
				)
				.run(
					rowId,
					ORG_ID,
					id,
					JSON.stringify({ large: "x".repeat(20000) }),
					at,
				);
			sqlite
				.prepare(
					"INSERT INTO work_evidence(id,work_item_id,org_id,claim_key,kind,uri,submitted_by_type,submitted_by_id,submitted_at,metadata) VALUES (?,?,?,'claim','citation','https://evidence.test/receipt','user','owner',?,'{}')",
				)
				.run(rowId, id, ORG_ID, at);
		}
		const c = projectionClient();
		const a = await c.listAttemptCliProjection({ id, limit: 1 });
		expect(a.data).toHaveLength(1);
		expect(a.data[0]).not.toHaveProperty("metadata");
		expect(a.nextCursor).not.toBeNull();
		expect(
			(
				await c.listAttemptCliProjection({
					id,
					limit: 1,
					cursor: a.nextCursor!,
				})
			).nextCursor,
		).toBeNull();
		const e = await c.listEvidenceCliProjection({ id, limit: 1 });
		expect(e.data[0]).not.toHaveProperty("reference");
		expect(e.nextCursor).not.toBeNull();
		expect(
			(
				await c.listEvidenceCliProjection({
					id,
					limit: 1,
					cursor: e.nextCursor!,
				})
			).nextCursor,
		).toBeNull();
		const events = await c.listEventCliProjection({ id, limit: 1 });
		expect(events.events[0]).not.toHaveProperty("payload");
		expect(events.nextSequence).not.toBeNull();
		expect(
			(
				await c.listEventCliProjection({
					id,
					limit: 1,
					afterSequence: events.nextSequence!,
				})
			).events,
		).toHaveLength(1);
	});
});
