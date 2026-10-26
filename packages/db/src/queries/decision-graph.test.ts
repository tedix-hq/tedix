import { DatabaseSync } from "node:sqlite";
import { DecisionContextSchema } from "@tedix/api-contract/schemas/decision-graph";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { decisionEdges } from "../schema/decision-graph";
import { organizations } from "../schema/organizations";
import { workItems } from "../schema/work-items";
import { projects } from "../schema/projects";
import { tediObjectives } from "../schema/tedi-objectives";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	countBlocked,
	type DecisionEdgeInput,
	DecisionEdgeValidationError,
	explainChain,
	findDuplicateCards,
	findPriorDecision,
	getDecisionContext,
	terminalWorkItemIds,
	upsertDecisionEdges,
} from "./decision-graph";

const ORG = "fictional-lighthouse";
const OTHER_ORG = "fictional-harbor";

function fixture() {
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
		.run(ORG, "Lighthouse", "lighthouse", OTHER_ORG, "Harbor", "harbor");
	sqlite.exec(`
		INSERT INTO work_items(id,org_id,title,disposition,created_at) VALUES
			('work-github-audit','${ORG}','Audit access','accepted','2026-10-21T08:00:00.000Z'),
			('work-release-train','${ORG}','Release train','accepted','2026-10-21T08:00:00.000Z'),
			('work-ci-runners','${ORG}','CI runners','accepted','2026-10-21T08:00:00.000Z')
	`);
	const db = createDbQueryClient(createD1Facade(sqlite));
	const count = () =>
		Number(
			(
				sqlite.prepare("SELECT count(*) AS n FROM decision_edges").get() as {
					n: number;
				}
			).n,
		);
	return { sqlite, db, count };
}

const card = (id: string) => ({ kind: "deck_card" as const, id });
const work = (id: string) => ({ kind: "work_item" as const, id });

/** The GitHub-access card: Work → owner instruction, GitHub, two blocked items. */
const githubCardEdges: DecisionEdgeInput[] = [
	{
		kind: "card_from_work",
		from: card("card-github"),
		to: work("work-github-audit"),
		source: "deck",
		note: "Audit GitHub access",
		occurredAt: "2026-10-21T08:00:00.000Z",
	},
	{
		kind: "decided_by",
		from: work("work-github-audit"),
		to: { kind: "owner_instruction", id: "instruction-rotate" },
		source: "work_comment",
		evidenceRef: "work-comment:comment-rotate",
		note: "rotate leftover credentials",
		occurredAt: "2026-10-20T15:30:00.000Z",
	},
	{
		kind: "involves",
		from: card("card-github"),
		to: { kind: "system", id: "system-github" },
		source: "deck",
		note: "GitHub",
	},
	{
		kind: "involves",
		from: work("work-github-audit"),
		to: { kind: "credential", id: "credential-deploy-key" },
		source: "deck",
		note: "old deploy key",
		confidence: 0.8,
	},
	{
		kind: "blocks",
		from: work("work-github-audit"),
		to: work("work-release-train"),
		source: "work_link",
	},
	{
		kind: "blocks",
		from: work("work-github-audit"),
		to: work("work-ci-runners"),
		source: "work_link",
	},
];

describe("decision graph", () => {
	it("resolves backfilled Work titles at read time without leaking other organizations", async () => {
		const f = fixture();
		try {
			f.sqlite
				.prepare(
					"INSERT INTO work_items(id,org_id,title,created_at) VALUES(?,?,?,'2026-10-22'),(?,?,?,'2026-10-22')",
				)
				.run(
					"work-source",
					ORG,
					"Review launch checklist",
					"work-other",
					OTHER_ORG,
					"Private title",
				);
			for (const id of ["work-source", "work-other", "work-missing"]) {
				await upsertDecisionEdges(f.db, ORG, [
					{
						kind: "card_from_work",
						from: card(id),
						to: work(id),
						source: "backfill",
						note: "Source Work item",
					},
				]);
			}
			const read = (id: string) => getDecisionContext(f.db, ORG, id);
			expect(explainChain(await read("work-source"))).toBe(
				'From Work "Review launch checklist"',
			);
			f.sqlite
				.prepare("UPDATE work_items SET title = ? WHERE id = ?")
				.run("Approve launch checklist", "work-source");
			expect((await read("work-source")).chain[0]?.edge.note).toBe(
				"Approve launch checklist",
			);
			for (const id of ["work-other", "work-missing"]) {
				expect(explainChain(await read(id))).toBe("From a Work item");
			}
		} finally {
			f.sqlite.close();
		}
	});

	it("explains the GitHub card from the owner's earlier instruction", async () => {
		const f = fixture();
		try {
			await upsertDecisionEdges(f.db, ORG, githubCardEdges);
			const context = await getDecisionContext(f.db, ORG, "card-github", {
				maxHops: 4,
			});
			expect(DecisionContextSchema.parse(context)).toEqual(context);
			expect(context.priorDecision?.node).toEqual({
				kind: "owner_instruction",
				id: "instruction-rotate",
			});
			expect(context.priorDecision?.edge.evidenceRef).toBe(
				"work-comment:comment-rotate",
			);
			expect(context.chain.map((step) => [step.hop, step.node.id])).toEqual(
				expect.arrayContaining([
					[1, "work-github-audit"],
					[1, "system-github"],
					[2, "instruction-rotate"],
					[2, "credential-deploy-key"],
				]),
			);
			expect(context.blocksCount).toBe(2);
			expect(context.duplicates).toEqual([]);
			expect(explainChain(context)).toBe(
				'You decided this on 20 Oct: "rotate leftover credentials" → from Work "Audit GitHub access" → involves GitHub, old deploy key → 2 items wait on this',
			);
		} finally {
			f.sqlite.close();
		}
	});

	it("upserts idempotently, keeps the earliest date and stays under 100 bound values", async () => {
		const f = fixture();
		try {
			const many: DecisionEdgeInput[] = Array.from({ length: 40 }, (_, i) => ({
				kind: "involves",
				from: card("card-bulk"),
				to: { kind: "person", id: `person-${i}` },
				source: "backfill",
			}));
			expect(await upsertDecisionEdges(f.db, ORG, many)).toEqual({
				written: 40,
			});
			await upsertDecisionEdges(f.db, ORG, many);
			expect(f.count()).toBe(40);

			const edge: DecisionEdgeInput = {
				kind: "card_answers",
				from: card("card-a"),
				to: { kind: "decision", id: "decision-a" },
				source: "deck",
				occurredAt: "2026-10-19T10:00:00Z",
			};
			await upsertDecisionEdges(f.db, ORG, [edge]);
			await upsertDecisionEdges(f.db, ORG, [
				{
					...edge,
					occurredAt: "2026-10-21T10:00:00Z",
					confidence: 0.4,
					note: "Approved",
				},
			]);
			const prior = await findPriorDecision(f.db, ORG, ["card-a"]);
			expect(prior?.edge).toMatchObject({
				occurredAt: "2026-10-19T10:00:00.000Z",
				confidence: 0.4,
				note: "Approved",
			});
			expect(await upsertDecisionEdges(f.db, ORG, [])).toEqual({ written: 0 });
		} finally {
			f.sqlite.close();
		}
	});

	it("rejects edges whose endpoints do not fit the edge kind", async () => {
		const f = fixture();
		try {
			const bad: DecisionEdgeInput[][] = [
				[
					{
						kind: "card_from_work",
						from: work("w"),
						to: work("w2"),
						source: "deck",
					},
				],
				[{ kind: "same_as", from: card("c"), to: card("c"), source: "deck" }],
				[
					{
						kind: "same_as",
						from: card("c"),
						to: card("d"),
						source: "deck",
						confidence: 2,
					},
				],
				[{ kind: "same_as", from: card("c"), to: card("d"), source: " " }],
				[
					{
						kind: "same_as",
						from: card("c"),
						to: card("d"),
						source: "deck",
						occurredAt: "not a date",
					},
				],
			];
			for (const edges of bad) {
				await expect(upsertDecisionEdges(f.db, ORG, edges)).rejects.toThrow(
					DecisionEdgeValidationError,
				);
			}
			expect(f.count()).toBe(0);
		} finally {
			f.sqlite.close();
		}
	});

	it("finds the latest prior decision and never crosses organizations", async () => {
		const f = fixture();
		try {
			await upsertDecisionEdges(f.db, ORG, [
				{
					kind: "decided_by",
					from: work("work-1"),
					to: { kind: "decision", id: "decision-old" },
					source: "approval",
					occurredAt: "2026-09-01T00:00:00Z",
				},
				{
					kind: "decided_by",
					from: card("card-1"),
					to: { kind: "decision", id: "decision-new" },
					source: "approval",
					occurredAt: "2026-10-01T00:00:00Z",
				},
			]);
			await upsertDecisionEdges(f.db, OTHER_ORG, [
				{
					kind: "decided_by",
					from: work("work-1"),
					to: { kind: "decision", id: "decision-foreign" },
					source: "approval",
					occurredAt: "2026-10-20T00:00:00Z",
				},
			]);
			expect(
				(await findPriorDecision(f.db, ORG, ["work-1", "card-1"]))?.node.id,
			).toBe("decision-new");
			expect((await findPriorDecision(f.db, ORG, ["work-1"]))?.node.id).toBe(
				"decision-old",
			);
			expect(await findPriorDecision(f.db, ORG, [])).toBeNull();
			expect(await findPriorDecision(f.db, ORG, ["work-none"])).toBeNull();
			expect(
				await getDecisionContext(f.db, "fictional-nobody", "card-1"),
			).toEqual({
				cardId: "card-1",
				chain: [],
				duplicates: [],
				blocksCount: 0,
			});
		} finally {
			f.sqlite.close();
		}
	});

	it("finds duplicates by same_as in both directions and by shared source Work", async () => {
		const f = fixture();
		try {
			await upsertDecisionEdges(f.db, ORG, [
				{
					kind: "same_as",
					from: card("card-x"),
					to: card("card-y"),
					source: "merge",
				},
				{
					kind: "same_as",
					from: card("card-z"),
					to: card("card-x"),
					source: "merge",
				},
				{
					kind: "card_from_work",
					from: card("card-x"),
					to: work("work-x"),
					source: "deck",
				},
				{
					kind: "card_from_work",
					from: card("card-w"),
					to: work("work-x"),
					source: "deck",
				},
				{
					kind: "card_from_work",
					from: card("card-other"),
					to: work("work-o"),
					source: "deck",
				},
			]);
			await upsertDecisionEdges(f.db, OTHER_ORG, [
				{
					kind: "card_from_work",
					from: card("card-foreign"),
					to: work("work-x"),
					source: "deck",
				},
			]);
			expect(await findDuplicateCards(f.db, ORG, "card-x")).toEqual([
				"card-w",
				"card-y",
				"card-z",
			]);
			expect(await findDuplicateCards(f.db, ORG, "card-other")).toEqual([]);
		} finally {
			f.sqlite.close();
		}
	});

	it("counts distinct blocked items per node", async () => {
		const f = fixture();
		try {
			await upsertDecisionEdges(f.db, ORG, githubCardEdges);
			expect(await countBlocked(f.db, ORG, "work-github-audit")).toBe(2);
			f.sqlite
				.prepare("UPDATE work_items SET disposition = 'completed' WHERE id = ?")
				.run("work-release-train");
			expect(await countBlocked(f.db, ORG, "work-github-audit")).toBe(1);
			f.sqlite
				.prepare("UPDATE work_items SET disposition = 'cancelled' WHERE id = ?")
				.run("work-ci-runners");
			expect(await countBlocked(f.db, ORG, "work-github-audit")).toBe(0);
			expect(
				(await getDecisionContext(f.db, ORG, "card-github")).blocksCount,
			).toBe(0);
			expect(await countBlocked(f.db, ORG, "work-release-train")).toBe(0);
			expect(await countBlocked(f.db, OTHER_ORG, "work-github-audit")).toBe(0);
			expect(
				await terminalWorkItemIds(f.db, ORG, [
					"work-github-audit",
					"work-release-train",
					"work-ci-runners",
					"work-unknown",
				]),
			).toEqual(new Set(["work-release-train", "work-ci-runners"]));
			expect(
				await terminalWorkItemIds(f.db, OTHER_ORG, ["work-ci-runners"]),
			).toEqual(new Set());
		} finally {
			f.sqlite.close();
		}
	});

	it("bounds traversal by maxHops and reports a newer replacing card", async () => {
		const f = fixture();
		try {
			await upsertDecisionEdges(f.db, ORG, [
				{
					kind: "card_from_work",
					from: card("card-old"),
					to: work("work-1"),
					source: "deck",
				},
				{
					kind: "evidence",
					from: work("work-1"),
					to: { kind: "output", id: "output-audit" },
					source: "work",
					note: "audit done",
				},
				{
					kind: "supersedes",
					from: card("card-new"),
					to: card("card-old"),
					source: "deck",
					occurredAt: "2026-10-21T09:00:00Z",
				},
			]);
			const oneHop = await getDecisionContext(f.db, ORG, "card-old", {
				maxHops: 1,
			});
			expect(oneHop.chain.map((step) => step.node.id)).toEqual(["work-1"]);
			const full = await getDecisionContext(f.db, ORG, "card-old", {
				maxHops: 99,
			});
			expect(full.chain.map((step) => step.node.id)).toEqual([
				"work-1",
				"output-audit",
			]);
			expect(full.supersededBy?.node).toEqual(card("card-new"));
			expect(explainChain(full)).toBe(
				"From a Work item → audit done → replaced by a newer card",
			);
		} finally {
			f.sqlite.close();
		}
	});

	it("explains an empty context and a single answered duplicate", () => {
		expect(
			explainChain({ cardId: "c", chain: [], duplicates: [], blocksCount: 0 }),
		).toBe("No earlier decision or linked Work found.");
		const edge = {
			id: "e",
			kind: "card_answers" as const,
			from: card("c"),
			to: { kind: "decision" as const, id: "d" },
			source: "deck",
			confidence: 1,
			evidenceRef: null,
			note: null,
			occurredAt: "2026-03-05T12:00:00.000Z",
			createdAt: "2026-03-05T12:00:00.000Z",
		};
		expect(
			explainChain({
				cardId: "c",
				chain: [],
				priorDecision: { node: edge.to, edge },
				duplicates: ["c2"],
				blocksCount: 1,
			}),
		).toBe(
			"You answered this on 5 Mar → same as 1 other card → 1 item waits on this",
		);
		expect(
			explainChain({
				cardId: "c",
				chain: [],
				duplicates: [],
				blocksCount: 0,
				objective: { id: "o", title: "Grow orchard sales", priority: 1 },
			}),
		).toBe("Serves Grow orchard sales");
	});
});
