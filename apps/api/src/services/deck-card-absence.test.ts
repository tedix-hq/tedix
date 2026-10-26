import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { createMigratedSqlite } from "@tedix/db/test/migrated-sqlite";
import { expect, it } from "vite-plus/test";
import type { BaseContext } from "../rpc/orpc";
import { explainDeckCardAbsence } from "./deck-card-absence";

const org = "11111111-1111-4111-8111-111111111111";
const agent = "33333333-3333-4333-8333-333333333333";
const work = "66666666-6666-4666-8666-666666666666";
const card = "44444444-4444-4444-8444-444444444444";
const GENERIC = "Card is not in your current Decisions";

function fixture(
	metadata: Record<string, unknown> = {},
	overrides: Record<string, unknown> = {},
) {
	const sqlite = createMigratedSqlite();
	sqlite.exec(
		`INSERT INTO organizations(id,name,slug) VALUES('${org}','Fictional','fictional'); INSERT INTO users(id,email) VALUES('person','person@example.test'),('other','other@example.test'); INSERT INTO organization_members(id,organization_id,descope_user_id,user_id,email,status,role) VALUES('member','${org}','person-sub','person','person@example.test','active','owner'),('other-member','${org}','other-sub','other','other@example.test','active','member'); INSERT INTO tedis(id,organization_id,name,slug,status) VALUES('${agent}','${org}','Draft author','draft-author','active'); INSERT INTO work_items(id,org_id,title,work_class,purpose_exception_expires_at,admission_spec_revision,created_at) VALUES('${work}','${org}','Draft','hygiene','2027-01-01T00:00:00.000Z','fixture','2026-10-19T00:00:00.000Z');`,
	);
	const row: Record<string, unknown> = {
		id: card,
		org_id: org,
		work_item_id: work,
		kind: "question",
		subject: "Which supplier?",
		prompt: "Choose Cedar or Pine.",
		creator_type: "tedi",
		creator_id: agent,
		target_type: "user",
		target_id: "person",
		status: "open",
		created_at: "2026-10-19T00:00:00.000Z",
		version: 1,
		metadata: JSON.stringify(metadata),
		...overrides,
	};
	const columns = Object.keys(row);
	sqlite
		.prepare(
			`INSERT INTO work_interactions(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
		)
		.run(...columns.map((column) => row[column] as string));
	const context = {
		db: createDbClient(createD1Facade(sqlite)),
		env: {},
		headers: new Headers(),
		organizationId: org,
		url: new URL("https://api.example.test/rpc"),
		authType: "user",
		userId: "person",
		userRole: "owner",
		user: { sub: "person-sub" },
	} as BaseContext;
	return { context, sqlite };
}

it("keeps the generic answer for absent and other-recipient cards", async () => {
	const { context } = fixture();
	expect(await explainDeckCardAbsence(context, crypto.randomUUID())).toBe(
		GENERIC,
	);
	// A question asked of the person stays on their Deck; only an FYI routes away.
	expect(await explainDeckCardAbsence(context, card)).toBe(GENERIC);
	const { context: fyi } = fixture({}, { kind: "coordination" });
	expect(await explainDeckCardAbsence(fyi, card)).toBe(
		"It routes to your Activity, not your Decisions (routine)",
	);
	const { context: otherContext } = fixture({}, { target_id: "other" });
	expect(await explainDeckCardAbsence(otherContext, card)).toBe(GENERIC);
});

it("names the routine Feed route for a valid taste envelope in a feed class", async () => {
	const { context } = fixture(
		{
			decisionDeck: {
				version: 1,
				kind: "decision",
				classId: "ops.demo",
				proposal: "Pick a graph index",
				whyNow: "Demo ready",
				recommendation: "Use the smaller index",
				reversibility: "two_way",
				tasteOrStrategy: true,
				protectedEffects: [],
				blastRadius: "Demo index only",
				confidence: 0.8,
				costOfWaiting: "Demo waits",
				reasoning: "Fits the demo",
				options: [
					{
						id: "approve",
						label: "Use it",
						intent: "approve",
						consequence: "Index selected",
						cost: "One note",
					},
					{
						id: "later",
						label: "Later",
						intent: "later",
						consequence: "No change",
						cost: "Wait",
					},
				],
			},
		},
		{ kind: "coordination" },
	);
	expect(await explainDeckCardAbsence(context, card)).toBe(
		"It routes to your Activity, not your Decisions (routine)",
	);
});

it("says the decision envelope failed validation when it cannot parse", async () => {
	const { context } = fixture(
		{ decisionDeck: { version: 1, kind: "decision" } },
		{ kind: "coordination" },
	);
	expect(await explainDeckCardAbsence(context, card)).toBe(
		"Its decision envelope failed validation, so it routes to your Activity (routine)",
	);
});

it("falls back to the generic answer when no filter keeps the card out", async () => {
	const { context } = fixture({
		decisionDeck: {
			version: 1,
			kind: "decision",
			classId: "customer.preference",
			proposal: "Pick a supplier",
			whyNow: "Order ready",
			recommendation: "Choose Cedar",
			reversibility: "two_way",
			tasteOrStrategy: true,
			protectedEffects: [],
			blastRadius: "Stored preference only",
			confidence: 0.9,
			costOfWaiting: "Order waits",
			reasoning: "Matches taste",
			options: [
				{
					id: "approve",
					label: "Cedar",
					intent: "approve",
					consequence: "Preference recorded",
					cost: "One note",
				},
				{
					id: "later",
					label: "Later",
					intent: "later",
					consequence: "No change",
					cost: "Wait",
				},
			],
		},
	});
	expect(await explainDeckCardAbsence(context, card)).toBe(GENERIC);
});

it("names the lifecycle close state", async () => {
	const { context: expired } = fixture(
		{},
		{ expires_at: "2000-01-01T00:00:00.000Z" },
	);
	expect(await explainDeckCardAbsence(expired, card)).toContain(
		"already closed (expired)",
	);
});

it("names digest, snooze and schedule filters", async () => {
	const bundled = fixture({
		notification: { state: "bundled" },
	});
	expect(await explainDeckCardAbsence(bundled.context, card)).toBe(
		"Its notification is held for your next digest",
	);
	const snoozed = fixture({
		followThrough: { snoozedUntil: "2999-01-01T00:00:00.000Z" },
	});
	expect(await explainDeckCardAbsence(snoozed.context, card)).toBe(
		"You snoozed it until 2999-01-01T00:00:00.000Z",
	);
	const scheduled = fixture({ showFrom: "2999-01-01" });
	expect(await explainDeckCardAbsence(scheduled.context, card)).toBe(
		"It is scheduled to appear later",
	);
});

it("names the informational triage verdict for captured turns", async () => {
	const { context, sqlite } = fixture({
		schema: "tedix.decision-capture.v1",
	});
	sqlite.exec(
		`INSERT INTO work_interaction_attention(org_id,interaction_id,kind,need,decided_at) VALUES('${org}','${card}','fyi',NULL,'2026-10-19T00:00:00.000Z')`,
	);
	expect(await explainDeckCardAbsence(context, card)).toBe(
		"It was triaged as an update, not an ask",
	);
});
