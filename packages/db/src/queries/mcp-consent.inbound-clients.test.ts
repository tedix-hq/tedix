import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, onTestFinished } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import {
	mcpConsentGrants,
	mcpConsentSelections,
	mcpInboundClientAttempts,
} from "../schema/mcp-consent";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	listMcpConsentGrantClientsForTenant,
	listMcpInboundClientAttempts,
	recordMcpInboundClientAttempt,
	replaceMcpConsentSelection,
} from "./mcp-consent";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	onTestFinished(() => sqlite.close());
	sqlite.exec(schemaDdl(mcpConsentSelections));
	sqlite.exec(schemaDdl(mcpConsentGrants));
	sqlite.exec(schemaDdl(mcpInboundClientAttempts));
	return { sqlite, db: createDbQueryClient(createD1Facade(sqlite)) };
}

const base = {
	organizationId: "org-a",
	mcpServerId: "server-1",
	clientId: "https://agent.example/client.json",
	clientName: "Agent",
	stage: "consent" as const,
	mode: "audit" as const,
	listed: false,
	allowed: true,
	at: "2026-10-26T10:00:00.000Z",
	minIntervalSeconds: 300,
};

describe("inbound client attempts", () => {
	it("skips an identical repeat inside the interval and records a changed decision", async () => {
		const { db } = fixture();
		await recordMcpInboundClientAttempt(db, base);
		await recordMcpInboundClientAttempt(db, {
			...base,
			at: "2026-10-26T10:01:00.000Z",
		});
		let [row] = await listMcpInboundClientAttempts(db, "org-a");
		expect(row).toMatchObject({ attemptCount: 1, lastSeenAt: base.at });

		await recordMcpInboundClientAttempt(db, {
			...base,
			clientName: null,
			stage: "grant",
			mode: "enforce",
			allowed: false,
			at: "2026-10-26T10:02:00.000Z",
		});
		[row] = await listMcpInboundClientAttempts(db, "org-a");
		expect(row).toMatchObject({
			clientName: "Agent",
			lastStage: "grant",
			lastMode: "enforce",
			lastAllowed: false,
			attemptCount: 2,
			deniedCount: 1,
			firstSeenAt: base.at,
			lastSeenAt: "2026-10-26T10:02:00.000Z",
		});

		await recordMcpInboundClientAttempt(db, {
			...base,
			stage: "grant",
			mode: "enforce",
			allowed: false,
			at: "2026-10-26T10:20:00.000Z",
		});
		[row] = await listMcpInboundClientAttempts(db, "org-a");
		expect(row).toMatchObject({ attemptCount: 3, deniedCount: 2 });
	});

	it("lists only the asked organization", async () => {
		const { db } = fixture();
		await recordMcpInboundClientAttempt(db, base);
		await recordMcpInboundClientAttempt(db, {
			...base,
			organizationId: "org-b",
		});
		expect(await listMcpInboundClientAttempts(db, "org-a")).toHaveLength(1);
		expect(await listMcpInboundClientAttempts(db, "org-c")).toEqual([]);
	});
});

describe("Connect grants per tenant", () => {
	it("groups active grants selecting the tenant and ignores other tenants", async () => {
		const { db } = fixture();
		const grant = {
			mcpServerId: "server-1",
			clientId: "client-1",
			appId: "app-1",
			status: "active" as const,
			approvedScopes: ["mcp:apps.read"],
		};
		await replaceMcpConsentSelection(db, {
			...grant,
			descopeUserId: "user-1",
			revision: "r1",
			selectedTenantIds: ["tenant-a", "tenant-b"],
		});
		await replaceMcpConsentSelection(db, {
			...grant,
			descopeUserId: "user-2",
			revision: "r2",
			selectedTenantIds: ["tenant-a"],
		});
		await replaceMcpConsentSelection(db, {
			...grant,
			descopeUserId: "user-3",
			clientId: "client-2",
			revision: "r3",
			selectedTenantIds: ["tenant-b"],
		});
		// A tenant id that is only a prefix of a selected one never matches.
		await replaceMcpConsentSelection(db, {
			...grant,
			descopeUserId: "user-4",
			clientId: "client-3",
			revision: "r4",
			selectedTenantIds: ["tenant-a-other"],
		});
		const rows = await listMcpConsentGrantClientsForTenant(db, "tenant-a");
		expect(rows).toEqual([
			expect.objectContaining({
				mcpServerId: "server-1",
				clientId: "client-1",
				people: 2,
			}),
		]);
	});
});
