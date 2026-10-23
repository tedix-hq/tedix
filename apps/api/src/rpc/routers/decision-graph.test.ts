import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { upsertDecisionEdges } from "@tedix/db/queries/decision-graph";
import { decisionEdges } from "@tedix/db/schema/decision-graph";
import { organizations } from "@tedix/db/schema/organizations";
import { projects } from "@tedix/db/schema/projects";
import { tediObjectives } from "@tedix/db/schema/tedi-objectives";
import { workItems } from "@tedix/db/schema/work-items";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { decisionGraphContractRouter } from "./decision-graph";

const ORG = "10000000-0000-4000-8000-000000000001";
const OTHER_ORG = "10000000-0000-4000-8000-000000000002";

async function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		schemaDdl(
			organizations,
			decisionEdges,
			projects,
			tediObjectives,
			workItems,
		),
	);
	sqlite
		.prepare("INSERT INTO organizations(id,name,slug) VALUES(?,?,?),(?,?,?)")
		.run(ORG, "Fictional Harbor", "harbor", OTHER_ORG, "Lighthouse", "light");
	const db = createDbClient(createD1Facade(sqlite));
	await upsertDecisionEdges(db, ORG, [
		{
			kind: "card_from_work",
			from: { kind: "deck_card", id: "card-github" },
			to: { kind: "work_item", id: "work-github-audit" },
			source: "deck",
			note: "Audit GitHub access",
		},
		{
			kind: "decided_by",
			from: { kind: "work_item", id: "work-github-audit" },
			to: { kind: "owner_instruction", id: "instruction-rotate" },
			source: "work_comment",
			note: "rotate leftover credentials",
			occurredAt: "2026-10-20T15:30:00Z",
		},
	]);
	const client = (org = ORG, role = "member") =>
		createRouterClient(decisionGraphContractRouter, {
			context: {
				db,
				organizationId: org,
				authType: "user",
				user: { sub: "river" },
				userRole: role,
				headers: new Headers(),
				url: new URL("https://api.example.test/rpc"),
				env: {},
			} as BaseContext,
		});
	return { sqlite, client };
}

describe("decisionGraph.getContext", () => {
	it("lets a member read the card's chain as one plain-English line", async () => {
		const f = await fixture();
		try {
			const result = await f.client().getContext({ cardId: "card-github" });
			expect(result.explanation).toBe(
				'You decided this on 20 Oct: "rotate leftover credentials" → from Work "Audit GitHub access"',
			);
			expect(result.context.priorDecision?.node.id).toBe("instruction-rotate");
		} finally {
			f.sqlite.close();
		}
	});

	it("never returns another organization's edges and rejects unbounded hops", async () => {
		const f = await fixture();
		try {
			const foreign = await f
				.client(OTHER_ORG)
				.getContext({ cardId: "card-github" });
			expect(foreign.context.chain).toEqual([]);
			expect(foreign.explanation).toBe(
				"No earlier decision or linked Work found.",
			);
			await expect(
				f.client().getContext({ cardId: "card-github", maxHops: 5 }),
			).rejects.toThrow();
		} finally {
			f.sqlite.close();
		}
	});
});
