import { DatabaseSync } from "node:sqlite";
import { createDbClient } from "@tedix/db/client";
import { memoryEdges, memoryFacts } from "@tedix/db/schema/memory-graph";
import { tedis } from "@tedix/db/schema/tedis";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it } from "vite-plus/test";
import type { BaseContext } from "../../orpc";
import { issuePortableSnapshotTicket } from "../../../lib/portable-snapshot-ticket";
import {
	readPortableSnapshotPage,
	readPortableSnapshotPageForOrganization,
} from "./portable-snapshot";

const tediId = "a4d6765f-786b-446b-b9d1-3573b4330b9a";

function fixture(organizationId = "org-a") {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(schemaDdl(tedis, memoryFacts, memoryEdges));
	sqlite
		.prepare("INSERT INTO tedis(id,organization_id,name,slug) VALUES (?,?,?,?)")
		.run(tediId, organizationId, "Tedi A", "tedi-a");
	const insertFact = sqlite.prepare(
		"INSERT INTO memory_facts(id,organization_id,tedi_id,content,fact_type) VALUES (?,?,?,?,?)",
	);
	insertFact.run("own", organizationId, tediId, "Owned memory", "technical");
	insertFact.run("shared", organizationId, null, "Org memory", "technical");
	insertFact.run("foreign", "org-b", "other-tedi", "Foreign", "technical");
	const d1 = createD1Facade(sqlite);
	const db = createDbClient(d1);
	const context = {
		authType: "user",
		organizationId,
		db,
	} as BaseContext;
	return { sqlite, context, d1 };
}

describe("portable tedi snapshot API boundary", () => {
	it("requires a bearer before serving the bulk HTTP path", async () => {
		const { default: worker } = await import("../../../worker-app");
		const response = await worker.fetch(
			new Request(
				`https://api.tedix.dev/portable/tedis/${tediId}/snapshot/memoryFacts`,
			),
			{ API_URL: "https://api.tedix.dev" } as CloudflareEnv,
			{} as ExecutionContext,
		);
		expect(response.status).toBe(401);
	});

	it("serves only the signed tedi through the bulk HTTP path", async () => {
		const organizationId = "11111111-1111-4111-8111-111111111111";
		const { sqlite, d1 } = fixture(organizationId);
		try {
			const { default: worker } = await import("../../../worker-app");
			const issued = await issuePortableSnapshotTicket({
				secret: "test-master-key",
				organizationId,
				tediId,
				nowMs: Date.now(),
			});
			const response = await worker.fetch(
				new Request(
					`https://api.tedix.dev/portable/tedis/${tediId}/snapshot/memoryFacts?limit=500`,
					{ headers: { Authorization: `Bearer ${issued.token}` } },
				),
				{
					API_URL: "https://api.tedix.dev",
					SECRETS_MASTER_KEY: "test-master-key",
					DB: d1,
				} as CloudflareEnv,
				{} as ExecutionContext,
			);
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				section: "memoryFacts",
				rows: [{ id: "own", content: "Owned memory" }],
				nextAfterId: null,
			});
		} finally {
			sqlite.close();
		}
	});

	it("returns only the owned tedi's facts without source tenant IDs", async () => {
		const { sqlite, context } = fixture();
		try {
			const page = await readPortableSnapshotPage(context, {
				tediId,
				section: "memoryFacts",
			});
			expect(page.section).toBe("memoryFacts");
			expect(page.rows.map((row) => row.id)).toEqual(["own"]);
			expect(page.rows[0]).not.toHaveProperty("organizationId");
			expect(page.rows[0]).not.toHaveProperty("tediId");
		} finally {
			sqlite.close();
		}
	});

	it("preserves historical edge strengths above the current graph bound", async () => {
		const { sqlite, context } = fixture();
		try {
			sqlite
				.prepare(
					"INSERT INTO memory_facts(id,organization_id,tedi_id,content,fact_type) VALUES (?,?,?,?,?)",
				)
				.run("own-2", "org-a", tediId, "Another memory", "technical");
			sqlite
				.prepare(
					"INSERT INTO memory_edges(id,source_fact_id,target_fact_id,relation_type,strength) VALUES (?,?,?,?,?)",
				)
				.run("edge-one", "own", "own-2", "related_to", 1.1060336);
			const page = await readPortableSnapshotPage(context, {
				tediId,
				section: "memoryEdges",
			});
			expect(page.section).toBe("memoryEdges");
			expect(page.rows[0]?.strength).toBe(1.1060336);
		} finally {
			sqlite.close();
		}
	});

	it("serves a bounded bulk page beyond the Code Mode page limit", async () => {
		const { sqlite, context } = fixture();
		try {
			const insert = sqlite.prepare(
				"INSERT INTO memory_facts(id,organization_id,tedi_id,content,fact_type) VALUES (?,?,?,?,?)",
			);
			for (let index = 0; index < 120; index++) {
				insert.run(
					`own-${index}`,
					"org-a",
					tediId,
					`Memory ${index}`,
					"technical",
				);
			}
			const page = await readPortableSnapshotPageForOrganization(
				context.db,
				"org-a",
				{ tediId, section: "memoryFacts", limit: 500 },
			);
			expect(page.rows).toHaveLength(121);
			expect(page.nextAfterId).toBeNull();
			expect(page.rows.every((row) => !("organizationId" in row))).toBe(true);
		} finally {
			sqlite.close();
		}
	});

	it("rejects a different organization even when the tedi id is known", async () => {
		const { sqlite, context } = fixture();
		try {
			await expect(
				readPortableSnapshotPage(
					{ ...context, organizationId: "org-b" },
					{ tediId, section: "memoryFacts" },
				),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
		} finally {
			sqlite.close();
		}
	});

	it("rejects a tedi principal from the export data path", async () => {
		const { sqlite, context } = fixture();
		try {
			await expect(
				readPortableSnapshotPage(
					{ ...context, authType: "tedi" },
					{ tediId, section: "memoryFacts" },
				),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		} finally {
			sqlite.close();
		}
	});
});
