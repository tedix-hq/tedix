import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { createD1Facade } from "../test/d1-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import { getDecisionLabelEvidence } from "./decision-learning";

const params = {
	organizationId: "org-example",
	actorId: "ada",
	cardId: "card-example",
	receiptId: "receipt-example",
	exposureId: "exposure-example",
	decidedAt: "2026-01-01T00:00:00Z",
	until: "2026-01-03T00:00:00Z",
};

function fixture() {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	const event = sqlite.prepare(`INSERT INTO learning_interaction_events
		(id,organization_id,actor_type,client_event_id,event_kind,scope_kind,scope_id,surface,target_id,occurred_at)
		VALUES (?,?,'user',?,'accepted','personal','ada','decision_capture',?,'2026-01-02')`);
	const fact = sqlite.prepare(`INSERT INTO memory_facts
		(id,organization_id,content,fact_type,tedi_id,visibility,metadata,created_at,archived_at,valid_to)
		VALUES (?,?,'Example lesson','knowledge',?,?,?,?,?,?)`);
	return {
		sqlite,
		event(id: string, org = params.organizationId, target = params.cardId) {
			event.run(id, org, id, target);
		},
		fact(
			id: string,
			options: {
				org?: string;
				owner?: string;
				evidence?: string[] | null;
				tedi?: string | null;
				visibility?: string;
				at?: string;
				archived?: string | null;
				validTo?: string | null;
			} = {},
		) {
			fact.run(
				id,
				options.org ?? params.organizationId,
				options.tedi ?? null,
				options.visibility ?? "private",
				JSON.stringify({
					learningFeed: {
						ownerUserId: options.owner,
						evidenceEventIds: options.evidence,
					},
				}),
				options.at ?? "2026-01-02T00:00:00Z",
				options.archived ?? null,
				options.validTo ?? null,
			);
		},
	};
}

it("keeps complete historical evidence and the existing tenant, owner and date fences", async () => {
	const f = fixture();
	f.event("matching");
	f.event("wrong-target", params.organizationId, "another-card");
	f.event("foreign", "org-other");
	for (const id of [
		"owned",
		"duplicates",
		"archived",
		"invalidated",
		"at-until",
	])
		f.fact(id, {
			owner: "ada",
			evidence: id === "duplicates" ? ["matching", "matching"] : ["matching"],
			archived: id === "archived" ? "2026-01-02" : null,
			validTo: id === "invalidated" ? "2026-01-02" : null,
			at: id === "at-until" ? params.until : undefined,
		});
	f.fact("legacy-human", { evidence: ["matching"] });
	f.fact("org-shared", {
		owner: "grace",
		visibility: "org",
		evidence: ["matching"],
	});
	f.fact("private-other", {
		owner: "grace",
		tedi: "worker",
		evidence: ["matching"],
	});
	f.fact("foreign-fact", {
		org: "org-other",
		owner: "ada",
		evidence: ["matching"],
	});
	f.fact("foreign-evidence", { owner: "ada", evidence: ["foreign"] });
	f.fact("other-target", { owner: "ada", evidence: ["wrong-target"] });
	f.fact("missing-evidence", { owner: "ada" });
	f.fact("empty-evidence", { owner: "ada", evidence: [] });
	f.fact("null-evidence", { owner: "ada", evidence: null });
	f.fact("at-decision", {
		owner: "ada",
		evidence: ["matching"],
		at: params.decidedAt,
	});
	f.fact("after-until", {
		owner: "ada",
		evidence: ["matching"],
		at: "2026-01-04",
	});
	const db = createDbQueryClient(createD1Facade(f.sqlite));
	const evidence = await getDecisionLabelEvidence(db, params);
	expect(evidence.lessons.map((row) => row.id).sort()).toEqual([
		"archived",
		"at-until",
		"duplicates",
		"invalidated",
		"legacy-human",
		"org-shared",
		"owned",
	]);
});

it("does not rescan all tenant events for every fact without evidence", async () => {
	const f = fixture();
	for (let i = 0; i < 500; i++) f.event(`event-${i}`);
	for (let i = 0; i < 200; i++) f.fact(`fact-${i}`);
	let evidenceReads = 0;
	f.sqlite.function("observe_evidence", (value) => {
		evidenceReads++;
		return value;
	});
	const plans: string[] = [];
	const db = createDbQueryClient(
		createD1Facade({
			prepare(query) {
				if (query.includes('from "memory_facts"')) {
					// Count actual SQLite evidence-array evaluations while keeping its native JSON functions.
					query = query.replace(
						'json_each(json_extract("memory_facts"."metadata",\'$.learningFeed.evidenceEventIds\'))',
						'json_each(observe_evidence(json_extract("memory_facts"."metadata",\'$.learningFeed.evidenceEventIds\')))',
					);
					plans.push(
						...f.sqlite
							.prepare(`EXPLAIN QUERY PLAN ${query}`)
							.all(...Array((query.match(/\?/g) ?? []).length).fill(null))
							.map((row) => String(row.detail)),
					);
				}
				return f.sqlite.prepare(query);
			},
			exec: (query) => f.sqlite.exec(query),
		}),
	);
	expect((await getDecisionLabelEvidence(db, params)).lessons).toEqual([]);
	expect(evidenceReads).toBe(200);
	expect(plans).toContainEqual(expect.stringMatching(/LIST SUBQUERY/));
});
