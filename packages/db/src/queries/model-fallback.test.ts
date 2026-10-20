import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { organizations } from "../schema/organizations";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { getOrganizationModelFallback } from "./model-fallback";

describe("organization fallback persistence", () => {
	it("scopes policy to one organization and preserves null inheritance", async () => {
		const sqlite = new DatabaseSync(":memory:");
		try {
			sqlite.exec(schemaDdl(organizations));
			const db = createDbClient(createD1Facade(sqlite));
			const policy = { version: 1 as const, maxTransitions: 0, ladder: {} };
			for (const id of ["fictional-a", "fictional-b"])
				await db.insert(organizations).values({
					id,
					name: id,
					slug: id,
					descopeTenantId: id,
					metadata: id === "fictional-a" ? { modelFallback: policy } : {},
				});
			expect(await getOrganizationModelFallback(db, "fictional-a")).toEqual(
				policy,
			);
			expect(await getOrganizationModelFallback(db, "fictional-b")).toBeNull();
			expect(await getOrganizationModelFallback(db, "missing")).toBeNull();
		} finally {
			sqlite.close();
		}
	});
});
