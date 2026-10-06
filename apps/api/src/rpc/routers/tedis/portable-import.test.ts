import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { memoryDomains } from "@tedix/db/schema/memory-graph";
import { tedis } from "@tedix/db/schema/tedis";
import { issuePortableImportTicket } from "../../../lib/portable-import-ticket";

const organizationId = "11111111-1111-4111-8111-111111111111";
const tediId = "22222222-2222-4222-8222-222222222222";
const sourceTediId = "33333333-3333-4333-8333-333333333333";
const manifestSha256 = "a".repeat(64);

describe("portable tedi import HTTP boundary", () => {
	it("requires the signed destination and manifest bearer", async () => {
		const { default: worker } = await import("../../../worker-app");
		const response = await worker.fetch(
			new Request(
				`https://api.tedix.dev/portable/tedis/${tediId}/import/memoryDomains`,
				{
					method: "POST",
					body: JSON.stringify({ section: "memoryDomains", rows: [] }),
				},
			),
			{ API_URL: "https://api.tedix.dev" } as CloudflareEnv,
			{} as ExecutionContext,
		);
		expect(response.status).toBe(401);
	});

	it("writes only into a paused tedi in the ticket's organization", async () => {
		const sqlite = new DatabaseSync(":memory:");
		try {
			sqlite.exec("PRAGMA foreign_keys=OFF");
			sqlite.exec(schemaDdl(tedis, memoryDomains));
			sqlite
				.prepare(
					"INSERT INTO tedis(id,organization_id,name,slug,status) VALUES (?,?,?,?,?)",
				)
				.run(tediId, organizationId, "New worker", "new-worker", "paused");
			const { default: worker } = await import("../../../worker-app");
			const ticket = await issuePortableImportTicket({
				secret: "test-master-key",
				organizationId,
				tediId,
				sourceTediId,
				manifestSha256,
				nowMs: Date.now(),
			});
			const request = (manifest = manifestSha256) =>
				new Request(
					`https://api.tedix.dev/portable/tedis/${tediId}/import/memoryDomains`,
					{
						method: "POST",
						headers: {
							Authorization: `Bearer ${ticket.token}`,
							"X-Tedix-Portable-Manifest": manifest,
							"Content-Type": "application/json",
						},
						body: JSON.stringify({
							section: "memoryDomains",
							rows: [
								{ id: "source-domain", name: "Knowledge", parentId: null },
							],
						}),
					},
				);
			const env = {
				API_URL: "https://api.tedix.dev",
				SECRETS_MASTER_KEY: "test-master-key",
				DB: createD1Facade(sqlite),
			} as CloudflareEnv;
			expect(
				(
					await worker.fetch(
						request("b".repeat(64)),
						env,
						{} as ExecutionContext,
					)
				).status,
			).toBe(401);
			const response = await worker.fetch(
				request(),
				env,
				{} as ExecutionContext,
			);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ acceptedRows: 1 });
			expect(
				sqlite.prepare("SELECT organization_id,name FROM memory_domains").get(),
			).toEqual({
				organization_id: organizationId,
				name: "new-worker/Knowledge",
			});
			sqlite.prepare("UPDATE tedis SET status='active' WHERE id=?").run(tediId);
			expect(
				(await worker.fetch(request(), env, {} as ExecutionContext)).status,
			).toBe(409);
		} finally {
			sqlite.close();
		}
	});
});
