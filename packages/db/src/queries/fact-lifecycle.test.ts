import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import {
	contentTokenOverlapRatio,
	countLinkableSameDomainFacts,
	evaluateFactAdmission,
	FACT_PROBATION_TTL_DAYS,
	FACT_UNLINKED_CONFIDENCE_CEILING,
	FACT_UNLINKED_PROBATION_TTL_DAYS,
	sweepExpiredProbationFacts,
} from "./fact-lifecycle";

const NOW = new Date("2026-07-16T03:00:00.000Z");

function daysAgo(days: number): string {
	return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE memory_facts (
			id TEXT PRIMARY KEY NOT NULL,
			organization_id TEXT NOT NULL,
			tedi_id TEXT,
			domain_id TEXT,
			content TEXT NOT NULL,
			summary TEXT,
			fact_type TEXT NOT NULL DEFAULT 'technical',
			confidence REAL NOT NULL DEFAULT 0.8,
			valid_from TEXT,
			valid_to TEXT,
			status TEXT DEFAULT 'active',
			source TEXT,
			source_session_id TEXT,
			source_url TEXT,
			source_hash TEXT,
			embedding_id TEXT,
			topic_key TEXT,
			memory_scope TEXT DEFAULT 'tedi',
			use_policy TEXT DEFAULT 'can_use_as_evidence',
			review_status TEXT DEFAULT 'pending',
			metadata TEXT,
			priority TEXT DEFAULT 'active',
			visibility TEXT DEFAULT 'private',
			promoted_from TEXT,
			promoted_at TEXT,
			last_verified_at TEXT,
			last_accessed_at TEXT,
			access_count INTEGER NOT NULL DEFAULT 0,
			usage_count INTEGER NOT NULL DEFAULT 0,
			archived_at TEXT,
			created_at TEXT DEFAULT (CURRENT_TIMESTAMP),
			updated_at TEXT DEFAULT (CURRENT_TIMESTAMP)
		);
	`);
	const insert = sqlite.prepare(
		`INSERT INTO memory_facts (id, organization_id, domain_id, content, fact_type, status, access_count, valid_to, archived_at, metadata, created_at)
		 VALUES (?, ?, ?, ?, 'technical', ?, ?, ?, ?, ?, ?)`,
	);
	const insertFact = (fact: {
		id: string;
		orgId?: string;
		domainId?: string;
		content?: string;
		status?: string;
		accessCount?: number;
		validTo?: string | null;
		archivedAt?: string | null;
		metadata?: Record<string, unknown> | null;
		createdAt?: string;
	}) => {
		insert.run(
			fact.id,
			fact.orgId ?? "org-1",
			fact.domainId ?? "domain-1",
			fact.content ?? `content for ${fact.id}`,
			fact.status ?? "probation",
			fact.accessCount ?? 0,
			fact.validTo ?? null,
			fact.archivedAt ?? null,
			fact.metadata ? JSON.stringify(fact.metadata) : null,
			fact.createdAt ?? daysAgo(30),
		);
	};
	const getFact = (id: string) =>
		sqlite.prepare("SELECT * FROM memory_facts WHERE id = ?").get(id) as Record<
			string,
			unknown
		>;
	return { db: createDbClient(createD1Facade(sqlite)), insertFact, getFact };
}

describe("evaluateFactAdmission", () => {
	const noSignals = {
		relatedFactCount: 0,
		topicKeyMatches: 0,
		hasTopicKey: false,
		similarSameDomainCount: 0,
	};

	it("unlinked enforced fact enters as short-TTL probation with capped confidence", () => {
		const decision = evaluateFactAdmission(noSignals, { enforced: true });
		expect(decision.linkage).toBe("unlinked");
		expect(decision.ttlDays).toBe(FACT_UNLINKED_PROBATION_TTL_DAYS);
		expect(decision.confidenceCeiling).toBe(FACT_UNLINKED_CONFIDENCE_CEILING);
	});

	it.each([
		["relatedTo edges", { ...noSignals, relatedFactCount: 1 }],
		["topic-key supersession matches", { ...noSignals, topicKeyMatches: 2 }],
		["a stable topic key", { ...noSignals, hasTopicKey: true }],
		["same-domain similarity", { ...noSignals, similarSameDomainCount: 3 }],
	] as const)("%s links the fact — normal TTL, no cap", (_label, signals) => {
		const decision = evaluateFactAdmission(signals, { enforced: true });
		expect(decision.linkage).toBe("linked");
		expect(decision.ttlDays).toBe(FACT_PROBATION_TTL_DAYS);
		expect(decision.confidenceCeiling).toBeNull();
	});

	it("non-enforced producers keep default TTL and confidence even when unlinked", () => {
		const decision = evaluateFactAdmission(noSignals, { enforced: false });
		expect(decision.linkage).toBe("unlinked");
		expect(decision.ttlDays).toBe(FACT_PROBATION_TTL_DAYS);
		expect(decision.confidenceCeiling).toBeNull();
	});
});

describe("contentTokenOverlapRatio", () => {
	it("matches the autoLinkFacts related_to heuristic", () => {
		expect(
			contentTokenOverlapRatio(
				"wrangler deploy failed because the account token expired yesterday",
				"the wrangler account token expired again during deploy",
			),
		).toBeGreaterThan(0.3);
		expect(
			contentTokenOverlapRatio(
				"wrangler deploy failed because the token expired",
				"completely unrelated marketing sentence about croissants",
			),
		).toBe(0);
		expect(contentTokenOverlapRatio("a b c", "a b c")).toBe(0);
	});
});

describe("countLinkableSameDomainFacts", () => {
	it("counts same-domain overlap matches and ignores other domains and archived facts", async () => {
		const { db, insertFact } = fixture();
		const content =
			"wrangler deploy failed because the account token expired yesterday";
		insertFact({
			id: "same-domain-similar",
			content: "the wrangler account token expired again during deploy",
		});
		insertFact({
			id: "other-domain-similar",
			domainId: "domain-2",
			content: "the wrangler account token expired again during deploy",
		});
		insertFact({
			id: "same-domain-archived",
			content: "the wrangler account token expired again during deploy",
			archivedAt: daysAgo(1),
		});
		insertFact({
			id: "same-domain-unrelated",
			content: "completely unrelated marketing sentence about croissants",
		});

		const count = await countLinkableSameDomainFacts(
			db,
			"org-1",
			"domain-1",
			content,
		);
		expect(count).toBe(1);
	});
});

describe("sweepExpiredProbationFacts", () => {
	it("archives only unretrieved probation facts past their TTL", async () => {
		const { db, insertFact, getFact } = fixture();
		insertFact({ id: "expired", createdAt: daysAgo(15) });
		insertFact({ id: "young", createdAt: daysAgo(5) });
		insertFact({ id: "retrieved", createdAt: daysAgo(30), accessCount: 2 });
		insertFact({ id: "active", createdAt: daysAgo(30), status: "active" });
		insertFact({
			id: "already-archived",
			createdAt: daysAgo(30),
			archivedAt: daysAgo(2),
		});
		insertFact({
			id: "invalidated",
			createdAt: daysAgo(30),
			validTo: daysAgo(3),
		});

		const result = await sweepExpiredProbationFacts(db, { now: NOW });

		expect(result.archivedIds).toEqual(["expired"]);
		expect(result.archived).toBe(1);
		expect(result.perOrg).toEqual({ "org-1": 1 });
		const swept = getFact("expired");
		expect(swept.archived_at).toBe(NOW.toISOString());
		expect(JSON.parse(String(swept.metadata)).archiveReason).toBe(
			"probation-ttl-sweep",
		);
		for (const id of ["young", "retrieved", "active", "invalidated"]) {
			expect(getFact(id).archived_at).toBeNull();
		}
	});

	it("honors the shorter per-fact TTL stamped by the admission gate", async () => {
		const { db, insertFact } = fixture();
		insertFact({
			id: "unlinked-8d",
			createdAt: daysAgo(8),
			metadata: { brainAdmission: { linkage: "unlinked", ttlDays: 7 } },
		});
		insertFact({ id: "default-ttl-8d", createdAt: daysAgo(8) });

		const result = await sweepExpiredProbationFacts(db, { now: NOW });
		expect(result.archivedIds).toEqual(["unlinked-8d"]);
	});

	it("caps archives per org and sweeps oldest first, across orgs", async () => {
		const { db, insertFact } = fixture();
		insertFact({ id: "a-oldest", orgId: "org-a", createdAt: daysAgo(40) });
		insertFact({ id: "a-older", orgId: "org-a", createdAt: daysAgo(30) });
		insertFact({ id: "a-newest", orgId: "org-a", createdAt: daysAgo(20) });
		insertFact({ id: "b-only", orgId: "org-b", createdAt: daysAgo(20) });

		const result = await sweepExpiredProbationFacts(db, {
			now: NOW,
			perOrgLimit: 2,
		});
		expect(result.perOrg).toEqual({ "org-a": 2, "org-b": 1 });
		expect(result.archivedIds.sort()).toEqual([
			"a-older",
			"a-oldest",
			"b-only",
		]);
	});

	it("S5 homeostat: drains up to maxBatchesPerOrg × perOrgLimit per org per sweep", async () => {
		const { db, insertFact, getFact } = fixture();
		for (let i = 0; i < 5; i++) {
			insertFact({ id: `f${i}`, orgId: "org-a", createdAt: daysAgo(40 - i) });
		}
		// perOrgLimit 2 × budget 3 = up to 6, so all 5 drain (batches 2+2+1).
		const result = await sweepExpiredProbationFacts(db, {
			now: NOW,
			perOrgLimit: 2,
			maxBatchesPerOrg: 3,
		});
		expect(result.archived).toBe(5);
		expect(result.perOrg).toEqual({ "org-a": 5 });
		for (let i = 0; i < 5; i++) {
			expect(getFact(`f${i}`).archived_at).toBe(NOW.toISOString());
		}
	});

	it("S5 homeostat: default budget (1 batch) preserves the legacy per-org cap", async () => {
		const { db, insertFact } = fixture();
		for (let i = 0; i < 5; i++) {
			insertFact({ id: `g${i}`, orgId: "org-a", createdAt: daysAgo(40 - i) });
		}
		const result = await sweepExpiredProbationFacts(db, {
			now: NOW,
			perOrgLimit: 2, // no maxBatchesPerOrg → default 1 = legacy single batch
		});
		expect(result.archived).toBe(2);
	});

	it("S5 homeostat: budget is bounded — stops at the batch ceiling (no thundering herd)", async () => {
		const { db, insertFact } = fixture();
		for (let i = 0; i < 10; i++) {
			insertFact({ id: `h${i}`, orgId: "org-a", createdAt: daysAgo(40 - i) });
		}
		// perOrgLimit 2 × budget 2 = exactly 4 drained; 6 remain for the next cycle.
		const result = await sweepExpiredProbationFacts(db, {
			now: NOW,
			perOrgLimit: 2,
			maxBatchesPerOrg: 2,
		});
		expect(result.archived).toBe(4);
	});

	it("dryRun reports candidates without archiving", async () => {
		const { db, insertFact, getFact } = fixture();
		insertFact({ id: "expired", createdAt: daysAgo(15) });

		const result = await sweepExpiredProbationFacts(db, {
			now: NOW,
			dryRun: true,
		});
		expect(result.dryRun).toBe(true);
		expect(result.archivedIds).toEqual(["expired"]);
		expect(getFact("expired").archived_at).toBeNull();
	});
});
