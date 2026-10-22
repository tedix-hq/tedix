import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { createD1Facade } from "../test/d1-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import { listDispatcherAttemptCaptureOrganizations } from "./kernel-requests";

const SINCE = "2026-10-21T12:00:00.000Z";
const SETTLED = "2026-10-21T13:00:00.000Z";

function seed(orgs: { id: string; delivery: boolean | null }[]) {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	// Admission machinery is out of scope here; only the settled attempt matters.
	sqlite.exec("DROP TRIGGER work_attempt_admission_insert_guard");
	const org = sqlite.prepare(
		"INSERT INTO organizations(id,name,slug) VALUES(?,?,?)",
	);
	const item = sqlite.prepare(
		"INSERT INTO work_items(id,org_id,title,disposition,created_at,admission_spec_revision) VALUES(?,?,'Work','accepted',?,'revision-1')",
	);
	const attempt = sqlite.prepare(
		`INSERT INTO work_attempts(id,work_item_id,org_id,executor_type,executor_id,runtime_state,outcome,attempt_number,started_at,heartbeat_at,expires_at,finished_at,metadata)
		 VALUES(?,?,?,'tedi','lane','finished','succeeded',1,?,?,?,?,'{"dispatchVersion":1}')`,
	);
	const pack = sqlite.prepare(
		"INSERT INTO policy_packs(id,organization_id,name,slug,status,version,definition) VALUES(?,?,'Policy',?,'active',1,?)",
	);
	for (const { id, delivery } of orgs) {
		org.run(id, id, id);
		item.run(`work-${id}`, id, SINCE);
		attempt.run(
			`attempt-${id}`,
			`work-${id}`,
			id,
			SINCE,
			SETTLED,
			SETTLED,
			SETTLED,
		);
		if (delivery !== null)
			pack.run(
				`pack-${id}`,
				id,
				`policy-${id}`,
				JSON.stringify({
					kernelRequestCoordinator: delivery
						? {
								enabled: true,
								workAttemptDelivery: { observerProjectId: "project" },
							}
						: { enabled: true },
				}),
			);
	}
	return createDbQueryClient(createD1Facade(sqlite));
}

describe("listDispatcherAttemptCaptureOrganizations", () => {
	it("lists only organizations that opted into delivery verification", async () => {
		const db = seed([
			{ id: "org-a", delivery: null },
			{ id: "org-b", delivery: false },
			{ id: "org-c", delivery: null },
			{ id: "org-d", delivery: false },
			{ id: "org-e", delivery: null },
			{ id: "org-f", delivery: null },
			{ id: "org-z", delivery: true },
		]);
		expect(await listDispatcherAttemptCaptureOrganizations(db, SINCE)).toEqual([
			{ organizationId: "org-z" },
		]);
	});
});
