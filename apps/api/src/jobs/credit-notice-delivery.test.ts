import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { createMigratedSqlite } from "@tedix/db/test/migrated-sqlite";
import { describe, expect, it, vi } from "vite-plus/test";
import {
	creditNoticeEmail,
	deliverCreditNotices,
} from "./credit-notice-delivery";

const NOW = Date.parse("2026-11-19T12:00:00.000Z");
const FX = JSON.stringify({
	microUsdPerEur: 1_000_000,
	source: "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml",
	asOf: "2026-11-01",
});

function seed() {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	sqlite.exec(`
		INSERT INTO organizations(id,name,slug) VALUES('org','Willowbrook','willowbrook');
		INSERT INTO organization_members(id,organization_id,descope_user_id,user_id,email,role,status,kind) VALUES
			('m1','org','d-owner','u-owner','owner@example.com','owner','active','human'),
			('m2','org','d-admin','u-admin','admin@example.com','admin','active','human'),
			('m3','org','d-pat','u-pat','pat@example.com','member','active','human');
		INSERT INTO projects(id,org_id,key,name,created_at) VALUES('p-old','org','OLD','Oldest','2026-01-01T00:00:00.000Z');
		INSERT INTO billing_credit_notices(organization_id,period_start,threshold,reached_at)
			VALUES('org','2026-11-01T00:00:00.000Z',80,'2026-11-19T11:00:00.000Z');
	`);
	sqlite
		.prepare(
			`INSERT INTO billing_plan_versions (
				id, plan_key, version, status, name, currency, monthly_price_micros,
				annual_price_micros, max_tedis, max_cron_jobs_per_tedi,
				max_iterations_per_task, allow_overage, included_monthly_credits,
				credit_fx, metadata, effective_at, created_at
			) VALUES ('test-plan','growth',99,'active','Growth','eur',
				200000000,2000000000,1,10,16,1,100,?,'{}','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
		)
		.run(FX);
	sqlite.exec(`
		INSERT INTO billing_accounts (
			organization_id, plan_version_id, status, billing_mode, overage_enabled,
			period_start, period_end, created_at, updated_at
		) VALUES ('org','test-plan','active','stripe',0,
			'2026-11-01T00:00:00.000Z','2026-12-01T00:00:00.000Z',
			'2026-11-01T00:00:00.000Z','2026-11-01T00:00:00.000Z');
	`);
	const sent: Array<{ to: unknown; subject: string; text: string }> = [];
	let failFor: string | null = null;
	const EMAIL = {
		send: vi.fn(
			async (message: { to: string[]; subject: string; text: string }) => {
				if (failFor && message.to.includes(failFor))
					throw new Error("mail service unavailable");
				sent.push({
					to: message.to,
					subject: message.subject,
					text: message.text,
				});
				return { messageId: `msg-${sent.length}` };
			},
		),
	} as unknown as SendEmail;
	return {
		sqlite,
		db: createDbClient(createD1Facade(sqlite)),
		env: { EMAIL, OS_URL: "https://os.example.test" },
		sent,
		failEmailTo: (email: string | null) => {
			failFor = email;
		},
		cards: () =>
			sqlite
				.prepare(
					"SELECT target_id FROM work_interactions WHERE json_extract(metadata,'$.schema')='tedix.credit-notice.v1' ORDER BY target_id",
				)
				.all() as Array<{ target_id: string }>,
	};
}

describe("credit notice delivery", () => {
	it("tells each admin once by Deck card and email, never the members", async () => {
		const { db, env, sent, cards } = seed();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(await deliverCreditNotices(env, db, NOW)).toMatchObject({
				planned: 1,
				queued: 4,
				claimed: 4,
				sent: 4,
				failed: 0,
			});
			expect(cards().map((row) => row.target_id)).toEqual([
				"u-admin",
				"u-owner",
			]);
			expect(sent.map((mail) => mail.to).sort()).toEqual([
				["admin@example.com"],
				["owner@example.com"],
			]);
			expect(sent[0]).toMatchObject({
				subject: "Willowbrook has used 80% of this month's credits",
				text: "Willowbrook has used 80% of this month's credits. At 100%, tedis and code runs pause until the month resets. Buy a credit pack or turn on pay-as-you-go to keep working.\n\nOpen Settings › Billing › Usage: https://os.example.test/admin/billing",
			});

			// Later ticks in the same period send nothing again.
			for (const later of [NOW + 15 * 60_000, NOW + 24 * 3_600_000])
				expect(await deliverCreditNotices(env, db, later)).toMatchObject({
					planned: 0,
					claimed: 0,
					sent: 0,
				});
			expect(sent).toHaveLength(2);
			expect(cards()).toHaveLength(2);
		} finally {
			warn.mockRestore();
		}
	});

	it("retries only the failed email, after its wait", async () => {
		const { db, env, sent, failEmailTo, sqlite } = seed();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			failEmailTo("admin@example.com");
			expect(await deliverCreditNotices(env, db, NOW)).toMatchObject({
				sent: 3,
				failed: 1,
			});
			expect(sent.map((mail) => mail.to)).toEqual([["owner@example.com"]]);

			failEmailTo(null);
			// Too soon: the failed row waits for its backoff.
			expect(await deliverCreditNotices(env, db, NOW + 30_000)).toMatchObject({
				claimed: 0,
			});
			expect(
				await deliverCreditNotices(env, db, NOW + 10 * 60_000),
			).toMatchObject({ claimed: 1, sent: 1 });
			expect(sent.map((mail) => mail.to)).toEqual([
				["owner@example.com"],
				["admin@example.com"],
			]);
			expect(
				sqlite
					.prepare(
						"SELECT status, attempt_count, delivery_ref FROM billing_credit_notice_deliveries WHERE channel='email' AND recipient_user_id='u-admin'",
					)
					.get(),
			).toEqual({ status: "sent", attempt_count: 1, delivery_ref: "msg-2" });
		} finally {
			warn.mockRestore();
		}
	});

	it("keeps an email queued when the email binding is missing", async () => {
		const { db, sqlite } = seed();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(await deliverCreditNotices({}, db, NOW)).toMatchObject({
				sent: 2,
				failed: 2,
			});
			expect(
				sqlite
					.prepare(
						"SELECT DISTINCT status FROM billing_credit_notice_deliveries WHERE channel='email'",
					)
					.all(),
			).toEqual([{ status: "failed" }]);
		} finally {
			warn.mockRestore();
		}
	});

	it("leads the 100% email with the percentage", () => {
		const email = creditNoticeEmail(
			{ threshold: 100, organizationName: "Willowbrook" },
			undefined,
		);
		expect(email.subject).toBe(
			"Willowbrook has used 100% of this month's credits",
		);
		expect(email.text).toContain("https://os.tedix.dev/admin/billing");
	});
});
