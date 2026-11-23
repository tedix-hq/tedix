import { env } from "cloudflare:workers";
import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { decisionEdges } from "../schema/decision-graph";
import { organizations } from "../schema/organizations";
import { workItems } from "../schema/work-items";
import { tableDdl } from "../test/schema-ddl";
import { getDeckDecisionContexts, upsertDecisionEdges } from "./decision-graph";

it("qualifies a full deck within D1's compound SELECT limit", async () => {
	const d1 = (env as unknown as { DB: D1Database }).DB;
	for (const table of [organizations, workItems, decisionEdges]) {
		for (const statement of tableDdl(table)) {
			await d1.prepare(statement).run();
		}
	}
	const orgId = "fictional-lighthouse";
	await d1
		.prepare("INSERT INTO organizations(id,name,slug) VALUES(?,?,?)")
		.bind(orgId, "Lighthouse", "lighthouse")
		.run();
	const db = createDbQueryClient(d1);
	const cards = Array.from({ length: 86 }, (_, i) => ({ id: `ask-${i}` }));
	await upsertDecisionEdges(
		db,
		orgId,
		cards.map((card) => ({
			kind: "card_answers",
			from: { kind: "deck_card", id: card.id },
			to: { kind: "decision", id: `answer-${card.id}` },
			source: "deck",
		})),
	);
	const contexts = await getDeckDecisionContexts(db, orgId, cards);
	expect(contexts.size).toBe(cards.length);
	for (const card of cards) {
		expect(contexts.get(card.id)?.priorDecision?.node.id).toBe(
			`answer-${card.id}`,
		);
	}
});
