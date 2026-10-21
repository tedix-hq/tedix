import { DatabaseSync } from "node:sqlite";
import { createDbClient, type DbClient } from "@tedix/db/client";
import { listFactoryWeightProposals } from "@tedix/db/queries/factory-weights";
import { learningInteractionEvents } from "@tedix/db/schema/learning-feedback";
import { organizations } from "@tedix/db/schema/organizations";
import {
	osGadgetRevisions,
	osGadgets,
	osOutputRevisions,
	osOutputs,
} from "@tedix/db/schema/os-workspaces";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { desc, eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";
import { updateFactoryWeights } from "./factory-weight-update";

const ORG = "org-weights";
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const GADGET = "gadget-review";
const RULES = "output-rules";
const monday = new Date("2026-10-26T07:00:00.000Z");
const day = (n: number) => new Date(monday.getTime() + n * 86_400_000);

function manifest(mode: "shadow" | "enforce", minSamples = 20) {
	return {
		entry: "tedix:app/card-review",
		capabilities: [],
		config: {
			version: 1,
			sources: [
				{
					label: "Forum",
					workspaceId: WORKSPACE,
					cardSheetPrefix: "Forum cards ",
					columns: {
						source: "Thread",
						why: "Why",
						useful: "Useful?",
						reason: "Reason",
						done: "Done?",
						features: "Features",
					},
					doIt: "approve",
					rules: {
						sheetTitle: "Forum rules",
						idColumn: "Rule",
						textColumn: "Text",
						statusColumn: "Status",
					},
					scoring: {
						weights: { fresh_thread: 0.2, buyer_intent: 0.6 },
						topN: 5,
						weightUpdate: { cadence: "weekly", mode, minSamples },
					},
				},
			],
		},
	};
}

async function fixture(input: {
	mode: "shadow" | "enforce";
	verdicts: number;
	minSamples?: number;
}) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(
		schemaDdl(
			organizations,
			osGadgets,
			osGadgetRevisions,
			osOutputs,
			osOutputRevisions,
			learningInteractionEvents,
		),
	);
	const db = createDbClient(createD1Facade(sqlite));
	await db.insert(organizations).values({
		id: ORG,
		name: "Sample Co",
		slug: "sample",
		descopeTenantId: "sample",
	});
	await db.insert(osGadgets).values({
		id: GADGET,
		organizationId: ORG,
		workspaceId: WORKSPACE,
		name: "Card review",
		currentRevisionId: "gadget-rev-1",
		createdByKind: "user",
		createdById: "owner",
	});
	await db.insert(osGadgetRevisions).values({
		id: "gadget-rev-1",
		organizationId: ORG,
		gadgetId: GADGET,
		revision: 1,
		manifest: JSON.stringify(manifest(input.mode, input.minSamples)),
		createdByKind: "user",
		createdById: "owner",
	});
	await db.insert(osOutputs).values({
		id: RULES,
		organizationId: ORG,
		workspaceId: WORKSPACE,
		kind: "sheet",
		title: "Forum rules",
		currentRevisionId: "rules-rev-1",
		createdByKind: "tedi",
		createdById: "factory",
	});
	await db.insert(osOutputRevisions).values({
		id: "rules-rev-1",
		organizationId: ORG,
		outputId: RULES,
		revision: 1,
		content: JSON.stringify({
			kind: "sheet",
			columns: ["Rule", "Text", "Status"],
			rows: [["R1", "Skip threads older than a week", "accepted"]],
		}),
		createdByKind: "tedi",
		createdById: "factory",
	});
	for (let i = 0; i < input.verdicts; i += 1) {
		const useful = i % 2 === 0;
		await db.insert(learningInteractionEvents).values({
			id: `event-${i}`,
			organizationId: ORG,
			actorType: "user",
			actorId: "reviewer-a",
			clientEventId: `client-${i}`,
			eventKind: useful ? "accepted" : "rejected",
			scopeKind: "personal",
			scopeId: "reviewer-a",
			surface: "decision_deck",
			targetType: "output",
			targetId: "output-cards",
			metadata: {
				decisionClass: "factory:Forum:Reply",
				decisionChoice: useful ? "useful" : "not_useful",
				rowIndex: i,
				features: useful
					? { fresh_thread: 0.85, buyer_intent: 0.2 }
					: { fresh_thread: 0.15, buyer_intent: 0.8 },
				...(useful
					? {}
					: { factoryReason: "Wrong topic", sharedReason: "not_for_me" }),
			},
			occurredAt: new Date(Date.UTC(2026, 9, 20, 0, i)).toISOString(),
		});
	}
	return db;
}

async function currentManifest(db: DbClient) {
	const [row] = await db
		.select()
		.from(osGadgetRevisions)
		.where(eq(osGadgetRevisions.gadgetId, GADGET))
		.orderBy(desc(osGadgetRevisions.revision))
		.limit(1);
	return { revision: row!.revision, manifest: JSON.parse(row!.manifest) };
}

async function rulesContent(db: DbClient) {
	const [row] = await db
		.select()
		.from(osOutputRevisions)
		.where(eq(osOutputRevisions.outputId, RULES))
		.orderBy(desc(osOutputRevisions.revision))
		.limit(1);
	return {
		revision: row!.revision,
		content: JSON.parse(row!.content) as {
			columns: string[];
			rows: (string | null)[][];
		},
	};
}

/** The person's Accept or Reject in the Card review app: a new rules sheet revision. */
async function decideRule(db: DbClient, status: "accepted" | "rejected") {
	const current = await rulesContent(db);
	const rows = current.content.rows.map((row) =>
		row[2] === "proposed" ? [row[0]!, row[1]!, status] : row,
	);
	const id = `rules-rev-${current.revision + 1}`;
	await db.insert(osOutputRevisions).values({
		id,
		organizationId: ORG,
		outputId: RULES,
		revision: current.revision + 1,
		content: JSON.stringify({ ...current.content, rows }),
		createdByKind: "user",
		createdById: "reviewer-a",
	});
	await db
		.update(osOutputs)
		.set({ currentRevisionId: id })
		.where(eq(osOutputs.id, RULES));
}

const weightsOf = (m: { manifest: ReturnType<typeof manifest> }) =>
	m.manifest.config.sources[0]!.scoring.weights;

describe("updateFactoryWeights", () => {
	it("shadow stores a proposal and report and never applies or proposes it", async () => {
		const db = await fixture({ mode: "shadow", verdicts: 40 });
		const counts = await updateFactoryWeights(db, monday);
		expect(counts).toMatchObject({ sources: 1, shadow: 1, proposed: 0 });
		const [proposal] = await listFactoryWeightProposals(db, ORG);
		expect(proposal).toMatchObject({
			factoryKey: `${WORKSPACE}|Forum`,
			mode: "shadow",
			status: "shadow",
			ruleId: null,
			previousWeights: { fresh_thread: 0.2, buyer_intent: 0.6 },
			report: { samples: 40, heldOut: 10, topN: 5 },
		});
		expect(proposal!.weights.fresh_thread).toBeGreaterThan(0.2);
		expect(proposal!.report.accuracyAfter!).toBeGreaterThan(
			proposal!.report.accuracyBefore!,
		);
		expect((await rulesContent(db)).revision).toBe(1);
		// Later passes, even a week on, still change no config.
		await updateFactoryWeights(db, day(1));
		await updateFactoryWeights(db, day(7));
		const after = await currentManifest(db);
		expect(after.revision).toBe(1);
		expect(weightsOf(after)).toEqual({ fresh_thread: 0.2, buyer_intent: 0.6 });
		expect((await rulesContent(db)).revision).toBe(1);
	});

	it("enforce proposes a rule and applies the stored weights once accepted", async () => {
		const db = await fixture({ mode: "enforce", verdicts: 40 });
		expect(await updateFactoryWeights(db, monday)).toMatchObject({
			proposed: 1,
		});
		const rules = await rulesContent(db);
		expect(rules.content.rows).toHaveLength(2);
		expect(rules.content.rows[1]).toEqual([
			"weights-2026-10-26",
			expect.stringMatching(/^Retune card weights from 40 verdicts/),
			"proposed",
		]);
		const [proposed] = await listFactoryWeightProposals(db, ORG);
		expect(proposed).toMatchObject({
			status: "proposed",
			ruleId: "weights-2026-10-26",
		});

		// Not decided yet: nothing applied, no new proposal.
		expect(await updateFactoryWeights(db, day(1))).toMatchObject({
			pending: 1,
		});
		expect((await currentManifest(db)).revision).toBe(1);

		await decideRule(db, "accepted");
		expect(await updateFactoryWeights(db, day(2))).toMatchObject({
			applied: 1,
		});
		const applied = await currentManifest(db);
		expect(applied.revision).toBe(2);
		expect(weightsOf(applied)).toEqual(proposed!.weights);
		const [settled] = await listFactoryWeightProposals(db, ORG);
		expect(settled).toMatchObject({
			status: "applied",
			appliedTo: [{ gadgetId: GADGET, revision: 2 }],
		});
	});

	it("a rejected proposal changes nothing", async () => {
		const db = await fixture({ mode: "enforce", verdicts: 40 });
		await updateFactoryWeights(db, monday);
		await decideRule(db, "rejected");
		expect(await updateFactoryWeights(db, day(1))).toMatchObject({
			rejected: 1,
		});
		expect((await currentManifest(db)).revision).toBe(1);
	});

	it("proposes nothing below minSamples", async () => {
		const db = await fixture({ mode: "enforce", verdicts: 12 });
		expect(await updateFactoryWeights(db, monday)).toMatchObject({
			insufficient: 1,
			proposed: 0,
		});
		expect((await rulesContent(db)).revision).toBe(1);
		const [proposal] = await listFactoryWeightProposals(db, ORG);
		expect(proposal).toMatchObject({
			status: "insufficient",
			report: { note: "12 of 20 verdicts with features" },
		});
		// Weekly: the next day does not refit.
		expect(await updateFactoryWeights(db, day(1))).toMatchObject({
			skipped: 1,
		});
	});
});
