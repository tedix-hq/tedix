import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { auditEvents } from "../schema/audit-events";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { insertAuditEvent } from "./audit";
import { getPersonalRequestConsent } from "./personal-request-consent";

describe("personal request consent admission evidence", () => {
	it("pins a request to its first human and refuses cross-org and machine audit rows", async () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec(schemaDdl(auditEvents));
		const db = createDbClient(createD1Facade(sqlite));
		const row = {
			id: "personal-request:org-1:root",
			organizationId: "org-1",
			actorId: "first-human",
			actorType: "user" as const,
			action: "personal.request.admitted",
			resourceType: "run",
			resourceId: "root",
			ignoreDuplicates: true,
		};
		try {
			await insertAuditEvent(db, row);
			await insertAuditEvent(db, { ...row, actorId: "second-human" });
			expect(
				(await getPersonalRequestConsent(db, "org-1", "root"))?.actorId,
			).toBe("first-human");
			expect(
				await getPersonalRequestConsent(db, "org-2", "root"),
			).toBeUndefined();
			await insertAuditEvent(db, {
				...row,
				id: "personal-request:org-1:machine",
				actorType: "tedi",
			});
			expect(
				await getPersonalRequestConsent(db, "org-1", "machine"),
			).toBeUndefined();
		} finally {
			sqlite.close();
		}
	});
});
