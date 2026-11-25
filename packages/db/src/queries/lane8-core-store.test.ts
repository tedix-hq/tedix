import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import {
	getTableConfig,
	SQLiteDialect,
	type SQLiteTable,
} from "drizzle-orm/sqlite-core";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import { coreTable } from "../core-store/client";
import { createPGliteFacade } from "../test/pglite-facade";
import { createD1Facade } from "../test/d1-facade";
import { tableDdl } from "../test/schema-ddl";
import { connectionInstances } from "../schema/connection-instances";
import { organizations } from "../schema/organizations";
import { organizationMembers } from "../schema/organization-members";
import { principalIdentities } from "../schema/principal-identities";
import { users } from "../schema/users";
import { oidcSessions } from "../schema/oidc-sessions";
import { apiKeys } from "../schema/api-keys";
import { auditEvents } from "../schema/audit-events";
import { apps } from "../schema/apps";
import { appTools } from "../schema/tools";
import { projects } from "../schema/projects";
import { tedis } from "../schema/tedis";
import { workItems, workAttempts, workEvents } from "../schema/work-items";
import * as external from "../schema/external-agent-identity";
import * as policy from "../schema/tenant-tool-policy";
import { mcpToolApprovalGrants } from "../schema/mcp-governance";
import { consumeExternalAgentWorkloadToken } from "./external-agent-identity/workload-tokens";
import {
	createExternalAgentPrincipal,
	disableExternalAgentPrincipal,
	setExternalAgentWorkManagement,
} from "./external-agent-identity/principals";
import {
	openExternalAgentSession,
	consumeExternalAgentExchangeBudget,
	resolveActiveExternalAgentSession,
} from "./external-agent-identity/sessions";
import { resolveOwnerHostSession } from "./external-agent-identity/owner-host-sessions";
import { recordVerifiedExternalAgentMcpExecution } from "./external-agent-identity/mcp-executions";
import { resolveCanonicalWorkParties } from "./external-agent-identity/canonical-party";
import {
	acquireExternalAgentMcpIssuanceLease,
	recordExternalAgentMcpCredential,
	listReapableExternalAgentMcpCredentials,
	markExternalAgentMcpCredentialsReaped,
} from "./external-agent-identity/mcp-credentials";
import { recordExternalAgentAttribution } from "./external-agent-identity/attribution";
import { recordExternalAgentReviewEvidence } from "./external-agent-identity/review-evidence";
import { getExternalAgentContextualReputation } from "./external-agent-identity/contextual-reputation";
import {
	replaceTenantToolPolicy,
	findTenantToolPolicyRevisions,
	listDeletedTenantPolicyFences,
	getTenantToolPolicyResourceGenerations,
} from "./tenant-tool-policy";
import {
	getOrganizationBySlug,
	getOrganizationGuestProfile,
	setProviderOnboardingConfiguration,
	setConnectionConsumerGrants,
	getConnectionConsumerGrants,
	buildApplyOrganizationPlanFeaturesStatement,
	decrementAppCount,
} from "./organizations";
import {
	readAuthContextCacheVersion,
	invalidateAuthContextCache,
} from "./auth-context-cache";
import {
	createGrant,
	findActiveGrant,
	consumeGrant,
	getOrganizationOwnedChannel,
	resolveWorkItemAuthorization,
	signOwnedChannelAuthorizationProof,
	recordOwnedChannelAuthorizationEvent,
	OWNED_CHANNEL_AUTHORIZATION_EVENT,
	OWNED_CHANNEL_AUTHORIZATION_REVOKED_EVENT,
} from "./mcp-governance";

const at = "2026-11-01T00:00:00.000Z";
const later = "2026-11-01T01:00:00.000Z";
for (const store of ["d1", "postgres"] as const)
	describe(store, () => {
		let db: DbClient;
		let close: () => void | Promise<void>;
		let execute: (text: string) => unknown | Promise<unknown>;
		beforeAll(async () => {
			if (store === "postgres") {
				const fixture = await createPGliteFacade();
				db = fixture.db;
				close = fixture.close;
				execute = (text) => fixture.engine.exec(text);
				for (const migration of readMigrationFiles({
					migrationsFolder: fileURLToPath(
						new URL("../../drizzle-pg", import.meta.url),
					),
				}))
					for (const ddl of migration.sql) await fixture.engine.exec(ddl);
			} else {
				const sqlite = new DatabaseSync(":memory:");
				close = () => sqlite.close();
				execute = (text) => sqlite.exec(text);
				const tables = new Set<SQLiteTable>();
				const include = (table: SQLiteTable) => {
					if (tables.has(table)) return;
					tables.add(table);
					for (const fk of getTableConfig(table).foreignKeys)
						include(fk.reference().foreignTable);
				};
				for (const table of [
					organizations,
					organizationMembers,
					principalIdentities,
					users,
					oidcSessions,
					apiKeys,
					auditEvents,
					apps,
					appTools,
					connectionInstances,
					projects,
					tedis,
					workItems,
					workAttempts,
					workEvents,
					mcpToolApprovalGrants,
					external.externalAgentPrincipals,
					external.externalAgentSessions,
					external.externalAgentWorkloadTokenUses,
					external.externalAgentMcpCredentials,
					external.externalAgentMcpIssuanceLeases,
					external.externalAgentAttributions,
					external.externalAgentReviewEvidence,
					external.externalAgentExchangeLimits,
					policy.tenantToolPolicies,
					policy.tenantToolPolicyMountRevisions,
					policy.tenantToolPolicyPreparations,
					policy.tenantToolPolicyResourceGenerations,
				])
					include(table);
				// tableDdl omits CHECK constraints; keep them enabled for this parity proof.
				const dialect = new SQLiteDialect();
				for (const table of tables)
					for (let ddl of tableDdl(table)) {
						const checks = getTableConfig(table).checks;
						if (ddl.startsWith("CREATE TABLE") && checks.length) {
							ddl = ddl.replace(
								"\n);",
								",\n" +
									checks
										.map(
											(check) =>
												`CONSTRAINT "${check.name}" CHECK (${dialect.sqlToQuery(check.value.inlineParams()).sql})`,
										)
										.join(",\n") +
									"\n);",
							);
						}
						sqlite.exec(ddl);
					}
				for (const migration of [
					"20261119100738_auth_context_cache",
					"20261119182503_auth_cache_organization_fields",
				])
					sqlite.exec(
						readFileSync(
							new URL(
								`../../drizzle/${migration}/migration.sql`,
								import.meta.url,
							),
							"utf8",
						),
					);
				const generations = readFileSync(
					new URL(
						"../../drizzle/20261030142026_tenant_policy_dependency_generations/migration.sql",
						import.meta.url,
					),
					"utf8",
				);
				sqlite.exec(generations.slice(generations.indexOf("CREATE TRIGGER")));
				db = createDbClient(createD1Facade(sqlite, { maxBoundParams: 100 }));
			}

			await db.insert(coreTable(db, organizations)).values([
				{ id: "org", name: "Org", slug: "org" },
				{ id: "other", name: "Other", slug: "other" },
			]);
			await db.insert(coreTable(db, apiKeys)).values({
				id: "key",
				organizationId: "org",
				name: "Key",
				keyHash: "hash",
				keyPreview: "test",
				createdBy: "owner",
			});
			await db
				.insert(coreTable(db, apps))
				.values({ id: "app", organizationId: "org", name: "App", slug: "app" });
			await db.insert(coreTable(db, appTools)).values({
				id: "tool",
				appId: "app",
				toolId: "write",
				toolTypeId: "native",
				title: "Write",
				writeCapability: "write",
			});
		}, 30000);
		afterAll(async () => {
			await close?.();
		});

		it("preserves immutable identities, replay fences, joined sessions, and JSON writes with audit in one batch", async () => {
			await createExternalAgentPrincipal(db, {
				id: "principal",
				organizationId: "org",
				key: "agent",
				displayName: "Agent",
				credentialBindingType: "api_key",
				credentialBindingId: "key",
				createdByType: "user",
				createdById: "owner",
				metadata: {},
				createdAt: at,
			});
			const input = {
				id: "session",
				organizationId: "org",
				principalId: "principal",
				externalSessionKey: "codex:test",
				harness: "codex",
				harnessVersion: "1",
				modelProvider: "test",
				modelId: "test",
				modelVersion: "1",
				identitySource: "explicit" as const,
				startedAt: at,
			};
			const session = await openExternalAgentSession(db, input);
			expect(session.creditEligible).toBe(true);
			expect((await openExternalAgentSession(db, input)).id).toBe("session");
			await expect(
				openExternalAgentSession(db, { ...input, modelVersion: "changed" }),
			).rejects.toMatchObject({ reason: "immutable_session_conflict" });
			expect(
				(
					await resolveActiveExternalAgentSession(db, {
						...input,
						sessionId: input.id,
					})
				)?.principal.id,
			).toBe("principal");
			const token = {
				id: "token",
				organizationId: "org",
				principalId: "principal",
				issuer: "issuer",
				subject: "subject",
				audience: "test",
				jti: "jti",
				externalSessionKey: input.externalSessionKey,
				tokenIssuedAt: at,
				tokenExpiresAt: later,
				consumedAt: at,
			};
			expect(await consumeExternalAgentWorkloadToken(db, token)).toBe(true);
			expect(await consumeExternalAgentWorkloadToken(db, token)).toBe(false);
			expect(
				await consumeExternalAgentExchangeBudget(db, {
					...input,
					nowMs: Date.parse(at),
				}),
			).toBe(true);
			// The audited removal exercises native JSON and timestamp projections without accepting an invalid grant.
			const updated = await setExternalAgentWorkManagement(db, {
				organizationId: "org",
				principalId: "principal",
				actorId: "owner",
				grant: null,
				updatedAt: at,
			});
			expect(updated.metadata).toEqual({});
			const audits = await db.select().from(coreTable(db, auditEvents));
			expect(audits[0]?.metadata).toEqual({ previousGrant: null, grant: null });
			expect(audits[0]?.timestamp.toISOString()).toBe(at);
		});

		it("enforces credential leases and finishes cleanup for one large bound set atomically", async () => {
			expect(
				await acquireExternalAgentMcpIssuanceLease(db, {
					id: "lease",
					organizationId: "org",
					principalId: "principal",
					sessionId: "session",
					mcpServerId: "server",
					ownerToken: "owner",
					now: at,
					expiresAt: later,
				}),
			).toBe(true);
			const credential = await recordExternalAgentMcpCredential(db, {
				id: "credential",
				organizationId: "org",
				principalId: "principal",
				sessionId: "session",
				clientRecordId: "client",
				scopes: ["mcp:work.read"],
				mcpServerId: "server",
				mcpServerUrl: "https://example.test/mcp",
				issuedAt: at,
				expiresAt: later,
			});
			expect(credential.sessionId).toBe("session");
			expect(credential.scopes).toEqual(["mcp:work.read"]);
			expect(
				(
					await recordVerifiedExternalAgentMcpExecution(db, {
						id: "execution",
						organizationId: "org",
						principalId: "principal",
						sessionId: "session",
						clientRecordId: "client",
						targetId: "call",
						occurredAt: at,
					})
				).metadata,
			).toMatchObject({ provenanceCertification: { source: "mcp_gateway" } });
			expect(
				await listReapableExternalAgentMcpCredentials(db, {
					expiredBefore: "2026-11-02T00:00:00.000Z",
					limit: 20,
				}),
			).toEqual([{ clientRecordId: "client", mcpServerId: "server" }]);
			const batches = vi.spyOn(db, "batch");
			await disableExternalAgentPrincipal(db, {
				organizationId: "org",
				principalId: "principal",
				reason: "test",
				now: later,
			});
			expect(
				await markExternalAgentMcpCredentialsReaped(db, {
					clientRecordIds: [
						...Array.from({ length: 200 }, (_, i) => `missing-${i}`),
						"client",
					],
					revokedAt: later,
				}),
			).toBe(1);
			expect(
				batches.mock.calls.map(([statements]) => statements.length),
			).toEqual([4, 2]);
			batches.mockRestore();
			const [row] = await db
				.select()
				.from(coreTable(db, external.externalAgentPrincipals))
				.where(
					eq(coreTable(db, external.externalAgentPrincipals).id, "principal"),
				);
			expect(row?.metadata).toMatchObject({
				providerCleanup: "done",
				disableReason: "test",
			});
		});

		it("keeps subject revision CAS and deleted-policy fences atomic", async () => {
			const row = {
				organizationId: "org",
				appId: "app",
				rootAppId: "app",
				mountedToolId: "write",
				toolRowId: "tool",
				toolDigest: "tool-digest",
				ruleDigest: "rule-digest",
				mountDescriptor: { kind: "profile", actorUserId: "owner" },
				predicate: {},
				effect: {},
				createdBy: "owner",
				createdAt: at,
			};
			expect(
				(await replaceTenantToolPolicy(db, { ...row, id: "policy1" }, null))
					?.id,
			).toBe("policy1");
			expect(
				await replaceTenantToolPolicy(
					db,
					{ ...row, id: "stale", createdAt: later },
					null,
				),
			).toBeUndefined();
			expect(
				(
					await replaceTenantToolPolicy(
						db,
						{ ...row, id: "policy2", createdAt: later },
						"policy1",
					)
				)?.id,
			).toBe("policy2");
			expect(
				(
					await findTenantToolPolicyRevisions(db, {
						organizationId: "org",
						rootAppId: "app",
						mountedToolId: "write",
					})
				).map((r) => r.id),
			).toEqual(["policy2"]);
			await db
				.delete(coreTable(db, policy.tenantToolPolicies))
				.where(eq(coreTable(db, policy.tenantToolPolicies).id, "policy2"));
			expect(
				(await listDeletedTenantPolicyFences(db, "org")).map(
					(r) => r.revisionId,
				),
			).toEqual(["policy2"]);
			expect(
				await replaceTenantToolPolicy(
					db,
					{ ...row, id: "revive", createdAt: "2026-11-03" },
					"policy2",
				),
			).toBeUndefined();
		});

		it("advances auth and tenant resource fences inside the source write and rolls them back on failure", async () => {
			const before = await readAuthContextCacheVersion(db);
			await invalidateAuthContextCache(db);
			expect(await readAuthContextCacheVersion(db)).not.toBe(before);
			const current = await readAuthContextCacheVersion(db);
			await setProviderOnboardingConfiguration(db, "org", {
				enabled: true,
				providerAppId: "00000000-0000-4000-8000-000000000001",
				providerApiKeyId: "00000000-0000-4000-8000-000000000002",
				allowedOrigin: "https://example.test",
				hostTenantArgument: "tenant",
				hostTenantNamespace: "tenants",
				ownerUserId: "owner",
				ownerEmail: "owner@example.test",
				billingPlanKey: "growth",
			});
			expect(await readAuthContextCacheVersion(db)).toBe(current);
			await db
				.update(coreTable(db, organizations))
				.set({ descopeTenantId: "tenant" })
				.where(eq(coreTable(db, organizations).id, "org"));
			expect(await readAuthContextCacheVersion(db)).not.toBe(current);
			const input = {
				organizationId: "org",
				appIds: ["app"],
				toolRowId: "tool",
				connectionInstanceId: "missing",
			};
			const initial = await getTenantToolPolicyResourceGenerations(db, input);
			await db
				.update(coreTable(db, apps))
				.set({ slug: "updated" })
				.where(eq(coreTable(db, apps).id, "app"));
			const next = await getTenantToolPolicyResourceGenerations(db, input);
			expect(next.find((r) => r.kind === "app")?.generation).toBe(
				(initial.find((r) => r.kind === "app")?.generation ?? 0) + 1,
			);
			await expect(
				db.batch([
					db
						.update(coreTable(db, apps))
						.set({ slug: "rollback" })
						.where(eq(coreTable(db, apps).id, "app")),
					db
						.insert(coreTable(db, organizations))
						.values({ id: "org", name: "Duplicate", slug: "duplicate" }),
				]),
			).rejects.toThrow();
			expect(await getTenantToolPolicyResourceGenerations(db, input)).toEqual(
				next,
			);
		});

		it("preserves JSON organization projections and exact-scope grant precedence", async () => {
			await db
				.update(coreTable(db, organizations))
				.set({
					metadata: {
						tediWidget: {
							version: 1,
							title: "Assistant",
							subtitle: "Help",
							product: "Test",
							conversationStarters: [],
							locale: "de",
							translations: { de: { hello: "Hallo" } },
						},
						ownedChannel: {
							channel: "test",
							publisherTediSlug: "publisher",
							collection: "posts",
							locales: ["en"],
						},
					},
					features: { os: false },
				})
				.where(eq(coreTable(db, organizations).id, "org"));
			expect(
				(await getOrganizationGuestProfile(db, "org"))?.translations,
			).toEqual({ de: { hello: "Hallo" } });
			expect((await getOrganizationBySlug(db, "org"))?.id).toBe("org");
			expect((await getOrganizationOwnedChannel(db, "org"))?.channel).toBe(
				"test",
			);
			await setConnectionConsumerGrants(db, "org", "provider.with.dot", {
				mode: "all",
			});
			expect(
				await getConnectionConsumerGrants(db, "org", "provider.with.dot"),
			).toEqual({ mode: "all" });
			await buildApplyOrganizationPlanFeaturesStatement(
				db,
				"org",
				"starter",
				at,
			);
			const [org] = await db
				.select()
				.from(coreTable(db, organizations))
				.where(eq(coreTable(db, organizations).id, "org"));
			expect(org?.features?.os).toBe(false);
			await decrementAppCount(db, "org");
			const [counted] = await db
				.select()
				.from(coreTable(db, organizations))
				.where(eq(coreTable(db, organizations).id, "org"));
			expect(counted?.appsCount).toBe(0);
			for (const [id, appSlug, toolId] of [
				["global", "*", "*"],
				["exact", "app", "write"],
			])
				await createGrant(db, {
					id,
					organizationId: "org",
					subjectId: "subject",
					appSlug: appSlug!,
					toolId: toolId!,
					grantKind: "once",
				});
			const args = {
				organizationId: "org",
				subjectId: "subject",
				appSlug: "app",
				toolId: "write",
				grantKind: "once" as const,
				nowIso: at,
			};
			expect((await findActiveGrant(db, args))?.id).toBe("exact");
			expect(
				(
					await consumeGrant(db, {
						organizationId: "org",
						grantId: "exact",
						consumedAtIso: at,
					})
				).consumed,
			).toBe(true);
			expect((await findActiveGrant(db, args))?.id).toBe("global");
		});
		it("joins immutable execution and review evidence without losing JSON or review independence", async () => {
			await createExternalAgentPrincipal(db, {
				id: "owner-host",
				organizationId: "org",
				key: "owner-host",
				displayName: "Owner host",
				credentialBindingType: "owner_user",
				credentialBindingId: "human",
				createdByType: "user",
				createdById: "human",
				createdAt: at,
			});
			await openExternalAgentSession(db, {
				id: "owner-session",
				organizationId: "org",
				principalId: "owner-host",
				externalSessionKey: "codex:owner",
				harness: "codex",
				harnessVersion: "1",
				modelProvider: "test",
				modelId: "test",
				modelVersion: "1",
				identitySource: "explicit",
				startedAt: at,
			});
			expect(
				(
					await resolveOwnerHostSession(db, {
						organizationId: "org",
						userId: "human",
						sessionId: "owner-session",
					})
				)?.principal.id,
			).toBe("owner-host");
			const parties = await resolveCanonicalWorkParties(db, {
				organizationId: "org",
				parties: [{ type: "external_agent", id: "owner-host" }],
			});
			expect(parties.get("external_agent:owner-host")).toBe("user:human");
			const context = {
				taskFamily: "coding",
				repositoryKey: "example/repo",
				repositoryVersion: "test-sha",
				riskLevel: "low" as const,
				environment: "local",
			};
			await recordExternalAgentAttribution(db, {
				id: "attribution",
				organizationId: "org",
				principalId: "owner-host",
				sessionId: "owner-session",
				targetType: "commit",
				targetId: "a".repeat(40),
				role: "executor",
				certificationSource: "work_item_attempt",
				metadata: { reputationContext: context },
				occurredAt: at,
			});
			const review = {
				id: "review",
				organizationId: "org",
				executionAttributionId: "attribution",
				reviewerPrincipalType: "user" as const,
				reviewerPrincipalId: "reviewer",
				context,
				outcome: "success" as const,
				score: 1,
				policyViolationSeverity: 0,
				reviewMethod: "local-test",
				evidenceRefs: ["test:proof"],
				occurredAt: at,
			};
			await expect(
				recordExternalAgentReviewEvidence(db, {
					...review,
					reviewerPrincipalId: "human",
				}),
			).rejects.toMatchObject({ reason: "review_conflict" });
			expect((await recordExternalAgentReviewEvidence(db, review)).score).toBe(
				1,
			);
			const reputation = await getExternalAgentContextualReputation(db, {
				organizationId: "org",
				subjectPrincipalId: "owner-host",
				context: {
					...context,
					harness: "codex",
					harnessVersion: "1",
					modelProvider: "test",
					modelId: "test",
					modelVersion: "1",
				},
				now: later,
				halfLifeDays: 30,
			});
			expect(reputation.rawReviewCount).toBe(1);
			await expect(
				Promise.resolve().then(() =>
					execute(
						"UPDATE external_agent_sessions SET identity_source = 'derived' WHERE id = 'owner-session'",
					),
				),
			).rejects.toThrow();
		});

		it("linearizes a signed inherited publishing receipt and rejects its later revocation", async () => {
			await db
				.update(coreTable(db, appTools))
				.set({
					config: { ownedChannelPublish: { routes: ["gateway:publish"] } },
				})
				.where(eq(coreTable(db, appTools).id, "tool"));
			await db.insert(coreTable(db, projects)).values({
				id: "project",
				orgId: "org",
				key: "TEST",
				name: "Test",
				createdAt: at,
			});
			await db.insert(coreTable(db, tedis)).values({
				id: "publisher",
				organizationId: "org",
				slug: "publisher",
				name: "Publisher",
				status: "active",
			});
			await db.insert(coreTable(db, workItems)).values({
				id: "parent",
				orgId: "org",
				projectId: "project",
				title: "Campaign",
				workKind: "communication",
				disposition: "accepted",
				metadata: { marketingCampaign: { key: "campaign" } },
				createdAt: at,
			});
			await db.insert(coreTable(db, workItems)).values({
				id: "leaf",
				orgId: "org",
				projectId: "project",
				parentWorkItemId: "parent",
				title: "Publish",
				workKind: "communication",
				disposition: "accepted",
				accountableOwnerType: "tedi",
				accountableOwnerId: "publisher",
				metadata: { marketingCampaign: { key: "campaign" } },
				createdAt: at,
			});
			await db.insert(coreTable(db, workAttempts)).values({
				id: "attempt",
				workItemId: "leaf",
				orgId: "org",
				executorType: "tedi",
				executorId: "publisher",
				runtimeState: "running",
				attemptNumber: 1,
				startedAt: at,
				heartbeatAt: at,
			});
			const body = JSON.stringify({
				version: 1,
				campaignKey: "campaign",
				channel: "test",
				allowedAction: "content_publish",
				contentRisk: "low",
				collection: "posts",
				contentIds: ["post"],
				validUntil: later,
			});
			const secret = "local-test-proof";
			const writeReceipt = async (
				id: string,
				eventType:
					| typeof OWNED_CHANNEL_AUTHORIZATION_EVENT
					| typeof OWNED_CHANNEL_AUTHORIZATION_REVOKED_EVENT,
			) => {
				const signature = await signOwnedChannelAuthorizationProof(secret, {
					commentId: id,
					workItemId: "parent",
					organizationId: "org",
					authorId: "human",
					eventType,
					body,
					createdAt: at,
				});
				await recordOwnedChannelAuthorizationEvent(db, {
					id,
					orgId: "org",
					workItemId: "parent",
					actorId: "human",
					eventType,
					body,
					signature,
					occurredAt: at,
				});
			};
			await writeReceipt("authorization", OWNED_CHANNEL_AUTHORIZATION_EVENT);
			const args = {
				organizationId: "org",
				subjectId: "publisher",
				appSlug: "gateway",
				toolId: "publish",
				args: { collection: "posts", id: "post", locale: "en" },
				authorizationSigningSecret: secret,
				nowIso: at,
			};
			expect(await resolveWorkItemAuthorization(db, args)).toMatchObject({
				approved: true,
				authorizationScopeWorkItemId: "parent",
			});
			await writeReceipt(
				"revocation",
				OWNED_CHANNEL_AUTHORIZATION_REVOKED_EVENT,
			);
			expect(await resolveWorkItemAuthorization(db, args)).toMatchObject({
				approved: false,
				reason: "authorization_revoked",
			});
		});
		it("tracks app, tool and connection generations for insert, relevant update and delete", async () => {
			const app = coreTable(db, apps);
			const tool = coreTable(db, appTools);
			const connection = coreTable(db, connectionInstances);
			await db.insert(app).values({
				id: "generation-app",
				organizationId: "other",
				name: "Generation",
				slug: "generation",
			});
			await db.insert(tool).values({
				id: "generation-tool",
				appId: "generation-app",
				toolId: "write",
				toolTypeId: "native",
				title: "Generation",
			});
			await db.insert(connection).values({
				id: "generation-connection",
				organizationId: "other",
				ownerUserId: "owner",
				providerId: "example",
				label: "Example",
				tokenIds: [],
				createdAt: at,
				updatedAt: at,
			});
			const read = () =>
				getTenantToolPolicyResourceGenerations(db, {
					organizationId: "other",
					appIds: ["generation-app"],
					toolRowId: "generation-tool",
					connectionInstanceId: "generation-connection",
				});
			expect((await read()).map((row) => row.generation)).toEqual([1, 1, 1]);
			await db.batch([
				db
					.update(app)
					.set({ name: "Display only" })
					.where(eq(app.id, "generation-app")),
				db
					.update(tool)
					.set({ title: "Changed" })
					.where(eq(tool.id, "generation-tool")),
				db
					.update(connection)
					.set({ label: "Display only" })
					.where(eq(connection.id, "generation-connection")),
			]);
			expect((await read()).map((row) => row.generation)).toEqual([1, 2, 1]);
			await db.batch([
				db
					.update(app)
					.set({ slug: "changed-generation" })
					.where(eq(app.id, "generation-app")),
				db
					.update(connection)
					.set({ tokenSub: "changed" })
					.where(eq(connection.id, "generation-connection")),
			]);
			expect((await read()).map((row) => row.generation)).toEqual([2, 2, 2]);
			await db.batch([
				db.delete(tool).where(eq(tool.id, "generation-tool")),
				db.delete(app).where(eq(app.id, "generation-app")),
				db.delete(connection).where(eq(connection.id, "generation-connection")),
			]);
			expect((await read()).map((row) => row.generation)).toEqual([3, 3, 3]);
		});
	});
