/// <reference types="node" />
import { projects as sqliteProjects } from "../schema/projects";
import { projects as pgProjects } from "./schema/projects";
import { tedis as sqliteTedis } from "../schema/tedis";
import { tedis as pgTedis } from "./schema/tedis";
import { apps as sqliteApps } from "../schema/apps";
import { apps as pgApps } from "./schema/apps";
import { sumRunInferenceCharges as sumSqliteSpending } from "../queries/billing/spending";
import { sumRunInferenceCharges as sumPostgresSpending } from "./queries/billing/spending";

import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import {
	afterAll,
	beforeAll,
	beforeEach,
	afterEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import { createDbClient } from "../client";
import { getMembersByOrganization as getSqliteMembers } from "../queries/organization-members";
import {
	getOrganizationBySlug as getSqliteOrganization,
	getOrganizationGuestProfile as getSqliteGuestProfile,
	listOrganizations as listSqliteOrganizations,
} from "../queries/organizations";
import { resolvePrincipalIdentity as resolveSqlitePrincipal } from "../queries/principal-identities";
import { listLatestWorkAttemptSummaries as listSqliteAttemptSummaries } from "../queries/work-items/attempts";
import { listWorkItems as listSqliteWorkItems } from "../queries/work-items/crud";
import {
	billingPlanVersions as sqliteBillingPlanVersions,
	billingUsageReservations as sqliteBillingUsageReservations,
} from "../schema/billing";
import { organizationMembers as sqliteOrganizationMembers } from "../schema/organization-members";
import { organizations as sqliteOrganizations } from "../schema/organizations";
import { principalIdentities as sqlitePrincipalIdentities } from "../schema/principal-identities";
import {
	workAttempts as sqliteWorkAttempts,
	workItems as sqliteWorkItems,
} from "../schema/work-items";
import { createD1Facade } from "../test/d1-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import { getMembersByOrganization as getPgMembers } from "./queries/organization-members";
import {
	getOrganizationBySlug as getPgOrganization,
	getOrganizationGuestProfile as getPgGuestProfile,
	listOrganizations as listPgOrganizations,
} from "./queries/organizations";
import { resolvePrincipalIdentity as resolvePgPrincipal } from "./queries/principal-identities";
import {
	listLatestWorkAttemptSummaries as listPgAttemptSummaries,
	listWorkItems as listPgWorkItems,
} from "./queries/work-items";
import {
	billingAccounts as pgBillingAccounts,
	billingCreditEntries as pgBillingCreditEntries,
	billingPlanVersions as pgBillingPlanVersions,
	billingUsageReservations as pgBillingUsageReservations,
} from "./schema/billing";
import {
	organizationMembers as pgOrganizationMembers,
	organizations as pgOrganizations,
} from "./schema/organizations";
import { principalIdentities as pgPrincipalIdentities } from "./schema/principal-identities";
import { workAdmissions as pgWorkAdmissions } from "./schema/work-factory";
import {
	workAttempts as pgWorkAttempts,
	workItems as pgWorkItems,
} from "./schema/work-items";

import * as orgQueries from "../queries/organizations";
import * as memberQueries from "../queries/organization-members";
import * as identityQueries from "../queries/principal-identities";
import * as sessionQueries from "../queries/oidc-sessions";
import {
	resolveCoreStore,
	type CoreStoreBinding,
} from "../queries/postgres/core-store";
import type { PgQueryClient } from "./query-client";
import { users as sqliteUsers } from "../schema/users";
import { users as pgUsers } from "./schema/users";
import { apiKeys as sqliteApiKeys } from "../schema/api-keys";
import { apiKeys as pgApiKeys } from "./schema/api-keys";
import { billingAccounts as sqliteBillingAccounts } from "../schema/billing";

const now = "2026-11-05T12:00:00.000Z";
const later = "2026-11-05T12:05:00.000Z";
const organization = {
	id: "org-parity",
	name: "Parity Org",
	slug: "parity-org",
	type: "organization",
	descopeTenantId: "tenant-parity",
	logoUrl: "https://example.test/logo.png",
	description: "Cross-dialect fixture",
	appsCount: 2,
	features: { maxApps: 5 },
	metadata: {
		tediWidget: {
			version: 1,
			locale: "de",
			title: "Parity assistant",
			subtitle: "Cross-dialect fixture",
			product: "Parity",
			conversationStarters: [],
			translations: { de: { welcome: "Hallo" } },
		},
	},
	createdAt: now,
	updatedAt: now,
} satisfies typeof sqliteOrganizations.$inferInsert;

const member = {
	id: "member-parity",
	organizationId: organization.id,
	userId: "user-parity",
	descopeUserId: "descope-parity",
	email: "member@example.test",
	name: "Parity Member",
	avatarUrl: null,
	kind: "human",
	representedUserId: null,
	role: "owner",
	customPermissions: [],
	status: "active",
	invitedAt: null,
	inviteAcceptedAt: now,
	invitedBy: "user-parity",
	lastActiveAt: later,
	createdAt: now,
	updatedAt: later,
} satisfies typeof sqliteOrganizationMembers.$inferInsert;

const principal = {
	id: "principal-parity",
	organizationId: organization.id,
	principalType: "user",
	principalId: "user-parity",
	provider: "oidc",
	issuer: "https://issuer.example.test",
	subject: "subject-parity",
	status: "active",
	metadata: { source: "parity" },
	lastVerifiedAt: later,
	createdAt: now,
	updatedAt: later,
} as const;

const workItem = {
	id: "work-parity",
	orgId: organization.id,
	title: "Parity work",
	description: "Same result on both backends",
	disposition: "accepted",
	workKind: "coding",
	riskLevel: "medium",
	acceptanceContract: { version: 1, doneLooksLike: "Parity passes" },
	requiredCapabilities: ["database"],
	requiredAuthorities: [],
	admissionSpecRevision: "revision-parity",
	priority: "high",
	provenance: { source: "test" },
	metadata: { executor: "opencode" },
	createdAt: now,
	updatedAt: later,
	version: 2,
} satisfies typeof sqliteWorkItems.$inferInsert;

const attempt = {
	id: "attempt-parity",
	admissionId: "admission-parity",
	workItemId: workItem.id,
	orgId: organization.id,
	executorType: "external_agent",
	executorId: "agent-parity",
	executorSessionId: "session-parity",
	externalSessionKey: "opencode:session-parity",
	runId: null,
	runtimeState: "running",
	outcome: null,
	attemptNumber: 1,
	startedAt: now,
	heartbeatAt: later,
	expiresAt: "2026-11-05T12:20:00.000Z",
	finishedAt: null,
	summary: null,
	version: 1,
	metadata: { dispatchVersion: 2 },
} as const;

const admission = {
	id: attempt.admissionId,
	orgId: organization.id,
	workItemId: workItem.id,
	workItemVersion: workItem.version,
	admissionSpecRevision: workItem.admissionSpecRevision,
	executorType: attempt.executorType,
	executorId: attempt.executorId,
	executorSessionId: attempt.executorSessionId,
	externalSessionKey: attempt.externalSessionKey,
	decision: "admitted",
	rejectionCode: null,
	rejectionReason: null,
	rejectionKey: null,
	maxCostMicros: null,
	decidedAt: now,
	expiresAt: attempt.expiresAt,
	createdAt: now,
} satisfies typeof pgWorkAdmissions.$inferInsert;

const plan = {
	id: "plan-parity",
	planKey: "growth",
	version: 999,
	status: "active",
	name: "Growth",
	currency: "usd",
	monthlyPriceMicros: 1_000_000,
	annualPriceMicros: 10_000_000,
	includedMonthlyTokens: 100_000,
	includedMonthlyCreditMicros: 0,
	overageUnitTokens: 1_000,
	overageUnitPriceMicros: 100,
	maxTedis: 3,
	maxCronJobsPerTedi: 5,
	maxIterationsPerTask: 10,
	defaultDailyTokenLimit: 50_000,
	defaultDailyMessageLimit: 100,
	allowOverage: true,
	metadata: {},
	effectiveAt: now,
	createdAt: now,
} as const;

const reservation = {
	id: "reservation-parity",
	organizationId: organization.id,
	planVersionId: plan.id,
	tediId: null,
	status: "reserved",
	source: "operator",
	provider: "anthropic",
	model: "model-parity",
	estimatedInputTokens: 100,
	estimatedOutputTokens: 50,
	estimatedChargeMicros: 1234,
	periodStart: now,
	periodEnd: "2026-12-05T12:00:00.000Z",
	runId: "run-parity",
	traceId: "trace-parity",
	idempotencyKey: "reservation-parity-key",
	rejectionCode: null,
	expiresAt: "2026-11-05T12:10:00.000Z",
	settledAt: null,
	releasedAt: null,
	metadata: {
		monetaryQuote: { rateSnapshot: { customerCurrency: "EUR" } },
	},
	createdAt: now,
	updatedAt: now,
} as const;

const onboarding: NonNullable<
	import("../schema/organizations").OrganizationMetadata["providerOnboarding"]
> = {
	enabled: true,
	providerAppId: "00000000-0000-4000-8000-000000000001",
	providerApiKeyId: "00000000-0000-4000-8000-000000000002",
	allowedOrigin: "https://example.test",
	hostTenantArgument: "tenantId",
	hostTenantNamespace: "tenant",
	ownerUserId: "owner",
	ownerEmail: "owner@example.test",
	billingPlanKey: "growth",
};

const pg = new PGlite();
const pgDb = drizzlePglite({ client: pg });
let parityMigration: Promise<void> | undefined;

/** Both fixture groups share the engine, never mutable SQLite fixture state. */
function migrateParityPostgres(): Promise<void> {
	return (parityMigration ??= (async () => {
		const migrationRoot = fileURLToPath(
			new URL("../../drizzle-pg", import.meta.url),
		);
		const migrations = (await readdir(migrationRoot))
			.filter((name) => /^\d{14}_/.test(name))
			.sort();
		for (const directory of migrations) {
			const migration = await readFile(
				join(migrationRoot, directory, "migration.sql"),
				"utf8",
			);
			await pg.exec(migration);
		}
	})());
}
afterAll(async () => {
	await pg.close();
});

describe("SQLite and Postgres core query parity", () => {
	const sqlite = createMigratedSqlite();
	// This test compares read semantics; admission fencing has its own production-chain tests.
	sqlite.exec("DROP TRIGGER work_attempt_admission_insert_guard");
	const sqliteDb = createDbClient(createD1Facade(sqlite));

	beforeAll(async () => {
		await migrateParityPostgres();

		await sqliteDb.insert(sqliteOrganizations).values(organization);
		await sqliteDb.insert(sqliteOrganizationMembers).values(member);
		await sqliteDb.insert(sqlitePrincipalIdentities).values(principal);
		await sqliteDb.insert(sqliteWorkItems).values(workItem);
		await sqliteDb.insert(sqliteWorkAttempts).values(attempt);
		await sqliteDb.insert(sqliteBillingPlanVersions).values(plan);
		await sqliteDb.insert(sqliteBillingUsageReservations).values(reservation);

		await pgDb.insert(pgOrganizations).values(organization);
		await pgDb.insert(pgOrganizationMembers).values(member);
		await pgDb.insert(pgPrincipalIdentities).values(principal);
		await pgDb.insert(pgWorkItems).values(workItem);
		await pgDb.insert(pgWorkAdmissions).values(admission);
		await pgDb.insert(pgWorkAttempts).values(attempt);
		await pgDb.insert(pgBillingPlanVersions).values(plan);
		await pgDb.insert(pgBillingAccounts).values({
			organizationId: organization.id,
			planVersionId: plan.id,
			status: "active",
			billingMode: "internal",
			periodStart: now,
			periodEnd: reservation.periodEnd,
			createdAt: now,
			updatedAt: now,
		});
		await pgDb.insert(pgBillingUsageReservations).values(reservation);
	}, 30_000);

	afterAll(() => sqlite.close());

	it("returns identical organization, identity, billing, Work, and Attempt results", async () => {
		const [sqliteOrganization, pgOrganization] = await Promise.all([
			getSqliteOrganization(sqliteDb, organization.slug),
			getPgOrganization(pgDb, organization.slug),
		]);
		expect(pgOrganization).toEqual(sqliteOrganization);
		const [sqliteOrganizations, pgOrganizations] = await Promise.all([
			listSqliteOrganizations(sqliteDb),
			listPgOrganizations(pgDb),
		]);
		expect(pgOrganizations).toEqual(sqliteOrganizations);

		const [sqliteGuest, pgGuest] = await Promise.all([
			getSqliteGuestProfile(sqliteDb, organization.id),
			getPgGuestProfile(pgDb, organization.id),
		]);
		expect(pgGuest).toEqual(sqliteGuest);

		const [sqliteMembers, pgMembers] = await Promise.all([
			getSqliteMembers(sqliteDb, organization.id, { status: "active" }),
			getPgMembers(pgDb, organization.id, { status: "active" }),
		]);
		expect(pgMembers).toEqual(sqliteMembers);

		const externalIdentity = {
			provider: principal.provider,
			issuer: `${principal.issuer}/`,
			subject: principal.subject,
		};
		const [sqliteIdentity, pgIdentity] = await Promise.all([
			resolveSqlitePrincipal(sqliteDb, externalIdentity),
			resolvePgPrincipal(pgDb, externalIdentity),
		]);
		expect(pgIdentity).toEqual(sqliteIdentity);

		const [sqliteItems, pgItems] = await Promise.all([
			listSqliteWorkItems(sqliteDb, {
				orgId: organization.id,
				disposition: "accepted",
				workKind: "coding",
			}),
			listPgWorkItems(pgDb, {
				orgId: organization.id,
				disposition: "accepted",
				workKind: "coding",
			}),
		]);
		// SQLite rows also carry columns it generates from `metadata` for its own
		// indexes; the frozen Postgres copy stores `metadata` only.
		const sqliteGenerated = new Set([
			"repositoryObserver",
			"report",
			"observerWokenAt",
			"metadataExecutor",
			"metadataSource",
		]);
		expect(pgItems).toEqual(
			sqliteItems.map((item) =>
				Object.fromEntries(
					Object.entries(item).filter(([key]) => !sqliteGenerated.has(key)),
				),
			),
		);

		const [sqliteAttempts, pgAttempts] = await Promise.all([
			listSqliteAttemptSummaries(sqliteDb, {
				orgId: organization.id,
				workItemIds: [workItem.id],
			}),
			listPgAttemptSummaries(pgDb, {
				orgId: organization.id,
				workItemIds: [workItem.id],
			}),
		]);
		expect(Object.fromEntries(pgAttempts)).toEqual(
			Object.fromEntries(sqliteAttempts),
		);
	});

	it("keeps hashed credential rotation and revocation rows identical", async () => {
		const key = {
			id: "core-parity-key",
			organizationId: organization.id,
			name: "Parity credential",
			keyHash: "0".repeat(64),
			keyPreview: "fixture",
			previousKeyHash: "1".repeat(64),
			previousKeyExpiresAt: later,
			createdAt: now,
			updatedAt: now,
		};
		await sqliteDb.insert(sqliteApiKeys).values(key);
		await pgDb.insert(pgApiKeys).values(key);
		expect(await pgDb.select().from(pgApiKeys)).toEqual(
			await sqliteDb.select().from(sqliteApiKeys),
		);
		const revoked = {
			status: "revoked" as const,
			revokedAt: later,
			revokedBy: "user-parity",
			revokeReason: "Organization retired",
			previousKeyHash: null,
			previousKeyExpiresAt: null,
			updatedAt: later,
		};
		await sqliteDb
			.update(sqliteApiKeys)
			.set(revoked)
			.where(eq(sqliteApiKeys.id, key.id));
		await pgDb.update(pgApiKeys).set(revoked).where(eq(pgApiKeys.id, key.id));
		const rows = await pgDb.select().from(pgApiKeys);
		expect(rows).toEqual(await sqliteDb.select().from(sqliteApiKeys));
		expect(rows[0]).toMatchObject({
			status: "revoked",
			previousKeyHash: null,
			previousKeyExpiresAt: null,
		});
	});

	it("rejects an Attempt that does not match its admitted fence", async () => {
		await expect(
			pgDb.insert(pgWorkAttempts).values({
				...attempt,
				id: "attempt-invalid",
				admissionId: "admission-missing",
				attemptNumber: 2,
			}),
		).rejects.toThrow();
		await expect(
			pgDb
				.update(pgWorkAdmissions)
				.set({ expiresAt: "2026-11-05T12:30:00.000Z" })
				.where(eq(pgWorkAdmissions.id, admission.id)),
		).rejects.toThrow();
	});

	it("updates the credit balance atomically and keeps entries immutable", async () => {
		await pgDb.insert(pgBillingCreditEntries).values({
			id: "credit-grant",
			organizationId: organization.id,
			kind: "grant",
			amountMicros: 100,
			sourceType: "test",
			idempotencyKey: "credit-grant-key",
			createdAt: later,
		});
		const [account] = await pgDb
			.select({ balance: pgBillingAccounts.creditBalanceMicros })
			.from(pgBillingAccounts)
			.where(eq(pgBillingAccounts.organizationId, organization.id));
		expect(account?.balance).toBe(100);

		await expect(
			pgDb.insert(pgBillingCreditEntries).values({
				id: "credit-overdraft",
				organizationId: organization.id,
				kind: "debit",
				amountMicros: -101,
				sourceType: "test",
				idempotencyKey: "credit-overdraft-key",
				createdAt: later,
			}),
		).rejects.toThrow();
		await expect(
			pgDb
				.update(pgBillingCreditEntries)
				.set({ description: "changed" })
				.where(eq(pgBillingCreditEntries.id, "credit-grant")),
		).rejects.toThrow();
	});
	describe("resolver-routed identity and organization lifecycle", () => {
		let caseNumber = 0;
		let orgId: string;
		let memberId: string;
		let userId: string;
		let subject: string;
		let uuidNumber = 0;
		const clients = { platform: sqliteDb, postgres: pgDb };
		const stores = [
			resolveCoreStore({}, clients),
			resolveCoreStore({ plane: "postgres" }, clients),
		];

		async function parity<T>(
			run: (store: CoreStoreBinding<PgQueryClient>) => Promise<T>,
		) {
			vi.spyOn(crypto, "randomUUID").mockReturnValue(
				`00000000-0000-4000-8000-${String(++uuidNumber).padStart(12, "0")}`,
			);
			const left = await run(stores[0]!);
			const right = await run(stores[1]!);
			expect(right).toEqual(left);
			return left;
		}

		async function sameError(
			run: (store: CoreStoreBinding<PgQueryClient>) => Promise<unknown>,
			message: string,
		) {
			for (const store of stores)
				await expect(run(store)).rejects.toThrow(message);
		}

		beforeEach(async () => {
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(new Date(now));
			orgId = `core-case-${++caseNumber}`;
			memberId = `${orgId}-member`;
			userId = `${orgId}-user`;
			subject = `${orgId}-subject`;
			const org = {
				...organization,
				id: orgId,
				slug: orgId,
				descopeTenantId: orgId,
				features: { maxApps: 5, os: true },
				metadata: {
					...organization.metadata,
					mcpInboundClientPolicy: { mode: "audit" as const, entries: [] },
				},
			};
			const person = {
				...member,
				id: memberId,
				organizationId: orgId,
				userId,
				descopeUserId: subject,
				email: `${orgId}@example.test`,
			};
			const user = {
				id: userId,
				email: person.email,
				name: person.name,
				createdAt: now,
				updatedAt: now,
			};
			await sqliteDb.insert(sqliteOrganizations).values(org);
			await pgDb.insert(pgOrganizations).values(org);
			await sqliteDb.insert(sqliteOrganizationMembers).values(person);
			await pgDb.insert(pgOrganizationMembers).values(person);
			await sqliteDb.insert(sqliteUsers).values(user);
			await pgDb.insert(pgUsers).values(user);
		});

		afterEach(() => {
			vi.useRealTimers();
			vi.restoreAllMocks();
		});

		it("keeps project bindings, review context and policy settings identical", async () => {
			const project = {
				id: `${orgId}-project`,
				orgId,
				key: "CORE",
				name: "Core",
				createdAt: now,
				updatedAt: now,
			};
			await sqliteDb.insert(sqliteProjects).values(project);
			await pgDb.insert(pgProjects).values(project);
			const foreignProject = {
				...project,
				id: `${orgId}-foreign`,
				orgId: organization.id,
				key: orgId,
			};
			await sqliteDb.insert(sqliteProjects).values(foreignProject);
			await pgDb.insert(pgProjects).values(foreignProject);
			await parity((db) =>
				orgQueries.updateOrganization(db, orgId, {
					metadata: {
						secretEgressMode: "warn",
						personalDataRedaction: { enabled: true },
						sessionProjectBindings: [
							{ prefix: "CORE", projectId: project.id },
							{ prefix: "FOREIGN", projectId: foreignProject.id },
							{ prefix: "MISSING", projectId: "missing" },
						],
					},
				}),
			);
			expect(
				await parity((db) =>
					orgQueries.getOrganizationSessionProjectBindings(db, orgId),
				),
			).toEqual([{ prefix: "CORE", projectId: project.id }]);
			for (const id of [orgId, "missing"]) {
				await parity((db) =>
					orgQueries.getOrganizationSecretEgressMode(db, id),
				);
				await parity((db) =>
					orgQueries.getOrganizationPersonalDataRedaction(db, id),
				);
				await parity((db) =>
					orgQueries.getOrganizationSessionProjectBindings(db, id),
				);
			}
			const identity = {
				provider: "oidc",
				issuer: "https://issuer.example.test",
				subject: orgId,
			};
			for (const reviewProjectId of [project.id, "missing"])
				await parity((db) =>
					identityQueries.resolveUserTenantIdentityContext(db, {
						organizationIdentity: identity,
						userIdentity: { ...identity, subject },
						reviewProjectId,
					}),
				);
		});

		it("keeps tedi membership counts, gateways, app reconciliation and retirement identical", async () => {
			const live = {
				id: `${orgId}-tedi`,
				organizationId: orgId,
				name: "Core",
				slug: `${orgId}-tedi`,
				descopeUserId: subject,
				avatar: "core",
				createdAt: now,
				updatedAt: now,
			};
			const retired = {
				...live,
				id: `${orgId}-retired`,
				slug: `${orgId}-retired`,
				retiredAt: now,
			};
			const foreign = {
				...live,
				id: `${orgId}-foreign`,
				organizationId: organization.id,
				slug: `${orgId}-foreign`,
			};
			for (const tedi of [live, retired, foreign]) {
				await sqliteDb.insert(sqliteTedis).values(tedi);
				await pgDb.insert(pgTedis).values(tedi);
			}
			const app = {
				id: `${orgId}-app`,
				organizationId: orgId,
				name: "Gateway",
				slug: `${orgId}-unified`,
				metadata: { mcpConfig: { authMode: "authenticated", codeMode: true } },
				createdAt: now,
				updatedAt: now,
			};
			await sqliteDb.insert(sqliteApps).values(app);
			await pgDb.insert(pgApps).values(app);
			const key = {
				id: `${orgId}-key`,
				organizationId: orgId,
				name: "Core",
				keyPreview: "test",
				keyHash: `${orgId}-hash`,
				createdBy: userId,
				createdAt: now,
				updatedAt: now,
				status: "active" as const,
			};
			await sqliteDb.insert(sqliteApiKeys).values(key);
			await pgDb.insert(pgApiKeys).values(key);
			expect(
				await parity((db) =>
					memberQueries.listTedisByMemberDescopeUserIds(db, orgId, [
						subject,
						subject,
						"missing",
					]),
				),
			).toEqual([{ descopeUserId: subject, tediId: live.id, avatar: "core" }]);
			await parity((db) =>
				memberQueries.listTedisByMemberDescopeUserIds(db, orgId, []),
			);
			for (const activeOnly of [true, false]) {
				const memberships = await parity((db) =>
					memberQueries.getUserOrganizationMemberships(db, subject, {
						activeOnly,
					}),
				);
				expect(memberships[0]?.tediCount).toBe(1);
			}
			await parity((db) =>
				memberQueries.getUserOrganizationMemberships(db, "missing"),
			);
			await parity((db) =>
				memberQueries.getOrganizationAggregatorGateways(db, []),
			);
			expect(
				(
					await parity((db) =>
						memberQueries.getOrganizationAggregatorGateways(db, [
							orgId,
							orgId,
							"missing",
						]),
					)
				).get(orgId)?.slug,
			).toBe(app.slug);
			expect(await parity((db) => orgQueries.syncAppCount(db, orgId))).toBe(1);
			const params = {
				id: orgId,
				retiredAt: later,
				retiredBy: userId,
				features: { maxApps: 0 },
				metadata: {
					retiredAt: later,
					retiredSlug: orgId,
					memoryRetained: true as const,
				},
			};
			await parity((db) => orgQueries.retireOrganization(db, params));
			await parity((db) => orgQueries.retireOrganization(db, params));
			await parity((db) =>
				orgQueries.retireOrganization(db, { ...params, id: "missing" }),
			);
			expect(
				await parity((db) =>
					memberQueries.getUserOrganizationMemberships(db, subject),
				),
			).toEqual([]);
			expect(
				await parity((db) =>
					memberQueries.listTedisByMemberDescopeUserIds(db, orgId, [subject]),
				),
			).toEqual([]);
			expect(
				await parity((db) => memberQueries.getMemberById(db, memberId)),
			).toMatchObject({ status: "deactivated" });
			const [leftKey] = await sqliteDb
				.select()
				.from(sqliteApiKeys)
				.where(eq(sqliteApiKeys.id, key.id));
			const [rightKey] = await pgDb
				.select()
				.from(pgApiKeys)
				.where(eq(pgApiKeys.id, key.id));
			expect(rightKey).toEqual(leftKey);
			expect(rightKey?.status).toBe("revoked");
			const [leftApp] = await sqliteDb
				.select({ visibility: sqliteApps.visibility })
				.from(sqliteApps)
				.where(eq(sqliteApps.id, app.id));
			const [rightApp] = await pgDb
				.select({ visibility: pgApps.visibility })
				.from(pgApps)
				.where(eq(pgApps.id, app.id));
			expect(rightApp).toEqual(leftApp);
			expect(rightApp?.visibility).toBe("disabled");
		});

		it("rolls back every retirement update when the organization update fails", async () => {
			sqlite.exec(
				`CREATE TRIGGER reject_retirement BEFORE UPDATE ON organizations WHEN NEW.id = '${orgId}' BEGIN SELECT RAISE(ABORT, 'retirement rejected'); END`,
			);
			await pg.exec(
				`CREATE FUNCTION reject_retirement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'retirement rejected'; END $$; CREATE TRIGGER reject_retirement BEFORE UPDATE ON organizations FOR EACH ROW WHEN (NEW.id = '${orgId}') EXECUTE FUNCTION reject_retirement()`,
			);
			try {
				for (const store of stores)
					await expect(
						orgQueries.retireOrganization(store, {
							id: orgId,
							retiredAt: later,
							retiredBy: userId,
							features: {},
							metadata: {
								retiredAt: later,
								retiredSlug: orgId,
								memoryRetained: true,
							},
						}),
					).rejects.toThrow();
				expect(
					await parity((db) => memberQueries.getMemberById(db, memberId)),
				).toMatchObject({ status: "active" });
				expect(
					await parity((db) => orgQueries.getOrganizationById(db, orgId)),
				).toMatchObject({ slug: orgId });
			} finally {
				sqlite.exec("DROP TRIGGER reject_retirement");
				await pg.exec(
					"DROP TRIGGER reject_retirement ON organizations; DROP FUNCTION reject_retirement()",
				);
			}
		});

		it("keeps organization projections, JSON updates, counters, defaults and retirement filters identical", async () => {
			for (const id of [orgId, "missing"]) {
				await parity((db) => orgQueries.getOrganizationById(db, id));
				await parity((db) => orgQueries.getOrganizationProfile(db, id));
				await parity((db) => orgQueries.getOrganizationGuestProfile(db, id));
				await parity((db) => orgQueries.getOrganizationDescopeTenantId(db, id));
				await parity((db) => orgQueries.getOrganizationDisplayName(db, id));
				await parity((db) => orgQueries.getOrganizationOsTheme(db, id));
				await parity((db) => orgQueries.getOrganizationByDescopeId(db, id));
				await parity((db) =>
					orgQueries.getOrganizationBySlug(db, id.toUpperCase()),
				);
			}
			await parity((db) =>
				orgQueries.listOrganizations(db, { limit: 2, offset: 1 }),
			);
			await parity((db) => orgQueries.listOrganizationWidgetQuotaStatus(db));
			await parity((db) => orgQueries.isSlugAvailable(db, orgId));
			await parity((db) => orgQueries.isSlugAvailable(db, orgId, orgId));
			await parity((db) => orgQueries.generateUniqueSlug(db, "Available Slug"));
			vi.spyOn(Math, "random").mockReturnValue(0.125);
			await parity((db) => orgQueries.generateUniqueSlug(db, orgId));
			await parity((db) =>
				orgQueries.updateOrganization(db, orgId, {
					name: "Updated",
					type: "personal",
				}),
			);
			await parity((db) => orgQueries.getPersonalOrganization(db, subject));
			await parity((db) =>
				orgQueries.updateOrganizationFeatures(db, orgId, { maxApps: 9 }),
			);
			await parity((db) =>
				orgQueries.applyOrganizationPlanFeatures(db, orgId, "growth"),
			);
			for (const os of [true, false]) {
				await parity((db) =>
					orgQueries.updateOrganizationFeatures(db, orgId, { os }),
				);
				const result = await parity((db) =>
					orgQueries.applyOrganizationPlanFeatures(db, orgId, "starter"),
				);
				expect(result.features?.os).toBe(os);
			}
			await parity((db) => orgQueries.incrementAppCount(db, orgId));
			for (let i = 0; i < 4; i++)
				await parity((db) => orgQueries.decrementAppCount(db, orgId));
			expect(
				(await parity((db) => orgQueries.getOrganizationById(db, orgId)))
					?.appsCount,
			).toBe(0);
			await parity((db) =>
				orgQueries.updateOrganization(db, orgId, { appsCount: null }),
			);
			await parity((db) => orgQueries.decrementAppCount(db, orgId));
			expect(
				(await parity((db) => orgQueries.getOrganizationById(db, orgId)))
					?.appsCount,
			).toBeNull();
			await parity((db) =>
				orgQueries.getConnectionConsumerGrants(
					db,
					orgId,
					'provider/with:"punctuation',
					"instance space",
				),
			);
			await parity((db) =>
				orgQueries.setConnectionConsumerGrants(
					db,
					orgId,
					'provider/with:"punctuation',
					{ mode: "selected", tediIds: [], skills: [] },
					"instance space",
				),
			);
			await parity((db) =>
				orgQueries.getConnectionConsumerGrants(
					db,
					orgId,
					'provider/with:"punctuation',
					"instance space",
				),
			);
			await parity((db) =>
				orgQueries.setProviderOnboardingConfiguration(db, orgId, onboarding),
			);
			await parity((db) => orgQueries.getOrganizationById(db, orgId));
			await parity((db) =>
				orgQueries.updateOrganizationMetadata(db, orgId, { retiredAt: later }),
			);
			expect(
				await parity((db) => orgQueries.getOrganizationBySlug(db, orgId)),
			).toBeUndefined();
			expect(
				await parity((db) => orgQueries.getOrganizationByDescopeId(db, orgId)),
			).toBeUndefined();
			expect(
				await parity((db) => orgQueries.getPersonalOrganization(db, subject)),
			).toBeUndefined();
			await sameError(
				(db) => orgQueries.updateOrganization(db, "missing", { name: "No" }),
				"Organization not found",
			);
			await sameError(
				(db) => orgQueries.getConnectionConsumerGrants(db, "missing", "x"),
				"Organization not found",
			);
		});

		it("matches null ordering and stored widget override decoding", async () => {
			const nullable = {
				...organization,
				id: `${orgId}-null`,
				slug: `${orgId}-null`,
				descopeTenantId: null,
				createdAt: null,
			};
			await sqliteDb.insert(sqliteOrganizations).values(nullable);
			await pgDb.insert(pgOrganizations).values(nullable);
			// Neither database promises an order among equal creation times, so
			// compare the creation-time order and settle each tie by id.
			await parity(async (db) => {
				const rows = await orgQueries.listOrganizations(db);
				const firstSeen = new Map<string | null, number>();
				rows.forEach((row, index) => {
					if (!firstSeen.has(row.createdAt))
						firstSeen.set(row.createdAt, index);
				});
				return rows.toSorted(
					(a, b) =>
						firstSeen.get(a.createdAt)! - firstSeen.get(b.createdAt)! ||
						(a.id < b.id ? -1 : 1),
				);
			});
			const nullableMember = {
				...member,
				id: `${orgId}-null-member`,
				organizationId: orgId,
				userId: null,
				descopeUserId: `${subject}-null`,
				email: "null@example.test",
				createdAt: null,
			};
			await sqliteDb.insert(sqliteOrganizationMembers).values(nullableMember);
			await pgDb.insert(pgOrganizationMembers).values(nullableMember);
			await parity((db) => memberQueries.getMembersByOrganization(db, orgId));
			for (const translations of [
				{ de: { welcome: "Hello" } },
				[],
				"invalid",
				'{"de":{"welcome":"Stored JSON"}}',
				null,
			]) {
				const metadata = {
					tediWidget: { locale: 42, translations },
				} as unknown as import("../schema/organizations").OrganizationMetadata;
				await sqliteDb
					.update(sqliteOrganizations)
					.set({ metadata })
					.where(eq(sqliteOrganizations.id, orgId));
				await pgDb
					.update(pgOrganizations)
					.set({ metadata })
					.where(eq(pgOrganizations.id, orgId));
				await parity((db) => orgQueries.getOrganizationGuestProfile(db, orgId));
			}
		});

		it("preserves membership scope, filters, invitation lifecycle, permissions and seat authority", async () => {
			await parity((db) => memberQueries.getMemberById(db, memberId));
			await parity((db) =>
				memberQueries.getMemberByIdForOrganization(db, {
					organizationId: orgId,
					memberId,
				}),
			);
			expect(
				await parity((db) =>
					memberQueries.getMemberByIdForOrganization(db, {
						organizationId: "other",
						memberId,
					}),
				),
			).toBeUndefined();
			await parity((db) => memberQueries.getMemberByUserId(db, orgId, subject));
			await parity((db) =>
				memberQueries.getMemberAccessByUserId(db, orgId, subject),
			);
			await parity((db) =>
				memberQueries.getActiveMemberByEmail(
					db,
					orgId,
					` ${orgId.toUpperCase()}@EXAMPLE.TEST `,
				),
			);
			await parity((db) =>
				memberQueries.getMemberByCanonicalUserId(db, orgId, userId),
			);
			await parity((db) =>
				memberQueries.getMembershipsByDescopeTenants(
					db,
					[orgId, orgId, "other"],
					subject,
				),
			);
			await parity((db) =>
				memberQueries.getMembershipsByDescopeTenants(db, [], subject),
			);
			await parity((db) =>
				memberQueries.listMemberRepresentatives(db, orgId, [userId, userId]),
			);
			await parity((db) =>
				memberQueries.listMemberRepresentatives(db, orgId, []),
			);
			await parity((db) =>
				memberQueries.getMembersByOrganization(db, orgId, {
					role: "owner",
					status: "active",
					limit: 1,
				}),
			);
			await parity((db) => memberQueries.getUserOsMemberships(db, subject));
			expect(
				await parity((db) => memberQueries.countActiveOwners(db, orgId)),
			).toBe(1);
			const invited = await parity((db) =>
				memberQueries.inviteMember(
					db,
					orgId,
					"INVITED@EXAMPLE.TEST",
					"viewer",
					undefined,
					userId,
				),
			);
			expect(invited.descopeUserId).toBe(`pending:${invited.id}`);
			const second = await parity((db) =>
				memberQueries.inviteMember(db, orgId, "another@example.test"),
			);
			expect(second.descopeUserId).not.toBe(invited.descopeUserId);
			await parity((db) =>
				memberQueries.inviteMember(db, orgId, "invited@example.test", "member"),
			);
			await parity((db) =>
				memberQueries.acceptInvite(db, invited.id, `${orgId}-accepted`, {
					name: "Accepted",
				}),
			);
			await sameError(
				(db) => memberQueries.inviteMember(db, orgId, "invited@example.test"),
				"already a member",
			);
			await parity((db) =>
				memberQueries.updateMember(db, invited.id, {
					email: "RENAMED@EXAMPLE.TEST",
				}),
			);
			await parity((db) =>
				memberQueries.updateMemberRole(db, invited.id, "viewer"),
			);
			await parity((db) =>
				memberQueries.setMemberPermissions(db, invited.id, ["apps:read"]),
			);
			await parity((db) =>
				memberQueries.setMemberPermissions(db, invited.id, []),
			);
			await parity((db) =>
				memberQueries.setMemberIdentity(db, orgId, invited.id, {
					kind: "human",
				}),
			);
			const seat = await parity((db) =>
				memberQueries.addMember(db, {
					organizationId: orgId,
					descopeUserId: `${orgId}-seat`,
					userId: `${orgId}-seat-user`,
					email: "seat@example.test",
					role: "viewer",
				}),
			);
			expect(
				await parity((db) =>
					memberQueries.setMemberIdentity(db, orgId, seat.id, {
						kind: "browser_agent",
						displayName: "Browser",
						representedUserId: "other",
					}),
				),
			).toBeUndefined();
			await parity((db) =>
				memberQueries.setMemberIdentity(db, orgId, seat.id, {
					kind: "browser_agent",
					displayName: "Browser",
					representedUserId: userId,
				}),
			);
			expect(
				await parity((db) =>
					memberQueries.suspendBrowserAgentSeat(db, {
						organizationId: orgId,
						memberId: seat.id,
						actorUserId: "other",
					}),
				),
			).toBeUndefined();
			await parity((db) =>
				memberQueries.suspendBrowserAgentSeat(db, {
					organizationId: orgId,
					memberId: seat.id,
					actorUserId: userId,
				}),
			);
			await parity((db) => memberQueries.removeMember(db, invited.id));
			expect(
				await parity((db) => memberQueries.getMemberById(db, invited.id)),
			).toBeUndefined();
			await sameError(
				(db) => memberQueries.updateMember(db, "missing", { role: "viewer" }),
				"Member not found",
			);
		});

		it("preserves canonical identity normalization, conflicts, revocation and tenant fallback", async () => {
			const organizationIdentity = {
				provider: " OIDC ",
				issuer: "https://issuer.example.test///",
				subject: orgId,
			};
			const userIdentity = { ...organizationIdentity, subject };
			await parity((db) =>
				identityQueries.resolveUserTenantIdentityContext(db, {
					organizationIdentity,
					userIdentity,
				}),
			);
			await parity((db) =>
				orgQueries.bindOrganizationExternalIdentity(
					db,
					orgId,
					organizationIdentity,
					now,
				),
			);
			await parity((db) =>
				orgQueries.getOrganizationByExternalIdentity(db, organizationIdentity),
			);
			const binding = {
				...userIdentity,
				principalType: "user" as const,
				principalId: userId,
				organizationId: null,
				verifiedAt: now,
			};
			await parity((db) => identityQueries.bindPrincipalIdentity(db, binding));
			await parity((db) =>
				identityQueries.bindPrincipalIdentity(db, {
					...binding,
					metadata: { refreshed: true },
					verifiedAt: later,
				}),
			);
			await parity((db) =>
				identityQueries.resolvePrincipalIdentity(db, userIdentity),
			);
			await parity((db) =>
				identityQueries.resolvePrincipalIdentity(db, userIdentity, {
					organizationId: orgId,
				}),
			);
			await parity((db) =>
				identityQueries.listPrincipalIdentities(db, {
					principalType: "user",
					principalId: userId,
					organizationId: null,
				}),
			);
			await parity((db) =>
				identityQueries.resolveUserTenantIdentityContext(db, {
					organizationIdentity,
					userIdentity,
				}),
			);
			await sameError(
				(db) =>
					identityQueries.bindPrincipalIdentity(db, {
						...binding,
						principalId: "other",
					}),
				"already bound",
			);
			await parity((db) =>
				identityQueries.revokePrincipalIdentity(db, userIdentity, later),
			);
			expect(
				await parity((db) =>
					identityQueries.resolvePrincipalIdentity(db, userIdentity),
				),
			).toBeUndefined();
			await parity((db) =>
				identityQueries.resolvePrincipalIdentity(db, userIdentity, {
					includeRevoked: true,
				}),
			);
			expect(
				await parity((db) =>
					identityQueries.revokePrincipalIdentity(db, userIdentity, later),
				),
			).toBe(false);
			await parity((db) => identityQueries.bindPrincipalIdentity(db, binding));
			await parity((db) =>
				memberQueries.updateMember(db, memberId, { status: "deactivated" }),
			);
			const context = await parity((db) =>
				identityQueries.resolveUserTenantIdentityContext(db, {
					organizationIdentity,
					userIdentity,
				}),
			);
			expect(context?.memberRole).toBeNull();
			expect(context?.memberIsActive).toBe(false);
			await sameError(
				(db) =>
					identityQueries.resolvePrincipalIdentity(db, {
						...userIdentity,
						subject: " ",
					}),
				"required",
			);
		});

		it("keeps session expiry, single-use login and issuer-bound member authority identical", async () => {
			const epoch = Math.floor(new Date(now).getTime() / 1000);
			const record = {
				id: `${orgId}-login`,
				organizationId: orgId,
				kind: "login" as const,
				configDigest: "digest",
				expiresAt: epoch + 30,
				scopes: ["openid"],
			};
			await parity((db) => sessionQueries.insertOidcRecord(db, record));
			expect(
				await parity((db) =>
					sessionQueries.getOidcSession(db, record.id, epoch),
				),
			).toBeUndefined();
			await parity((db) =>
				sessionQueries.consumeOidcLogin(db, record.id, epoch),
			);
			expect(
				await parity((db) =>
					sessionQueries.consumeOidcLogin(db, record.id, epoch),
				),
			).toBeUndefined();
			const session = {
				...record,
				id: `${orgId}-session`,
				kind: "session" as const,
			};
			await parity((db) => sessionQueries.insertOidcRecord(db, session));
			await parity((db) =>
				sessionQueries.getOidcSession(db, session.id, epoch),
			);
			expect(
				await parity((db) =>
					sessionQueries.getOidcSession(db, session.id, epoch + 30),
				),
			).toBeUndefined();
			const durable = { ...session, expiresAt: epoch + 300 };
			await parity((db) => sessionQueries.deleteOidcSession(db, session.id));
			await parity((db) => sessionQueries.insertOidcRecord(db, durable));
			const expired = {
				...session,
				id: `${orgId}-expired`,
				expiresAt: epoch + 1,
			};
			await parity((db) => sessionQueries.insertOidcRecord(db, expired));
			vi.setSystemTime(new Date(new Date(now).getTime() + 2000));
			for (const store of stores)
				await expect(
					sessionQueries.insertOidcRecord(store, durable),
				).rejects.toThrow();
			// A duplicate insert must roll back the pruning in the same transaction.
			expect(
				await parity((db) =>
					sessionQueries.getOidcSession(db, expired.id, epoch),
				),
			).toBeDefined();
			await parity((db) =>
				sessionQueries.insertOidcRecord(db, {
					...durable,
					id: `${orgId}-next`,
				}),
			);
			expect(
				await parity((db) =>
					sessionQueries.getOidcSession(db, expired.id, epoch),
				),
			).toBeUndefined();
			await parity((db) => sessionQueries.getOidcOrganization(db, orgId));
			const identity = {
				provider: "oidc",
				issuer: "https://issuer.example.test",
				subject,
				principalType: "user" as const,
				principalId: userId,
				organizationId: null,
				verifiedAt: now,
			};
			await parity((db) => identityQueries.bindPrincipalIdentity(db, identity));
			await parity((db) =>
				sessionQueries.resolveOidcMember(db, orgId, identity.issuer, subject),
			);
			expect(
				await parity((db) =>
					sessionQueries.resolveOidcMember(
						db,
						"other",
						identity.issuer,
						subject,
					),
				),
			).toBeUndefined();
			expect(
				await parity((db) =>
					sessionQueries.resolveOidcMember(
						db,
						orgId,
						"https://other.example.test",
						subject,
					),
				),
			).toBeUndefined();
			await parity((db) =>
				identityQueries.revokePrincipalIdentity(db, identity, later),
			);
			expect(
				await parity((db) =>
					sessionQueries.resolveOidcMember(db, orgId, identity.issuer, subject),
				),
			).toBeUndefined();
			await parity((db) => sessionQueries.deleteOidcSession(db, session.id));
			expect(
				await parity((db) =>
					sessionQueries.getOidcSession(db, session.id, epoch),
				),
			).toBeUndefined();
		});

		it("provisions the same billing period and feature decisions atomically", async () => {
			vi.setSystemTime(new Date("1900-01-01T00:00:00.000Z"));
			await sameError(
				(db) =>
					orgQueries.createOrganization(
						db,
						{ name: "Missing plan", slug: "missing-plan" },
						{ settlementMode: "managed" },
					),
				"Active billing plan not found",
			);
			vi.setSystemTime(new Date(now));
			const starter = {
				...plan,
				id: "core-starter",
				version: 9999,
				planKey: "starter" as const,
				status: "active" as const,
			};
			await sqliteDb.insert(sqliteBillingPlanVersions).values(starter);
			await pgDb.insert(pgBillingPlanVersions).values(starter);
			for (const settlementMode of [
				"managed",
				"external",
				"disabled",
			] as const) {
				const created = await parity((db) =>
					orgQueries.createOrganization(
						db,
						{ name: "Created", slug: `created-${settlementMode}` },
						{ settlementMode },
					),
				);
				const [sqliteAccount] = await sqliteDb
					.select()
					.from(sqliteBillingAccounts)
					.where(eq(sqliteBillingAccounts.organizationId, created.id));
				const [pgAccount] = await pgDb
					.select()
					.from(pgBillingAccounts)
					.where(eq(pgBillingAccounts.organizationId, created.id));
				expect(pgAccount).toEqual(sqliteAccount);
				await parity((db) =>
					orgQueries.getOrganizationFeatures(db, created.id),
				);
				await parity((db) => orgQueries.canCreateApp(db, created.id));
				await parity((db) =>
					orgQueries.updateOrganization(db, created.id, { appsCount: 100 }),
				);
				expect(
					(await parity((db) => orgQueries.canCreateApp(db, created.id)))
						.allowed,
				).toBe(false);
			}
			expect(
				await parity((db) => orgQueries.getOrganizationFeatures(db, "missing")),
			).toBeNull();
			await parity((db) => orgQueries.canCreateApp(db, "missing"));
			await parity((db) => orgQueries.canCreateApp(db, orgId));
		});
	});
});
