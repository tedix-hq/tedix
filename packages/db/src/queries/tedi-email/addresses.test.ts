import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import { createD1Facade } from "../../test/d1-facade";
import {
	deleteTediEmailAddress,
	getTediEmailAddressById,
	updateTediEmailAddressStatus,
} from "./addresses";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE tedi_email_addresses (
			id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, tedi_id TEXT NOT NULL,
			address TEXT NOT NULL UNIQUE, local_part TEXT NOT NULL, domain TEXT NOT NULL,
			kind TEXT NOT NULL DEFAULT 'primary', status TEXT NOT NULL DEFAULT 'active',
			routing_policy TEXT, created_by TEXT,
			created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
		);
		INSERT INTO tedi_email_addresses (id, organization_id, tedi_id, address, local_part, domain, kind, status)
		VALUES ('addr-1', 'org-1', 'tedi-1', 'worker@tedix.tech', 'worker', 'tedix.tech', 'primary', 'reserved');
	`);
	return { db: createDbClient(createD1Facade(sqlite)) };
}

describe("tedi email address tenant-scoped writes", () => {
	it("updates routing policy without touching status when status is omitted", async () => {
		const { db } = fixture();
		const row = await updateTediEmailAddressStatus(db, {
			id: "addr-1",
			tediId: "tedi-1",
			organizationId: "org-1",
			routingPolicy: { allowedSenders: ["@example.com"] },
		});
		expect(row).toMatchObject({
			status: "reserved",
			routingPolicy: { allowedSenders: ["@example.com"] },
		});
	});

	it("deletes only inside the owning tedi and organization", async () => {
		const { db } = fixture();
		await expect(
			deleteTediEmailAddress(db, {
				id: "addr-1",
				tediId: "tedi-1",
				organizationId: "org-9",
			}),
		).resolves.toBeNull();
		await expect(
			deleteTediEmailAddress(db, {
				id: "addr-1",
				tediId: "tedi-1",
				organizationId: "org-1",
			}),
		).resolves.toMatchObject({ id: "addr-1", address: "worker@tedix.tech" });
		await expect(getTediEmailAddressById(db, "addr-1")).resolves.toBeNull();
	});
});
