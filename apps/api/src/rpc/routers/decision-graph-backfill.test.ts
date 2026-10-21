import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { organizations } from "@tedix/db/schema/organizations";
import { workItems } from "@tedix/db/schema/work-items";
import { workInteractions } from "@tedix/db/schema/work-factory";
import { decisionEdges } from "@tedix/db/schema/decision-graph";
import { describe, expect, it } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { decisionGraphContractRouter } from "./decision-graph";

it("restricts preview to admins, enforces page/tenant bounds and never writes", async () => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		schemaDdl(organizations, workItems, workInteractions, decisionEdges),
	);
	sqlite.exec("PRAGMA foreign_keys = OFF");
	const db = createDbClient(createD1Facade(sqlite));
	const orgId = "fictional-harbor";
	await db
		.insert(organizations)
		.values({ id: orgId, name: "Harbor", slug: "harbor" });
	await db.insert(workInteractions).values({
		id: "card-a",
		orgId,
		projectId: "project-a",
		kind: "question",
		subject: "Review",
		prompt: "Review",
		creatorType: "system",
		creatorId: "deck",
		targetType: "user",
		targetId: "person-river",
		createdAt: "2026-06-01T10:00:00Z",
	});
	const client = (role: string, machineScope?: string) =>
		createRouterClient(decisionGraphContractRouter, {
			context: {
				db,
				organizationId: orgId,
				authType: machineScope ? "apikey" : "user",
				apiKey: machineScope
					? { id: "test-key", scopes: [machineScope] }
					: undefined,
				user: { sub: "person-river" },
				userRole: role,
				headers: new Headers(),
				url: new URL("https://api.example.test/rpc"),
				env: {},
			} as BaseContext,
		});
	try {
		await expect(client("member").backfillPreview({})).rejects.toThrow();
		await expect(
			client("owner", "mcp:messaging.read").backfillPreview({}),
		).rejects.toThrow();
		const result = await client("owner").backfillPreview({});
		expect(result.scanned).toBe(1);
		expect(result.counts.involves).toBe(1);
		expect(
			(await client("owner", "mcp:memory.admin").backfillPreview({})).counts,
		).toEqual(result.counts);
		await expect(
			client("owner").backfillPreview({ limit: 51 }),
		).rejects.toThrow();
		await expect(
			client("owner").backfillPreview({
				cursor: {
					organizationId: "fictional-ridge",
					phase: "cards",
					afterId: "",
				},
			}),
		).rejects.toThrow("another organization");
		await expect(
			client("owner").backfillPreview({ dryRun: false } as never),
		).rejects.toThrow();
		expect(
			sqlite.prepare("SELECT count(*) AS n FROM decision_edges").get()?.n,
		).toBe(0);
	} finally {
		sqlite.close();
	}
});
