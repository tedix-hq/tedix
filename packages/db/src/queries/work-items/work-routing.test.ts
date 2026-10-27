import { WorkStewardshipPolicySchema } from "@tedix/api-contract/schemas/work-stewardship";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { createMigratedSqlite } from "../../test/migrated-sqlite";
import {
	listRoutableWork,
	listWorkRoutingOrgs,
	recordWorkRouting,
} from "./work-routing";

const T0 = "2026-10-26T08:00:00.000Z";
const NOW = "2026-10-27T08:00:00.000Z";
const CMO = "00000000-0000-4000-8000-0000000000c1";
const LEAD = "00000000-0000-4000-8000-0000000000c2";
const RETIRED = "00000000-0000-4000-8000-0000000000c3";
const PROJECT = "00000000-0000-4000-8000-0000000000a1";

const policy = WorkStewardshipPolicySchema.parse({
	enabled: true,
	workKindStewards: { research: CMO },
	autoRoute: { enabled: true },
});

function seed() {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	sqlite.exec("DROP TRIGGER work_attempt_admission_insert_guard");
	sqlite.exec(`
		INSERT INTO organizations(id,name,slug,metadata) VALUES('orchard','Orchard','orchard','${JSON.stringify({ workStewardship: policy })}');
		INSERT INTO organizations(id,name,slug,metadata) VALUES('meadow','Meadow','meadow','{"workStewardship":{"enabled":true}}');
		INSERT INTO tedis(id,organization_id,name,slug,status) VALUES('${CMO}','orchard','Wren','wren','active');
		INSERT INTO tedis(id,organization_id,name,slug,status) VALUES('${LEAD}','orchard','Lark','lark','active');
		INSERT INTO tedis(id,organization_id,name,slug,status,retired_at) VALUES('${RETIRED}','orchard','Old','old','active','${T0}');
		INSERT INTO projects(id,org_id,key,name,lead_tedi_id,created_at) VALUES('${PROJECT}','orchard','GROW','Growth','${LEAD}','${T0}');
	`);
	const item = sqlite.prepare(
		"INSERT INTO work_items(id,org_id,title,disposition,work_kind,project_id,steward_type,steward_id,start_at,acceptance_contract,metadata,created_at,admission_spec_revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'revision-1')",
	);
	let minute = 0;
	const done = JSON.stringify({ version: 1, doneLooksLike: "A short memo" });
	const add = (
		id: string,
		overrides: Partial<{
			disposition: string;
			kind: string;
			project: string | null;
			steward: string | null;
			startAt: string | null;
			contract: string | null;
			metadata: string;
		}> = {},
	) =>
		item.run(
			id,
			"orchard",
			`Item ${id}`,
			overrides.disposition ?? "accepted",
			overrides.kind ?? "research",
			overrides.project ?? null,
			overrides.steward ? "tedi" : null,
			overrides.steward ?? null,
			overrides.startAt ?? null,
			overrides.contract === undefined ? done : overrides.contract,
			overrides.metadata ?? "{}",
			new Date(Date.parse(T0) + minute++ * 60_000).toISOString(),
		);
	add("a-kind");
	add("b-lead", { kind: "document", project: PROJECT });
	add("c-steward", { kind: "document", steward: CMO });
	add("coding", { kind: "coding" });
	add("executor", { metadata: '{"executor":"codex"}' });
	add("nodone", { contract: null });
	add("later", { startAt: "2026-10-28T08:00:00.000Z" });
	add("proposed", { disposition: "proposed" });
	add("retired", { steward: RETIRED });
	add("noroute", { kind: "operations" });
	add("live");
	sqlite
		.prepare(
			"INSERT INTO work_attempts(id,work_item_id,org_id,executor_type,executor_id,runtime_state,attempt_number,started_at,heartbeat_at) VALUES(?,?,?,?,?,?,?,?,?)",
		)
		.run("att", "live", "orchard", "tedi", CMO, "running", 1, T0, T0);
	return createDbQueryClient(createD1Facade(sqlite));
}

describe("work routing queries", () => {
	it("lists only organizations that turned automatic routing on", async () => {
		const db = seed();
		expect(await listWorkRoutingOrgs(db)).toEqual([
			{ orgId: "orchard", policy: expect.objectContaining({ enabled: true }) },
		]);
	});

	it("returns waiting non-coding Work with the tedi that stewards it", async () => {
		const db = seed();
		const rows = await listRoutableWork(db, {
			orgId: "orchard",
			policy,
			now: NOW,
			limit: 25,
		});
		expect(
			Object.fromEntries(rows.map((row) => [row.id, row.tediSlug])),
		).toEqual({ "a-kind": "wren", "b-lead": "lark", "c-steward": "wren" });
		expect(rows.find((row) => row.id === "a-kind")).toMatchObject({
			doneWhen: "A short memo",
			workKind: "research",
			tediId: CMO,
			tediName: "Wren",
		});
	});

	it("records one routing comment and then leaves the item alone", async () => {
		const db = seed();
		const first = await recordWorkRouting(db, {
			orgId: "orchard",
			workItemId: "a-kind",
			body: "Delegated",
			metadata: { outcome: "delegated", runId: "run-1" },
			now: NOW,
		});
		const again = await recordWorkRouting(db, {
			orgId: "orchard",
			workItemId: "a-kind",
			body: "Delegated again",
			metadata: { outcome: "delegated", runId: "run-2" },
			now: NOW,
		});
		expect(first.inserted).toBe(true);
		expect(again).toMatchObject({ inserted: false });
		expect(again.comment.metadata).toMatchObject({
			source: "work-routing",
			runId: "run-1",
		});
		const rows = await listRoutableWork(db, {
			orgId: "orchard",
			policy,
			now: NOW,
			limit: 25,
		});
		expect(rows.map((row) => row.id)).toEqual(["b-lead", "c-steward"]);
	});
});
