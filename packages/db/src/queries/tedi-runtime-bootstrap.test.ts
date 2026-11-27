import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { coreTable } from "../core-store/client";
import { createDbQueryClient, type DbQueryClient } from "../query-client";
import { tedis } from "../schema/tedis";
import { organizations } from "../schema/organizations";
import { tediSecrets } from "../schema/tedi-secrets";
import { apiKeys } from "../schema/api-keys";
import { billingAccounts, billingPlanVersions } from "../schema/billing";
import { policyPacks } from "../schema/control-plane";
import { tediApprovalRequests } from "../schema/approvals";
import { createD1Facade } from "../test/d1-facade";
import { createPGliteFacade } from "../test/pglite-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import {
	getTediEmailIngressRouteBySlug,
	getTediRuntimeRouteBySlug,
	getTediRuntimeBodyGeneration,
	markTediRuntimeBodyGenerationReady,
	getTediRuntimeEncryptedSecret,
	findTediRuntimeApiKeyByHash,
	recordTediRuntimeApiKeyUsage,
	resolveCanonicalRuntimeParentIdentity,
	resolveTediRuntimeIdentity,
	getTediRuntimeChannels,
	getTediRuntimeGovernance,
	getTediRuntimePolicy,
	getTediRuntimeRepoConfig,
	getTediRuntimeApproval,
	updateTediRuntimeApprovalResolution,
	getTediRuntimeCanonicalIsolateId,
} from "./tedi-runtime-bootstrap";

const at = "2026-11-27T12:00:00.000Z";
const json = (value: unknown) =>
	typeof value === "string" ? JSON.parse(value) : value;
for (const store of ["d1", "postgres"] as const)
	describe(`runtime bootstrap ${store}`, () => {
		let db: DbQueryClient;
		let close: () => void | Promise<void>;
		beforeAll(async () => {
			if (store === "d1") {
				const sqlite = createMigratedSqlite();
				db = createDbQueryClient(createD1Facade(sqlite));
				close = () => sqlite.close();
			} else {
				const fixture = await createPGliteFacade();
				db = fixture.db;
				close = fixture.close;
				for (const migration of readMigrationFiles({
					migrationsFolder: fileURLToPath(
						new URL("../../drizzle-pg", import.meta.url),
					),
				}))
					for (const ddl of migration.sql) await fixture.engine.exec(ddl);
			}
			await db.run(sql`INSERT INTO ${coreTable(db, organizations)}(id,name,slug,descope_tenant_id,metadata)
   VALUES ('org','Org','org','tenant','{"browserEgress":{"mode":"strict"}}'),('other','Other','other',NULL,NULL)`);
			await db.run(sql`INSERT INTO ${coreTable(db, policyPacks)}(id,name,slug,scope,status,version,definition) VALUES
   ('v26','Default','system-default','system','active',26,'{"version":26}'),
   ('v27','Default','system-default','system','active',27,'{"version":27}'),
   ('v28','Draft','system-default','system','draft',28,'{"version":28}')`);
			await db.run(sql`INSERT INTO ${coreTable(db, tedis)}(id,organization_id,name,slug,isolate_agent_id,status,runtime_kind,
   channels,repo_config,budgets,tool_policy,runtime_overrides,body_generation_id,body_generation_token_hash,body_generation_token_expires_at)
   VALUES ('tedi','org','Tedi','cto','body','active','agent','{"telegram":{"chatId":"42"}}',
   '{"repoUrl":"https://example.test/repo"}','{"limit":10}','{"mode":"supervised"}',
   '{"cronPolicy":{"disableCognitiveDefaults":true}}','generation','hash',${at})`);
			await db.run(sql`INSERT INTO ${coreTable(db, tedis)}(id,organization_id,name,slug,status,retired_at) VALUES
   ('fallback','org','Fallback','ceo','active',NULL),('paused','org','Paused','paused','paused',NULL),
   ('retired','other','Retired','former','active',${at})`);
			await db.run(sql`INSERT INTO ${coreTable(db, billingPlanVersions)}(id,plan_key,version,name,max_tedis,max_cron_jobs_per_tedi,max_iterations_per_task,effective_at)
   VALUES ('plan','free',1,'Plan',1,1,17,${at})`);
			await db.run(sql`INSERT INTO ${coreTable(db, billingAccounts)}(organization_id,plan_version_id,period_start,period_end)
   VALUES ('org','plan',${at},${at})`);
			await db.run(sql`INSERT INTO ${coreTable(db, tediSecrets)}(id,tedi_id,name,encrypted_value,created_at,updated_at) VALUES
   ('key','tedi','POPPY_AGENT_SIGNING_KEY','ciphertext',${at},${at}),
   ('foreign','retired','GITHUB_PAT','other-ciphertext',${at},${at})`);
		}, 30000);
		afterAll(async () => {
			await close?.();
		});

		it("routes only eligible email bodies and rejects ambiguous canonical parent names in one snapshot", async () => {
			expect(await getTediRuntimeRouteBySlug(db, "cto")).toEqual({
				id: "tedi",
				slug: "cto",
				organizationId: "org",
				runtimeKind: "agent",
				isolateAgentId: "body",
				status: "active",
				descopeMcpResourceId: null,
				organizationDescopeTenantId: "tenant",
			});
			expect(await getTediRuntimeRouteBySlug(db, "cto' OR 1=1 --")).toBeNull();
			expect(await getTediEmailIngressRouteBySlug(db, "cto")).toEqual({
				agentId: "body",
			});
			expect(await getTediEmailIngressRouteBySlug(db, "ceo")).toEqual({
				agentId: "ceo",
			});
			for (const slug of ["paused", "former", "missing"])
				expect(await getTediEmailIngressRouteBySlug(db, slug)).toBeNull();
			expect(
				await resolveCanonicalRuntimeParentIdentity(db, "body"),
			).toMatchObject({ id: "tedi", orgId: "org" });
			expect(await resolveCanonicalRuntimeParentIdentity(db, "cto")).toBeNull();
			expect(
				await resolveCanonicalRuntimeParentIdentity(db, "ceo"),
			).toMatchObject({ id: "fallback" });
			expect(await resolveTediRuntimeIdentity(db, "cto")).toMatchObject({
				id: "tedi",
			});
			expect(await resolveTediRuntimeIdentity(db, "tedi")).toBeNull();
			expect(await resolveTediRuntimeIdentity(db, "tedi", true)).toMatchObject({
				id: "tedi",
			});
			await db.run(sql`INSERT INTO ${coreTable(db, tedis)}(id,organization_id,name,slug,isolate_agent_id)
   VALUES ('duplicate','other','Duplicate','duplicate','body')`);
			expect(
				await resolveCanonicalRuntimeParentIdentity(db, "body"),
			).toBeNull();
			expect(await getTediRuntimeCanonicalIsolateId(db, "retired")).toEqual({
				exists: true,
				isolateAgentId: null,
				retired: true,
			});
			expect(await getTediRuntimeCanonicalIsolateId(db, "missing")).toEqual({
				exists: false,
				isolateAgentId: null,
				retired: false,
			});
		});

		it("preserves JSON text, secret ownership, numeric governance and immutable policy pins", async () => {
			expect(json(await getTediRuntimeChannels(db, "tedi"))).toEqual({
				telegram: { chatId: "42" },
			});
			expect(json(await getTediRuntimeRepoConfig(db, "tedi"))).toEqual({
				repoUrl: "https://example.test/repo",
			});
			expect(
				await getTediRuntimeEncryptedSecret(
					db,
					"tedi",
					"POPPY_AGENT_SIGNING_KEY",
				),
			).toBe("ciphertext");
			expect(
				await getTediRuntimeEncryptedSecret(db, "tedi", "GITHUB_PAT"),
			).toBeNull();
			const governance = await getTediRuntimeGovernance(db, "tedi");
			expect(governance).toMatchObject({
				poppyAgentEnabled: 1,
				runtimeProfileMaxIterationsPerTask: 17,
			});
			expect(json(governance?.organizationMetadata)).toEqual({
				browserEgress: { mode: "strict" },
			});
			expect(json(governance?.budgets)).toEqual({ limit: 10 });
			expect(json(governance?.toolPolicy)).toEqual({ mode: "supervised" });
			expect(await getTediRuntimeGovernance(db, "retired")).toMatchObject({
				poppyAgentEnabled: 0,
				runtimeProfileMaxIterationsPerTask: null,
			});
			const policy = await getTediRuntimePolicy(db, "tedi");
			expect(json(policy?.definition)).toEqual({ version: 27 });
			expect(json(policy?.runtimeOverrides)).toEqual({
				cronPolicy: { disableCognitiveDefaults: true },
			});
			await db.run(
				sql`UPDATE ${coreTable(db, tedis)} SET policy_pack_id = 'v26' WHERE id = 'tedi'`,
			);
			expect(
				json((await getTediRuntimePolicy(db, "tedi"))?.definition),
			).toEqual({ version: 26 });
			expect(await getTediRuntimePolicy(db, "missing")).toBeNull();
		});

		it("fences generation readiness and persists approval resolution without changing its payload", async () => {
			expect(await getTediRuntimeBodyGeneration(db, "tedi")).toEqual({
				bodyGenerationId: "generation",
				bodyGenerationTokenHash: "hash",
				bodyGenerationTokenExpiresAt: at,
			});
			await markTediRuntimeBodyGenerationReady(db, {
				tediId: "tedi",
				generationId: "stale",
				externalId: "wrong",
				at,
			});
			const read = () =>
				db.get<{
					body_generation_status: string;
					body_generation_external_id: string;
					last_seen_at: string;
				}>(sql`
   SELECT body_generation_status,body_generation_external_id,last_seen_at FROM ${coreTable(db, tedis)} WHERE id = 'tedi'`);
			expect((await read())?.body_generation_external_id).toBeNull();
			await markTediRuntimeBodyGenerationReady(db, {
				tediId: "tedi",
				generationId: "generation",
				externalId: "body",
				at,
			});
			expect(await read()).toMatchObject({
				body_generation_status: "ready",
				body_generation_external_id: "body",
				last_seen_at: at,
			});
			await db.run(sql`INSERT INTO ${coreTable(db, tediApprovalRequests)}(id,tedi_id,org_id,action_type,description,payload,status,created_at,expires_at)
   VALUES ('approval','tedi','org','tool','Tool','{"kind":"repo_commit"}','approved',${at},${at})`);
			const approval = await getTediRuntimeApproval(db, "approval");
			expect(approval).toMatchObject({
				status: "approved",
				tediId: "tedi",
				orgId: "org",
				resolvedAt: null,
			});
			expect(json(approval?.payload)).toEqual({ kind: "repo_commit" });
			await updateTediRuntimeApprovalResolution(db, "approval", "committed");
			expect(await getTediRuntimeApproval(db, "approval")).toEqual({
				...approval,
				resolution: "committed",
			});
			expect(await getTediRuntimeApproval(db, "missing")).toBeNull();
		});

		it("keeps current-key precedence, rotation grace boundaries and null-safe usage counters", async () => {
			await db.run(sql`INSERT INTO ${coreTable(db, apiKeys)}(id,organization_id,name,key_hash,key_preview,status,previous_key_hash,previous_key_expires_at,ip_allowlist,requests_this_month,total_requests) VALUES
   ('current','org','Current','current','preview','revoked',NULL,NULL,'["203.0.113.9"]',NULL,NULL),
   ('rotated','other','Rotated','new','preview','active','current','2026-12-01T00:00:00.000Z',NULL,0,0)`);
			const current = await findTediRuntimeApiKeyByHash(db, "current", at);
			expect(current).toMatchObject({
				id: "current",
				status: "revoked",
				organizationId: "org",
			});
			expect(json(current?.ipAllowlist)).toEqual(["203.0.113.9"]);
			await db.run(
				sql`UPDATE ${coreTable(db, apiKeys)} SET previous_key_hash = 'old' WHERE id = 'rotated'`,
			);
			expect(await findTediRuntimeApiKeyByHash(db, "old", at)).toMatchObject({
				id: "rotated",
				organizationId: "other",
				ipAllowlist: null,
			});
			expect(
				await findTediRuntimeApiKeyByHash(
					db,
					"old",
					"2026-12-01T00:00:00.000Z",
				),
			).toBeNull();
			await db.run(
				sql`UPDATE ${coreTable(db, apiKeys)} SET status = 'revoked' WHERE id = 'rotated'`,
			);
			expect(await findTediRuntimeApiKeyByHash(db, "old", at)).toBeNull();
			await recordTediRuntimeApiKeyUsage(db, "current", at);
			await recordTediRuntimeApiKeyUsage(db, "current", at);
			expect(
				await db.get(
					sql`SELECT requests_this_month,total_requests,last_used_at FROM ${coreTable(db, apiKeys)} WHERE id = 'current'`,
				),
			).toEqual({
				requests_this_month: 2,
				total_requests: 2,
				last_used_at: at,
			});
		});
	});
