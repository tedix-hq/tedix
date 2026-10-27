import { describe, expect, it, vi } from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import { getWorkItemCommentById } from "@tedix/db/queries/work-items/comments";
import { workRoutingCommentId } from "@tedix/db/queries/work-items/work-routing";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { createMigratedSqlite } from "@tedix/db/test/migrated-sqlite";
import { routeOrganizationWork } from "./work-routing";

const T0 = "2026-10-26T08:00:00.000Z";
const NOW = "2026-10-27T08:00:00.000Z";
const WREN = "00000000-0000-4000-8000-0000000000c1";
const policy = {
	enabled: true,
	workKindStewards: { research: WREN },
	autoRoute: { enabled: true, maxPerRun: 1 },
};

function fixture() {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	sqlite.exec(`
		INSERT INTO organizations(id,name,slug) VALUES('orchard','Orchard','orchard');
		INSERT INTO tedis(id,organization_id,name,slug,status) VALUES('${WREN}','orchard','Wren','wren','active');
	`);
	const item = sqlite.prepare(
		"INSERT INTO work_items(id,org_id,title,description,disposition,work_kind,acceptance_contract,created_at,admission_spec_revision) VALUES(?,?,?,?,'accepted','research',?,?,'revision-1')",
	);
	const contract = JSON.stringify({ version: 1, doneLooksLike: "A memo" });
	item.run(
		"pay",
		"orchard",
		"Pay the supplier invoice",
		"Transfer the payment to the supplier today.",
		contract,
		T0,
	);
	item.run(
		"memo",
		"orchard",
		"Summarize competitor pricing pages",
		"Read the public pages and write a memo.",
		contract,
		"2026-10-26T08:01:00.000Z",
	);
	item.run(
		"memo2",
		"orchard",
		"Summarize partner newsletters",
		null,
		contract,
		"2026-10-26T08:02:00.000Z",
	);
	const db = createDbClient(createD1Facade(sqlite));
	const send = vi.fn(async (_request: Request) =>
		Response.json({ accepted: true, run_id: "run-memo" }),
	);
	const route = () =>
		routeOrganizationWork(db, {
			orgId: "orchard",
			policy,
			now: NOW,
			environment: "production",
			send,
		});
	return { db, send, route };
}

describe("work routing", () => {
	it("delegates waiting Work to its steward once and records the run", async () => {
		const { db, send, route } = fixture();

		expect(await route()).toEqual({ delegated: 1, reserved: 1 });
		expect(send).toHaveBeenCalledTimes(1);
		const request = send.mock.calls[0]![0];
		expect(request.headers.get("X-Tedix-Host")).toBe("wren.tedi.tedix.dev");
		const body = (await request.json()) as {
			session_key: string;
			client_request_id: string;
			text: string;
		};
		expect(body).toMatchObject({
			session_key: "work:memo",
			client_request_id: "work-routing:memo",
		});
		expect(body.text).toContain("Summarize competitor pricing pages");

		const delegated = await getWorkItemCommentById(
			db,
			workRoutingCommentId("memo"),
		);
		expect(delegated).toMatchObject({
			authorType: "system",
			body: expect.stringContaining("Run run-memo"),
			metadata: expect.objectContaining({
				outcome: "delegated",
				tediId: WREN,
				runId: "run-memo",
			}),
		});
		const skipped = await getWorkItemCommentById(
			db,
			workRoutingCommentId("pay"),
		);
		expect(skipped?.metadata).toMatchObject({
			outcome: "skipped",
			reservedClasses: expect.arrayContaining(["money"]),
		});

		// The per-run cap held memo2 back; the next run takes it, and nothing repeats.
		expect(await route()).toEqual({ delegated: 1, reserved: 0 });
		expect(await route()).toEqual({ delegated: 0, reserved: 0 });
		expect(send).toHaveBeenCalledTimes(2);
	});

	it("does nothing when the policy leaves routing off", async () => {
		const { send, db } = fixture();
		expect(
			await routeOrganizationWork(db, {
				orgId: "orchard",
				policy: { ...policy, autoRoute: { enabled: false } },
				now: NOW,
				environment: "production",
				send,
			}),
		).toEqual({ delegated: 0, reserved: 0 });
		expect(send).not.toHaveBeenCalled();
	});
});
