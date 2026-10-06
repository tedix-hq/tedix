import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import {
	DEFAULT_PACE_LAYER_POLICY,
	resolvePaceLayerPolicy,
} from "../schema/control-plane";
import { createD1Facade } from "../test/d1-facade";
import {
	getSkillPortfolioBalance,
	getSkillPortfolioBalanceByTedi,
} from "./skill-portfolio";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE skill_entries (
			id TEXT PRIMARY KEY NOT NULL,
			organization_id TEXT NOT NULL,
			tedi_id TEXT,
			title TEXT NOT NULL,
			content TEXT NOT NULL DEFAULT '# Skill',
			lifecycle_state TEXT DEFAULT 'draft',
			pace_layer TEXT NOT NULL DEFAULT 'innovation',
			app_id TEXT
		);
	`);

	let seq = 0;
	const insertSkill = (row: {
		lifecycleState?: string | null;
		paceLayer: string;
		organizationId?: string;
		tediId?: string | null;
		appId?: string | null;
	}) => {
		seq += 1;
		sqlite
			.prepare(
				`INSERT INTO skill_entries (
					id, organization_id, tedi_id, title, lifecycle_state, pace_layer, app_id
				) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				`skill-${seq}`,
				row.organizationId ?? "org-1",
				row.tediId === undefined ? null : row.tediId,
				`Skill ${seq}`,
				row.lifecycleState === undefined ? "draft" : row.lifecycleState,
				row.paceLayer,
				row.appId ?? null,
			);
	};

	return { db: createDbClient(createD1Facade(sqlite)), insertSkill };
}

describe("getSkillPortfolioBalance", () => {
	it("computes layer counts, shares, and envelope deviations", async () => {
		const { db, insertSkill } = fixture();
		// 1 record, 2 differentiation, 1 innovation — with the layer coming from
		// the stored column where present.
		insertSkill({ lifecycleState: "crystallized", paceLayer: "record" });
		insertSkill({ lifecycleState: "active", paceLayer: "differentiation" });
		insertSkill({ lifecycleState: "proven", paceLayer: "differentiation" });
		insertSkill({ lifecycleState: "draft", paceLayer: "innovation" });
		// Archived rows are out of scope.
		insertSkill({ lifecycleState: "archived", paceLayer: "innovation" });
		// Other orgs are out of scope.
		insertSkill({
			lifecycleState: "draft",
			paceLayer: "innovation",
			organizationId: "org-2",
		});

		const balance = await getSkillPortfolioBalance(db, "org-1");
		expect(balance.totalSkills).toBe(4);
		expect(balance.layers.record).toMatchObject({
			count: 1,
			share: 0.25,
			healthyShare: 0.75,
			deviation: -0.5,
		});
		expect(balance.layers.differentiation).toMatchObject({
			count: 2,
			share: 0.5,
			healthyShare: 0.2,
			deviation: 0.3,
		});
		expect(balance.layers.innovation).toMatchObject({
			count: 1,
			share: 0.25,
			healthyShare: 0.05,
			deviation: 0.2,
		});
		expect(balance.stagnation).toBe(false);
		expect(balance.stagnationKind).toBeNull();
	});

	it("uses the required stored classification without inferring from lifecycle", async () => {
		const { db, insertSkill } = fixture();
		insertSkill({ lifecycleState: "crystallized", paceLayer: "innovation" });
		const balance = await getSkillPortfolioBalance(db, "org-1");
		expect(balance.layers.innovation.count).toBe(1);
		expect(balance.layers.record.count).toBe(0);
	});

	it("flags an all-innovation portfolio as stagnation (churn without compounding)", async () => {
		const { db, insertSkill } = fixture();
		insertSkill({ lifecycleState: "draft", paceLayer: "innovation" });
		insertSkill({ lifecycleState: "stale", paceLayer: "innovation" });
		const balance = await getSkillPortfolioBalance(db, "org-1");
		expect(balance.stagnation).toBe(true);
		expect(balance.stagnationKind).toBe("all_innovation");
	});

	it("flags an all-record portfolio as stagnation (rigidity without learning)", async () => {
		const { db, insertSkill } = fixture();
		insertSkill({ lifecycleState: "crystallized", paceLayer: "record" });
		insertSkill({ lifecycleState: "crystallized", paceLayer: "record" });
		const balance = await getSkillPortfolioBalance(db, "org-1");
		expect(balance.stagnation).toBe(true);
		expect(balance.stagnationKind).toBe("all_record");
	});

	it("an empty portfolio is not stagnation and has zero shares", async () => {
		const { db } = fixture();
		const balance = await getSkillPortfolioBalance(db, "org-1");
		expect(balance.totalSkills).toBe(0);
		expect(balance.stagnation).toBe(false);
		expect(balance.stagnationKind).toBeNull();
		expect(balance.layers.record.share).toBe(0);
	});

	it("supports an explicit tedi filter (org-scoped rows excluded by design)", async () => {
		const { db, insertSkill } = fixture();
		insertSkill({
			lifecycleState: "active",
			paceLayer: "differentiation",
			tediId: "tedi-1",
		});
		insertSkill({
			lifecycleState: "draft",
			paceLayer: "innovation",
			tediId: null,
		});
		const balance = await getSkillPortfolioBalance(db, "org-1", {
			tediId: "tedi-1",
		});
		expect(balance.totalSkills).toBe(1);
		expect(balance.layers.differentiation.count).toBe(1);
	});
});

describe("getSkillPortfolioBalanceByTedi", () => {
	it("matches the individual per-tedi calls and applies the same population predicate", async () => {
		const { db, insertSkill } = fixture();
		// tedi-1: one per layer.
		insertSkill({
			lifecycleState: "crystallized",
			paceLayer: "record",
			tediId: "tedi-1",
		});
		insertSkill({
			lifecycleState: "active",
			paceLayer: "differentiation",
			tediId: "tedi-1",
		});
		insertSkill({
			lifecycleState: "draft",
			paceLayer: "innovation",
			tediId: "tedi-1",
		});
		// tedi-2: all innovation → stagnation.
		insertSkill({
			lifecycleState: "draft",
			paceLayer: "innovation",
			tediId: "tedi-2",
		});
		insertSkill({
			lifecycleState: "stale",
			paceLayer: "innovation",
			tediId: "tedi-2",
		});
		// Out of population: org-scoped, archived, app-scoped, other org.
		insertSkill({
			lifecycleState: "draft",
			paceLayer: "innovation",
			tediId: null,
		});
		insertSkill({
			lifecycleState: "archived",
			paceLayer: "innovation",
			tediId: "tedi-1",
		});
		insertSkill({
			lifecycleState: "active",
			paceLayer: "differentiation",
			tediId: "tedi-1",
			appId: "app-1",
		});
		insertSkill({
			lifecycleState: "active",
			paceLayer: "differentiation",
			tediId: "tedi-3",
			organizationId: "org-2",
		});

		const byTedi = await getSkillPortfolioBalanceByTedi(db, "org-1");
		// Only tedis with in-population skills appear; tedi-3 is another org's.
		expect([...byTedi.keys()].sort()).toEqual(["tedi-1", "tedi-2"]);
		// The batched map must be indistinguishable from the per-tedi fan-out.
		for (const tediId of ["tedi-1", "tedi-2"]) {
			expect(byTedi.get(tediId)).toEqual(
				await getSkillPortfolioBalance(db, "org-1", { tediId }),
			);
		}
		expect(byTedi.get("tedi-1")?.totalSkills).toBe(3);
		expect(byTedi.get("tedi-2")?.stagnationKind).toBe("all_innovation");
	});
});

describe("resolvePaceLayerPolicy", () => {
	it("returns the GAIE-tier defaults with no pack definition", () => {
		const policy = resolvePaceLayerPolicy(undefined);
		expect(policy).toEqual(DEFAULT_PACE_LAYER_POLICY);
		expect(policy.record.approvalRequired).toBe(true);
		expect(policy.innovation.approvalRequired).toBe(false);
		expect(policy.innovation.draftTtlDays).toBe(14);
	});

	it("merges pack overrides per layer over the defaults", () => {
		const policy = resolvePaceLayerPolicy({
			paceLayerPolicy: {
				record: { approvalRequired: false },
				innovation: { draftTtlDays: 7 },
			},
		});
		expect(policy.record.approvalRequired).toBe(false);
		expect(policy.record.evalRequired).toBe(true);
		expect(policy.innovation.draftTtlDays).toBe(7);
		expect(policy.differentiation).toEqual(
			DEFAULT_PACE_LAYER_POLICY.differentiation,
		);
	});
});
