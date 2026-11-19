import { interactionDeckRoute } from "@tedix/api-contract/utils/deck-projection";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import { createD1Facade } from "../../test/d1-facade";
import { createMigratedSqlite } from "../../test/migrated-sqlite";
import {
	CREDIT_NOTICE_CARD_SCHEMA,
	claimCreditNoticeDeliveries,
	deliverCreditNoticeDeckCard,
	markCreditNoticeDeliveryFailed,
	markCreditNoticeDeliverySent,
	planCreditNoticeDeliveries,
} from "./credit-notice-deliveries";

const PERIOD_START = "2026-11-01T00:00:00.000Z";
const PERIOD_END = "2026-12-01T00:00:00.000Z";
const NOW = "2026-11-19T12:00:00.000Z";
const LATER = "2026-11-19T12:30:00.000Z";
const FX = JSON.stringify({
	microUsdPerEur: 1_000_000,
	source: "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml",
	asOf: "2026-11-01",
});

interface CardRow {
	id: string;
	target_id: string;
	project_id: string;
	subject: string;
	prompt: string;
	expires_at: string;
	metadata: string;
}

function seed() {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	sqlite.exec(`
		INSERT INTO organizations(id,name,slug) VALUES('org','Willowbrook','willowbrook');
		INSERT INTO organizations(id,name,slug) VALUES('other','Other','other');
		INSERT INTO organization_members(id,organization_id,descope_user_id,user_id,email,role,status,kind) VALUES
			('m1','org','d-owner','u-owner','owner@example.com','owner','active','human'),
			('m2','org','d-admin','u-admin','admin@example.com','admin','active','human'),
			('m3','org','d-pat','u-pat','pat@example.com','member','active','human'),
			('m4','org','d-gone','u-gone','gone@example.com','admin','suspended','human'),
			('m5','org','d-agent','u-agent','agent@example.com','admin','active','external_agent'),
			('m6','other','d-x','u-x','x@example.com','owner','active','human');
		INSERT INTO projects(id,org_id,key,name,created_at) VALUES('p-old','org','OLD','Oldest','2026-01-01T00:00:00.000Z');
		INSERT INTO projects(id,org_id,key,name,created_at) VALUES('p-new','org','NEW','Newer','2026-06-01T00:00:00.000Z');
	`);
	sqlite
		.prepare(
			`INSERT INTO billing_plan_versions (
				id, plan_key, version, status, name, currency, monthly_price_micros,
				annual_price_micros, max_tedis, max_cron_jobs_per_tedi,
				max_iterations_per_task, allow_overage, included_monthly_credits,
				credit_fx, metadata, effective_at, created_at
			) VALUES ('test-plan','growth',99,'active','Growth','eur',
				200000000,2000000000,1,10,16,1,100,?,'{}','2026-01-01T00:00:00.000Z',?)`,
		)
		.run(FX, NOW);
	for (const org of ["org", "other"])
		sqlite
			.prepare(
				`INSERT INTO billing_accounts (
					organization_id, plan_version_id, status, billing_mode,
					overage_enabled, period_start, period_end, created_at, updated_at
				) VALUES (?,'test-plan','active','stripe',0,?,?,?,?)`,
			)
			.run(org, PERIOD_START, PERIOD_END, NOW, NOW);
	const notice = (threshold: number, periodStart = PERIOD_START) =>
		sqlite
			.prepare(
				"INSERT INTO billing_credit_notices(organization_id,period_start,threshold,reached_at) VALUES('org',?,?,?)",
			)
			.run(periodStart, threshold, NOW);
	return {
		sqlite,
		db: createDbClient(createD1Facade(sqlite)),
		notice,
		deliveries: () =>
			sqlite
				.prepare(
					"SELECT id,channel,recipient_user_id,recipient_email,status,attempt_count FROM billing_credit_notice_deliveries ORDER BY id",
				)
				.all() as Array<Record<string, string | number>>,
		cards: () =>
			sqlite
				.prepare(
					"SELECT id,target_id,project_id,subject,prompt,expires_at,metadata FROM work_interactions WHERE json_extract(metadata,'$.schema')=?",
				)
				.all(CREDIT_NOTICE_CARD_SCHEMA) as unknown as CardRow[],
	};
}

const lease = (now: string) => ({
	now,
	leaseExpiresAt: new Date(Date.parse(now) + 5 * 60_000).toISOString(),
	limit: 100,
});

describe("credit notice deliveries", () => {
	it("queues one Deck card and one email per active owner and admin, once", async () => {
		const { db, notice, deliveries, sqlite } = seed();
		notice(80);
		expect(await planCreditNoticeDeliveries(db, { now: NOW })).toEqual({
			notices: 1,
			queued: 4,
			stale: 0,
		});
		expect(
			deliveries().map((row) => [row.channel, row.recipient_user_id]),
		).toEqual([
			["deck", "u-admin"],
			["deck", "u-owner"],
			["email", "u-admin"],
			["email", "u-owner"],
		]);
		expect(
			sqlite
				.prepare(
					"SELECT deliveries_planned_at FROM billing_credit_notices WHERE threshold=80",
				)
				.get(),
		).toEqual({ deliveries_planned_at: NOW });

		// Planning again, or a new admin later, adds nothing for this notice.
		sqlite.exec(
			"INSERT INTO organization_members(id,organization_id,descope_user_id,user_id,email,role,status,kind) VALUES('m7','org','d-new','u-new','new@example.com','admin','active','human')",
		);
		expect(await planCreditNoticeDeliveries(db, { now: LATER })).toEqual({
			notices: 0,
			queued: 0,
			stale: 0,
		});
		expect(deliveries()).toHaveLength(4);

		// The 100% notice in the same period is its own delivery.
		notice(100);
		expect((await planCreditNoticeDeliveries(db, { now: LATER })).queued).toBe(
			6,
		);
		expect(deliveries()).toHaveLength(10);
	});

	it("puts one Deck card per admin, and a retried card is not repeated", async () => {
		const { db, notice, cards } = seed();
		notice(100);
		await planCreditNoticeDeliveries(db, { now: NOW });
		const { claimed } = await claimCreditNoticeDeliveries(db, lease(NOW));
		const deck = claimed.filter((row) => row.channel === "deck");
		expect(deck).toHaveLength(2);
		expect(deck[0]).toMatchObject({
			threshold: 100,
			organizationName: "Willowbrook",
			periodEnd: PERIOD_END,
		});

		const first = await deliverCreditNoticeDeckCard(db, {
			delivery: deck[0]!,
			now: NOW,
		});
		// A worker that lost its "sent" mark retries the same row.
		const again = await deliverCreditNoticeDeckCard(db, {
			delivery: deck[0]!,
			now: LATER,
		});
		expect(again).toBe(first);
		await deliverCreditNoticeDeckCard(db, { delivery: deck[1]!, now: NOW });

		const rows = cards();
		expect(rows.map((row) => row.target_id).sort()).toEqual([
			"u-admin",
			"u-owner",
		]);
		const card = rows[0]!;
		expect(card).toMatchObject({
			project_id: "p-old",
			subject: "Willowbrook has used 100% of this month's credits",
			expires_at: PERIOD_END,
		});
		expect(card.prompt).toContain(
			"[Settings › Billing › Usage](/admin/billing)",
		);
		const metadata = JSON.parse(card.metadata) as Record<string, unknown>;
		const route = interactionDeckRoute(
			{
				kind: "question",
				subject: card.subject,
				prompt: card.prompt,
				dueAt: null,
				targetType: "user",
				metadata,
			},
			undefined,
			undefined,
			new Date(NOW),
		);
		expect(route.route.destination).toBe("deck");
		expect(route.kind).toBe("decision");
	});

	it("never claims a sent row again and retries a failed one after its wait", async () => {
		const { db, notice, deliveries } = seed();
		notice(80);
		await planCreditNoticeDeliveries(db, { now: NOW });
		const { claimed } = await claimCreditNoticeDeliveries(db, lease(NOW));
		expect(claimed).toHaveLength(4);
		// A held lease keeps a parallel worker away.
		expect(
			(await claimCreditNoticeDeliveries(db, lease(NOW))).claimed,
		).toHaveLength(0);

		const [failedRow, ...rest] = claimed;
		for (const row of rest)
			await markCreditNoticeDeliverySent(db, {
				id: row.id,
				deliveryRef: "ref",
				now: NOW,
			});
		await markCreditNoticeDeliveryFailed(db, {
			id: failedRow!.id,
			error: "smtp unavailable",
			nextAttemptAt: LATER,
			now: NOW,
		});
		expect(
			(await claimCreditNoticeDeliveries(db, lease(NOW))).claimed,
		).toHaveLength(0);
		const retry = await claimCreditNoticeDeliveries(db, lease(LATER));
		expect(retry.claimed.map((row) => row.id)).toEqual([failedRow!.id]);
		expect(deliveries().filter((row) => row.status === "sent")).toHaveLength(3);
	});

	it("reclaims a row whose lease lapsed", async () => {
		const { db, notice } = seed();
		notice(80);
		await planCreditNoticeDeliveries(db, { now: NOW });
		await claimCreditNoticeDeliveries(db, lease(NOW));
		const lapsed = new Date(Date.parse(NOW) + 6 * 60_000).toISOString();
		expect(
			(await claimCreditNoticeDeliveries(db, lease(lapsed))).claimed,
		).toHaveLength(4);
	});

	it("dead-letters after the attempt ceiling", async () => {
		const { db, notice, deliveries } = seed();
		notice(80);
		await planCreditNoticeDeliveries(db, { now: NOW });
		const { claimed } = await claimCreditNoticeDeliveries(db, lease(NOW));
		await markCreditNoticeDeliveryFailed(db, {
			id: claimed[0]!.id,
			error: "no",
			nextAttemptAt: NOW,
			now: NOW,
			maxAttempts: 1,
		});
		expect(deliveries().find((row) => row.id === claimed[0]!.id)).toMatchObject(
			{ status: "dead", attempt_count: 1 },
		);
	});

	it("sends nothing for a notice from an ended period", async () => {
		const { db, notice, deliveries, sqlite } = seed();
		notice(80, "2026-10-01T00:00:00.000Z");
		expect(await planCreditNoticeDeliveries(db, { now: NOW })).toEqual({
			notices: 1,
			queued: 0,
			stale: 1,
		});
		expect(deliveries()).toHaveLength(0);

		// Rows queued this period expire once the month resets.
		notice(100);
		await planCreditNoticeDeliveries(db, { now: NOW });
		sqlite
			.prepare(
				"UPDATE billing_accounts SET period_start=?, period_end=? WHERE organization_id='org'",
			)
			.run(PERIOD_END, "2027-01-01T00:00:00.000Z");
		const result = await claimCreditNoticeDeliveries(
			db,
			lease("2026-12-01T00:05:00.000Z"),
		);
		expect(result).toEqual({ claimed: [], expired: 4 });
		expect(new Set(deliveries().map((row) => row.status))).toEqual(
			new Set(["expired"]),
		);
	});
});
