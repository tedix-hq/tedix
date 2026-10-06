import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { createD1Facade } from "../test/d1-facade";
import { canonicalWorkFactoryDdl } from "../test/schema-ddl";
import { getOrgGraphHealth } from "./org-graph-health";

const NOW = "2026-08-20T12:00:00.000Z";
function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(canonicalWorkFactoryDdl());
	// Graph-health deliberately exercises orphan and cross-scope detection, so
	// fixtures must be able to represent coherence defects that normal writes reject.
	sqlite.exec("PRAGMA foreign_keys = OFF");
	const seed = (
		id: string,
		disposition = "accepted",
		org = "org",
		projectId: string | null = null,
		owner: string | null = null,
	) =>
		sqlite
			.prepare(
				"INSERT INTO work_items(id,org_id,title,disposition,project_id,accountable_owner_type,accountable_owner_id,created_at,accepted_at) VALUES(?,?,?,?,?,'tedi',?,?,?)",
			)
			.run(
				id,
				org,
				id,
				disposition,
				projectId,
				owner,
				NOW,
				disposition === "accepted" ? NOW : null,
			);
	const edge = (from: string, to: string, org = "org") =>
		sqlite
			.prepare(
				"INSERT INTO work_item_relations(id,org_id,from_work_item_id,to_work_item_id,relation_type,created_at) VALUES(?,?,?,?,\'blocks\',?)",
			)
			.run(`${org}:${from}:${to}`, org, from, to, NOW);
	return {
		sqlite,
		db: createDbQueryClient(createD1Facade(sqlite)),
		seed,
		edge,
	};
}

describe("canonical organization work graph", () => {
	it("finds a chain head and transitive downstream impact", async () => {
		const { db, seed, edge } = fixture();
		for (const id of ["a", "b", "c"]) seed(id);
		edge("a", "b");
		edge("b", "c");
		const report = await getOrgGraphHealth(db, { orgId: "org", now: NOW });
		expect(report.rootBlockers).toMatchObject([
			{ id: "a", disposition: "accepted", downstreamBlockedCount: 2 },
		]);
		expect(report.counts.blockedCount).toBe(2);
	});

	it.each(["completed", "cancelled"])(
		"excludes a %s blocker from the live graph",
		async (disposition) => {
			const { db, seed, edge } = fixture();
			seed("a", disposition);
			seed("b");
			edge("a", "b");
			expect(
				(await getOrgGraphHealth(db, { orgId: "org", now: NOW })).rootBlockers,
			).toEqual([]);
		},
	);

	it("counts a diamond descendant once", async () => {
		const { db, seed, edge } = fixture();
		for (const id of ["a", "b", "c", "d"]) seed(id);
		edge("a", "b");
		edge("a", "c");
		edge("b", "d");
		edge("c", "d");
		expect(
			(await getOrgGraphHealth(db, { orgId: "org", now: NOW })).rootBlockers[0]
				?.downstreamBlockedCount,
		).toBe(3);
	});

	it("bounds cycles downstream of a root", async () => {
		const { db, seed, edge } = fixture();
		for (const id of ["root", "a", "b"]) seed(id);
		edge("root", "a");
		edge("a", "b");
		edge("b", "a");
		expect(
			(await getOrgGraphHealth(db, { orgId: "org", now: NOW })).rootBlockers[0],
		).toMatchObject({ id: "root", downstreamBlockedCount: 2 });
	});

	it("returns no roots for a pure cycle", async () => {
		const { db, seed, edge } = fixture();
		seed("a");
		seed("b");
		edge("a", "b");
		edge("b", "a");
		expect(
			(await getOrgGraphHealth(db, { orgId: "org", now: NOW })).rootBlockers,
		).toEqual([]);
	});

	it("aggregates blocker impact by accountable owner", async () => {
		const { db, seed, edge } = fixture();
		seed("a", "accepted", "org", null, "owner");
		seed("b");
		seed("x", "accepted", "org", null, "owner");
		seed("y");
		edge("a", "b");
		edge("x", "y");
		expect(
			(await getOrgGraphHealth(db, { orgId: "org", now: NOW })).blockerTedis,
		).toEqual([{ tediId: "owner", rootBlockerCount: 2, downstreamImpact: 2 }]);
	});

	it("is organization scoped", async () => {
		const { db, seed, edge } = fixture();
		seed("a", "accepted", "other");
		seed("b", "accepted", "other");
		edge("a", "b", "other");
		expect(
			(await getOrgGraphHealth(db, { orgId: "org", now: NOW })).counts
				.totalNonTerminal,
		).toBe(0);
	});

	it("is project-id scoped without a free-text project compatibility path", async () => {
		const { db, seed, edge } = fixture();
		seed("a", "accepted", "org", "p1");
		seed("b", "accepted", "org", "p1");
		seed("x", "accepted", "org", "p2");
		seed("y", "accepted", "org", "p2");
		edge("a", "b");
		edge("x", "y");
		const report = await getOrgGraphHealth(db, {
			orgId: "org",
			projectId: "p1",
			now: NOW,
		});
		expect(report.rootBlockers.map((row) => row.id)).toEqual(["a"]);
	});

	it("honors the root result limit while retaining full counts", async () => {
		const { db, seed, edge } = fixture();
		for (const id of ["a", "b", "x", "y"]) seed(id);
		edge("a", "b");
		edge("x", "y");
		const report = await getOrgGraphHealth(db, {
			orgId: "org",
			limit: 1,
			now: NOW,
		});
		expect(report.rootBlockers).toHaveLength(1);
		expect(report.counts.rootBlockerCount).toBe(2);
	});

	it("reports capability projection absence honestly", async () => {
		const { db } = fixture();
		const report = await getOrgGraphHealth(db, { orgId: "org", now: NOW });
		expect(report.capabilityLinksAvailable).toBe(false);
		expect(report.notes[0]).toContain("no capability");
	});
});
