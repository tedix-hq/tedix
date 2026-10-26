import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { createD1Facade } from "../test/d1-facade";
import {
	createConnectionProviderOwnership,
	deleteConnectionProviderOwnership,
	getConnectionProviderOwnershipForOrganization,
	listConnectionProviderSettings,
	setConnectionProviderAccountMode,
} from "./connection-providers";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`PRAGMA foreign_keys = ON;
 CREATE TABLE organizations (id TEXT PRIMARY KEY);
 INSERT INTO organizations VALUES ('org-a'), ('org-b');
 CREATE TABLE connection_provider_ownership (app_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
 CREATE TABLE connection_provider_settings (organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, provider_id TEXT NOT NULL, account_mode TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (organization_id, provider_id));`);
	return { sqlite, db: createDbQueryClient(createD1Facade(sqlite)) };
}
describe("provider ownership on D1", () => {
	it("scopes exact app ids to the owning org and cannot transfer an existing owner", async () => {
		const { sqlite, db } = fixture();
		try {
			await createConnectionProviderOwnership(db, {
				appId: "own",
				organizationId: "org-a",
			});
			await createConnectionProviderOwnership(db, {
				appId: "own",
				organizationId: "org-b",
			});
			expect(
				await getConnectionProviderOwnershipForOrganization(db, "own", "org-a"),
			).toMatchObject({ appId: "own", organizationId: "org-a" });
			expect(
				await getConnectionProviderOwnershipForOrganization(db, "own", "org-b"),
			).toBeUndefined();
			expect(
				await getConnectionProviderOwnershipForOrganization(
					db,
					"legacy",
					"org-a",
				),
			).toBeUndefined();
			await deleteConnectionProviderOwnership(db, "own");
			expect(
				await getConnectionProviderOwnershipForOrganization(db, "own", "org-a"),
			).toBeUndefined();
		} finally {
			sqlite.close();
		}
	});
	it("requires a real organization and removes ownership when it is deleted", async () => {
		const { sqlite, db } = fixture();
		try {
			await expect(
				createConnectionProviderOwnership(db, {
					appId: "bad",
					organizationId: "missing",
				}),
			).rejects.toThrow();
			await createConnectionProviderOwnership(db, {
				appId: "own",
				organizationId: "org-a",
			});
			sqlite.exec("DELETE FROM organizations WHERE id='org-a'");
			expect(
				await getConnectionProviderOwnershipForOrganization(db, "own", "org-a"),
			).toBeUndefined();
		} finally {
			sqlite.close();
		}
	});
});

describe("provider account settings on D1", () => {
	it("upserts account mode within one organization", async () => {
		const { sqlite, db } = fixture();
		try {
			await setConnectionProviderAccountMode(db, {
				organizationId: "org-a",
				providerId: "calendar",
				accountMode: "single",
			});
			await setConnectionProviderAccountMode(db, {
				organizationId: "org-a",
				providerId: "calendar",
				accountMode: "multiple",
			});
			await setConnectionProviderAccountMode(db, {
				organizationId: "org-b",
				providerId: "calendar",
				accountMode: "single",
			});

			expect(await listConnectionProviderSettings(db, "org-a")).toEqual([
				expect.objectContaining({
					organizationId: "org-a",
					providerId: "calendar",
					accountMode: "multiple",
				}),
			]);
			expect(await listConnectionProviderSettings(db, "org-b")).toEqual([
				expect.objectContaining({ accountMode: "single" }),
			]);
		} finally {
			sqlite.close();
		}
	});
});
