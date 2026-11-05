/// <reference types="node" />
import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { getMembersByOrganization as getSqliteMembers } from "../queries/organization-members";
import {
	getOrganizationBySlug as getSqliteOrganization,
	getOrganizationGuestProfile as getSqliteGuestProfile,
	listOrganizations as listSqliteOrganizations,
} from "../queries/organizations";
import { resolvePrincipalIdentity as resolveSqlitePrincipal } from "../queries/principal-identities";
import { listBillingUsageReservations as listSqliteReservations } from "../queries/billing/reservations";
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
import { listBillingUsageReservations as listPgReservations } from "./queries/billing-reservations";
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
import * as pgSchema from "./schema";
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
			locale: "de",
			translations: { de: { welcome: "Hallo" } },
		},
	},
	createdAt: now,
	updatedAt: now,
} as const;

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
} as const;

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
} as const;

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
} as const;

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

describe("SQLite and Postgres core query parity", () => {
	const sqlite = createMigratedSqlite();
	// This test compares read semantics; admission fencing has its own production-chain tests.
	sqlite.exec("DROP TRIGGER work_attempt_admission_insert_guard");
	const sqliteDb = createDbClient(createD1Facade(sqlite));
	const pg = new PGlite();
	const pgDb = drizzlePglite({ client: pg, schema: pgSchema });

	beforeAll(async () => {
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
			for (const statement of migration.split("--> statement-breakpoint")) {
				if (statement.trim()) await pg.exec(statement);
			}
		}

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

	afterAll(async () => {
		await pg.close();
	});

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

		const [sqliteReservations, pgReservations] = await Promise.all([
			listSqliteReservations(sqliteDb, {
				organizationId: organization.id,
				status: "reserved",
				monetaryCurrency: "EUR",
			}),
			listPgReservations(pgDb, {
				organizationId: organization.id,
				status: "reserved",
				monetaryCurrency: "EUR",
			}),
		]);
		expect(pgReservations).toEqual(sqliteReservations);

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
		expect(pgItems).toEqual(sqliteItems);

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
});
