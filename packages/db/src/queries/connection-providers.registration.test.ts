import { DatabaseSync } from "node:sqlite";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { connectionProviders } from "../schema/connection-providers";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { recordConnectionProviderRegistration } from "./connection-providers";

const exception = {
	justification: "Upstream offers no client ID metadata document support.",
	reviewBy: "2027-01-31",
	recordedAt: "2026-10-26T12:00:00.000Z",
	recordedBy: "U_example",
};

function setup() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(schemaDdl(connectionProviders));
	return createDbClient(createD1Facade(sqlite));
}

async function read(db: ReturnType<typeof setup>, id: string) {
	const [row] = await db
		.select({
			name: connectionProviders.name,
			registrationProvenance: connectionProviders.registrationProvenance,
			dcrException: connectionProviders.dcrException,
		})
		.from(connectionProviders)
		.where(eq(connectionProviders.id, id));
	return row;
}

describe("recordConnectionProviderRegistration", () => {
	it("records a DCR exception, then clears it when the provider moves to CIMD", async () => {
		const db = setup();
		await recordConnectionProviderRegistration(db, {
			id: "example-mcp",
			name: "Example MCP",
			provenance: "dcr_direct",
			dcrException: exception,
		});
		expect(await read(db, "example-mcp")).toEqual({
			name: "Example MCP",
			registrationProvenance: "dcr_direct",
			dcrException: exception,
		});
		await recordConnectionProviderRegistration(db, {
			id: "example-mcp",
			name: "Renamed",
			provenance: "cimd",
			dcrException: null,
		});
		expect(await read(db, "example-mcp")).toEqual({
			name: "Example MCP",
			registrationProvenance: "cimd",
			dcrException: null,
		});
	});

	it("refuses a DCR record without an exception and an exception without DCR", async () => {
		const db = setup();
		await expect(
			recordConnectionProviderRegistration(db, {
				id: "example-mcp",
				name: "Example MCP",
				provenance: "dcr_managed",
				dcrException: null,
			}),
		).rejects.toThrow(/exception/);
		await expect(
			recordConnectionProviderRegistration(db, {
				id: "example-mcp",
				name: "Example MCP",
				provenance: "pre_registered",
				dcrException: exception,
			}),
		).rejects.toThrow(/exception/);
		expect(await read(db, "example-mcp")).toBeUndefined();
	});
});
