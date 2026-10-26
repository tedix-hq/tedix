import { platformCronCheckpoints } from "../../schema/platform-cron-executions";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import {
	workInteractions,
	workInteractionCardPresentations,
} from "../../schema/work-factory";
import { createD1Facade } from "../../test/d1-facade";
import { canonicalWorkFactoryDdl, schemaDdl } from "../../test/schema-ddl";
import {
	listMissingCardSummaries,
	advanceCardSummaryBackfill,
	saveDecisionCardPresentation,
	listDecisionCardPresentations,
} from "./card-presentation";
const oldCopy = {
	version: 1 as const,
	title: "Review the account test",
	body: "The account test needs approval.",
	recommendation: "Review because permission is pending.",
};
const copy = {
	version: 2 as const,
	title: "Allow a test account?",
	body: "Checks the profile page in a separate browser.",
	recommendation: "The owner needs proof that sign-in works.",
};
function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		`${canonicalWorkFactoryDdl()}\n${schemaDdl(workInteractions, workInteractionCardPresentations)}`,
	);
	sqlite
		.prepare(
			"INSERT INTO organizations(id,name,slug) VALUES ('org','Org','org')",
		)
		.run();
	sqlite
		.prepare(
			"INSERT INTO work_items(id,org_id,title,created_at) VALUES ('work','org','Work','2026-01-01T00:00:00.000Z')",
		)
		.run();
	sqlite
		.prepare(`INSERT INTO work_interactions(id,org_id,work_item_id,kind,subject,prompt,creator_type,creator_id,target_type,target_id,created_at,metadata)
 VALUES ('card','org','work','question','Original title','Original prompt','user','author','user','robin','2026-01-01T00:00:00.000Z',?)`)
		.run(JSON.stringify({ cardPresentation: oldCopy }));
	return { sqlite, db: createDbQueryClient(createD1Facade(sqlite)) };
}
const input = {
	orgId: "org",
	requestId: "card",
	personId: "robin",
	expectedVersion: 1,
	presentation: copy,
};
it("retains all previous texts atomically while returning only current display copy", async () => {
	const { sqlite, db } = fixture();
	try {
		expect(
			(await saveDecisionCardPresentation(db, input))?.presentation,
		).toEqual(copy);
		const second = { ...copy, title: "Allow the profile test?" };
		await saveDecisionCardPresentation(db, { ...input, presentation: second });
		const stored = JSON.parse(
			String(
				sqlite
					.prepare(
						"SELECT presentation FROM work_interaction_card_presentations",
					)
					.get()?.presentation,
			),
		);
		expect(stored.copyHistory).toEqual([oldCopy, copy]);
		expect(stored.title).toBe(second.title);
		const listed = await listDecisionCardPresentations(db, {
			orgId: "org",
			personId: "robin",
			requests: [
				{ id: "card", version: 1, targetType: "user", targetId: "robin" },
			],
		});
		expect(listed[0]?.presentation).toEqual(second);
		expect(
			sqlite
				.prepare("SELECT subject,prompt,status,version FROM work_interactions")
				.get(),
		).toEqual({
			subject: "Original title",
			prompt: "Original prompt",
			status: "open",
			version: 1,
		});
	} finally {
		sqlite.close();
	}
});
it.each([
	{ orgId: "other" },
	{ personId: "other" },
	{ expectedVersion: 2 },
	{ status: "resolved" },
	{ status: "cancelled" },
	{ expiresAt: "2020-01-01T00:00:00.000Z" },
])(
	"rejects a changed, decided, expired or foreign card without touching history: %j",
	async (change) => {
		const { sqlite, db } = fixture();
		try {
			await saveDecisionCardPresentation(db, input);
			const before = sqlite
				.prepare("SELECT presentation FROM work_interaction_card_presentations")
				.get();
			if ("status" in change)
				sqlite
					.prepare("UPDATE work_interactions SET status=?")
					.run(change.status);
			if ("expiresAt" in change)
				sqlite
					.prepare("UPDATE work_interactions SET expires_at=?")
					.run(change.expiresAt);
			const {
				status: _,
				expiresAt: __,
				...scope
			} = change as {
				status?: string;
				expiresAt?: string;
				orgId?: string;
				personId?: string;
				expectedVersion?: number;
			};
			expect(
				await saveDecisionCardPresentation(db, { ...input, ...scope }),
			).toBeNull();
			expect(
				sqlite
					.prepare(
						"SELECT presentation FROM work_interaction_card_presentations",
					)
					.get(),
			).toEqual(before);
		} finally {
			sqlite.close();
		}
	},
);
it("does not expose another recipient's history or stale-version copy", async () => {
	const { sqlite, db } = fixture();
	try {
		await saveDecisionCardPresentation(db, input);
		for (const [personId, version] of [
			["other", 1],
			["robin", 2],
		] as const)
			expect(
				await listDecisionCardPresentations(db, {
					orgId: "org",
					personId,
					requests: [
						{ id: "card", version, targetType: "user", targetId: personId },
					],
				}),
			).toEqual([]);
	} finally {
		sqlite.close();
	}
});

it("backfills in bounded passes, retries gaps and never overwrites a concurrent summary", async () => {
	const { sqlite, db } = fixture();
	sqlite.exec(schemaDdl(platformCronCheckpoints));
	sqlite.exec("UPDATE work_interactions SET metadata='{}'");
	const insert =
		sqlite.prepare(`INSERT INTO work_interactions(id,org_id,work_item_id,kind,subject,prompt,creator_type,creator_id,target_type,target_id,created_at)
 VALUES (?,'org','work','question','Ask','Original prompt','user','author','user','robin','2026-01-01T00:00:00.000Z')`);
	for (let i = 0; i < 7; i++) insert.run(`missing-${i}`);
	const first = await listMissingCardSummaries(db, "2026-10-26T00:00:00.000Z");
	expect(first.rows).toHaveLength(5);
	await saveDecisionCardPresentation(db, input);
	expect(
		await saveDecisionCardPresentation(db, {
			...input,
			onlyMissing: true,
			presentation: { ...copy, title: "Overwrite?" },
		}),
	).toBeNull();
	const stored = sqlite
		.prepare("SELECT presentation FROM work_interaction_card_presentations")
		.get();
	expect(JSON.parse(String(stored?.presentation)).title).toBe(copy.title);
	const last = first.rows.at(-1)!;
	await advanceCardSummaryBackfill(
		db,
		first.previous,
		`${last.orgId}:${last.id}`,
	);
	const second = await listMissingCardSummaries(db, "2026-10-26T00:00:00.000Z");
	expect(second.rows).toHaveLength(3);
	await advanceCardSummaryBackfill(db, second.previous, "org:zzzz");
	expect(
		(await listMissingCardSummaries(db, "2026-10-26T00:00:00.000Z")).rows,
	).toEqual([]);
	await advanceCardSummaryBackfill(db, "org:zzzz", "");
	expect(
		(await listMissingCardSummaries(db, "2026-10-26T00:00:00.000Z")).rows,
	).toHaveLength(5);
	sqlite.close();
});
