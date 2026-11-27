import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import { coreTable } from "../core-store/client";
import { organizations } from "../schema/organizations";
import { tedis } from "../schema/tedis";
import type {
	NewMcpPaymentAccount,
	NewMcpPaymentEvent,
	NewMcpPaymentPolicy,
	NewMcpPaymentReservation,
} from "../schema/mcp-payments";
import { createD1Facade } from "../test/d1-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import { createPGliteFacade } from "../test/pglite-facade";
import {
	disableMcpPaymentPolicy,
	getEffectiveMcpPaymentPolicy,
	getMcpPaymentSpendSummary,
	insertMcpPaymentEvent,
	insertSettledMcpPaymentEventWithinBudget,
	listMcpPaymentAccounts,
	listMcpPaymentEvents,
	listMcpPaymentPolicies,
	listMcpPaymentReservations,
	sumSettledMcpPaymentAmount,
	updateMcpPaymentReservationStatus,
	upsertMcpPaymentAccount,
	upsertMcpPaymentPolicy,
	upsertMcpPaymentReservation,
} from "./mcp-payments";

const ORG = "org-payments";
const TEDI = "tedi-payments";
const SINCE = "2026-08-01 00:00:00";
const GUARD = { maxAmount: "1.00", since: SINCE };

let seq = 0;
function settledEvent(
	overrides: Partial<NewMcpPaymentEvent> = {},
): NewMcpPaymentEvent {
	seq += 1;
	return {
		id: `evt-${seq}`,
		requirementId: `req-${seq}`,
		eventType: "payment_settled",
		status: "settled",
		protocol: "x402",
		mode: "mock",
		network: "solana-devnet",
		asset: "USDC",
		currency: "USDC",
		amount: "0.40",
		recipient: "recipient-1",
		appSlug: "paymesh-demo",
		organizationId: ORG,
		toolId: "premium_research_brief",
		tediId: TEDI,
		settled: true,
		...overrides,
	} as NewMcpPaymentEvent;
}

for (const store of ["d1", "postgres"] as const) {
	describe(`lane 11b mcp payments core store: ${store}`, () => {
		let db: DbClient;
		let close: () => void | Promise<void>;
		beforeAll(async () => {
			if (store === "d1") {
				const sqlite = createMigratedSqlite();
				db = createDbClient(createD1Facade(sqlite));
				close = () => sqlite.close();
			} else {
				const fixture = await createPGliteFacade();
				db = fixture.db;
				close = fixture.close;
				for (const migration of readMigrationFiles({
					migrationsFolder: fileURLToPath(
						new URL("../../drizzle-pg", import.meta.url),
					),
				})) {
					for (const ddl of migration.sql) await fixture.engine.exec(ddl);
				}
			}
			await db.insert(coreTable(db, organizations)).values({
				id: ORG,
				name: "Payments",
				slug: "payments",
			});
			await db.insert(coreTable(db, tedis)).values({
				id: TEDI,
				organizationId: ORG,
				name: "Tedi",
				slug: "tedi",
			});
		}, 30_000);
		afterAll(async () => {
			await close?.();
		});

		it("enforces the settlement budget inside one statement on both stores", async () => {
			expect(
				await insertSettledMcpPaymentEventWithinBudget(
					db,
					settledEvent(),
					GUARD,
				),
			).toBe(true);
			expect(
				await insertSettledMcpPaymentEventWithinBudget(
					db,
					settledEvent(),
					GUARD,
				),
			).toBe(true);
			expect(
				await insertSettledMcpPaymentEventWithinBudget(
					db,
					settledEvent(),
					GUARD,
				),
			).toBe(false);
			expect(
				await sumSettledMcpPaymentAmount(db, {
					organizationId: ORG,
					appSlug: "paymesh-demo",
					currency: "USDC",
					network: "solana-devnet",
					since: SINCE,
					toolId: "premium_research_brief",
				}),
			).toBeCloseTo(0.8);
			expect(
				await getMcpPaymentSpendSummary(db, {
					organizationId: ORG,
					since: SINCE,
					limit: 10,
				}),
			).toEqual([
				expect.objectContaining({
					appSlug: "paymesh-demo",
					toolId: "premium_research_brief",
					settledCount: 2,
				}),
			]);
			const events = await listMcpPaymentEvents(db, {
				organizationId: ORG,
				limit: 10,
			});
			expect(events).toHaveLength(2);
			expect(events[0]).toMatchObject({ status: "settled", settled: true });
		});

		it("upserts policies, accounts and reservations", async () => {
			const policy: NewMcpPaymentPolicy = {
				id: "policy-1",
				organizationId: ORG,
				tediId: TEDI,
				appSlug: "paymesh-demo",
				toolId: "premium_research_brief",
				currency: "USDC",
				network: "solana-devnet",
				maxAmount: "5.00",
				windowSeconds: 3600,
				mode: "enforce",
				createdBy: "test",
			};
			const savedPolicy = await upsertMcpPaymentPolicy(db, policy);
			expect(savedPolicy).toMatchObject({ id: "policy-1", enabled: true });
			expect(
				await getEffectiveMcpPaymentPolicy(db, {
					organizationId: ORG,
					tediId: TEDI,
					appSlug: "paymesh-demo",
					toolId: "premium_research_brief",
					currency: "USDC",
					network: "solana-devnet",
				}),
			).toMatchObject({ id: "policy-1" });
			expect(
				(
					await listMcpPaymentPolicies(db, {
						organizationId: ORG,
						limit: 10,
					})
				).map((row) => row.id),
			).toEqual(["policy-1"]);

			const account: NewMcpPaymentAccount = {
				id: "account-1",
				organizationId: ORG,
				tediId: TEDI,
				appSlug: "paymesh-demo",
				label: "Ops wallet",
				network: "solana-devnet",
				asset: "USDC",
				publicAddress: "So11111111111111111111111111111111111111112",
				metadata: { note: "test" },
				createdBy: "test",
			};
			expect(await upsertMcpPaymentAccount(db, account)).toMatchObject({
				id: "account-1",
				status: "active",
			});
			expect(
				(
					await listMcpPaymentAccounts(db, {
						organizationId: ORG,
						limit: 10,
					})
				).map((row) => row.id),
			).toEqual(["account-1"]);

			const reservation: NewMcpPaymentReservation = {
				id: "reservation-1",
				requirementId: "req-res-1",
				organizationId: ORG,
				tediId: TEDI,
				appSlug: "paymesh-demo",
				toolId: "premium_research_brief",
				accountId: "account-1",
				policyId: "policy-1",
				network: "solana-devnet",
				asset: "USDC",
				currency: "USDC",
				amount: "0.25",
				recipient: "recipient-1",
				expiresAt: "2027-01-01 00:00:00",
				metadata: { source: "test" },
			};
			expect(await upsertMcpPaymentReservation(db, reservation)).toMatchObject({
				id: "reservation-1",
				status: "reserved",
			});
			expect(
				await updateMcpPaymentReservationStatus(db, {
					requirementId: "req-res-1",
					organizationId: ORG,
					status: "settled",
					settledEventId: "evt-settled",
				}),
			).toMatchObject({ status: "settled", settledEventId: "evt-settled" });
			expect(
				(
					await listMcpPaymentReservations(db, {
						organizationId: ORG,
						limit: 10,
					})
				).map((row) => row.id),
			).toEqual(["reservation-1"]);
			expect(
				await disableMcpPaymentPolicy(db, {
					id: "policy-1",
					organizationId: ORG,
				}),
			).toMatchObject({ enabled: false });
			expect(
				await getEffectiveMcpPaymentPolicy(db, {
					organizationId: ORG,
					tediId: TEDI,
					appSlug: "paymesh-demo",
					toolId: "premium_research_brief",
					currency: "USDC",
					network: "solana-devnet",
				}),
			).toBeNull();
		});

		it("lists plain payment events", async () => {
			await insertMcpPaymentEvent(db, settledEvent({ id: "evt-plain" }));
			const events = await listMcpPaymentEvents(db, {
				organizationId: ORG,
				appSlug: "paymesh-demo",
				limit: 10,
			});
			expect(events.map((row) => row.id)).toContain("evt-plain");
		});
	});
}
