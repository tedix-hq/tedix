import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { organizations } from "../schema/organizations";
import { auditEvents } from "../schema/audit-events";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { updateOrganization } from "./organizations";

describe("organization setting and audit atomicity", () => {
	it.each([false, true])(
		"commits both rows or rolls both back when audit fails=%s",
		async (fail) => {
			const sqlite = new DatabaseSync(":memory:");
			try {
				sqlite.exec("PRAGMA foreign_keys = OFF");
				sqlite.exec(schemaDdl(organizations, auditEvents));
				sqlite.exec(
					"INSERT INTO organizations (id, name, slug, metadata) VALUES ('org-1', 'Example', 'example', '{}')",
				);
				if (fail)
					sqlite.exec(
						"CREATE TRIGGER reject_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
					);
				const db = createDbClient(createD1Facade(sqlite));
				const change = updateOrganization(
					db,
					"org-1",
					{ metadata: { sensitiveDataEgressApproval: true } },
					{
						organizationId: "org-1",
						actorId: "admin-1",
						actorType: "user",
						action: "organization.sensitive_data_egress_approval_changed",
						resourceType: "organization",
						resourceId: "org-1",
						metadata: { previousValue: false, enabled: true },
					},
				);
				if (fail) await expect(change).rejects.toThrow();
				else await change;
				const row = sqlite
					.prepare("SELECT metadata FROM organizations WHERE id = 'org-1'")
					.get() as { metadata: string };
				expect(
					JSON.parse(row.metadata).sensitiveDataEgressApproval === true,
				).toBe(!fail);
				expect(
					sqlite.prepare("SELECT count(*) AS n FROM audit_events").get()?.n,
				).toBe(fail ? 0 : 1);
			} finally {
				sqlite.close();
			}
		},
	);
});
