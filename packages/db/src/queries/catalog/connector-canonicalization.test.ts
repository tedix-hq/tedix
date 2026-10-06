// @ts-nocheck - package test type dependencies are not part of the db tsconfig.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../../client";
import { createD1Facade } from "../../test/d1-facade";
import {
	extractVendorDomain,
	getCanonicalCatalogAppForConnector,
	normalizeVendorName,
} from "./endpoint-normalization";
import { getCatalogAppById, getCatalogAppBySlug } from "./get-app";
import { checkCatalogIntegrity } from "./mcp-tools";
import { mergeCatalogApps } from "./merge";
import { getCatalogStoreListings } from "./store-listings";
import { syncCatalogAppFromStore } from "./upsert-sync";

// Real in-memory SQLite built from the production Drizzle migration ledger, wired
// through the production createDbClient path (catalog-maintenance.test.ts pattern).

function migratedDb(): DbClient {
	const sqlite = new DatabaseSync(":memory:");
	const dir = join(__dirname, "../../../drizzle");
	const files = readdirSync(dir)
		.filter((name) => /^\d{14}_/.test(name))
		.sort();
	for (const file of files) {
		const sql = readFileSync(
			join(dir, file, "migration.sql"),
			"utf8",
		).replaceAll("--> statement-breakpoint", "");
		sqlite.exec(sql);
	}
	return createDbClient(createD1Facade(sqlite));
}

describe("extractVendorDomain", () => {
	it("strips protocol, www, and trailing slash", () => {
		expect(extractVendorDomain("https://github.com/")).toBe("github.com");
		expect(extractVendorDomain("https://www.github.com")).toBe("github.com");
		expect(extractVendorDomain("github.com")).toBe("github.com");
		expect(extractVendorDomain("http://api.notion.com/mcp")).toBe(
			"api.notion.com",
		);
	});

	it("returns null for empty / unparseable input", () => {
		expect(extractVendorDomain(null)).toBeNull();
		expect(extractVendorDomain("")).toBeNull();
		expect(extractVendorDomain("   ")).toBeNull();
	});
});

describe("normalizeVendorName", () => {
	it("lowercases, trims, and collapses whitespace", () => {
		expect(normalizeVendorName("  GitHub  ")).toBe("github");
		expect(normalizeVendorName("Google   Drive")).toBe("google drive");
		expect(normalizeVendorName(null)).toBe("");
	});
});

describe("vendor-identity canonicalization", () => {
	let db: DbClient;
	beforeEach(() => {
		db = migratedDb();
	});

	async function seedCanonicalGitHub() {
		return syncCatalogAppFromStore(db, {
			source: "official",
			sourceAppId: "https://api.githubcopilot.com/mcp/",
			name: "GitHub",
			connectorType: "MCP",
			baseUrl: "https://api.githubcopilot.com/mcp/",
			website: "https://github.com",
			developer: "GitHub",
		});
	}

	it("finds the canonical runnable row for a matching connector", async () => {
		await seedCanonicalGitHub();
		const canonical = await getCanonicalCatalogAppForConnector(db, {
			website: "https://github.com/",
			name: "GitHub",
		});
		expect(canonical).not.toBeNull();
		expect(canonical?.slug).toBe("github");
		expect(canonical?.connectorType).toBe("MCP");
	});

	it("folds a no-endpoint SERVICE connector onto the canonical row instead of creating a duplicate", async () => {
		const canonical = await seedCanonicalGitHub();
		const canonicalId = canonical!.app.id;

		const result = await syncCatalogAppFromStore(db, {
			source: "chatgpt",
			sourceAppId: "connector_76869538009648d5b282a4bb21c3d157",
			name: "GitHub",
			connectorType: "SERVICE",
			baseUrl: null,
			website: "https://github.com/",
			developer: "OpenAI",
		});

		// No new catalog row: the connector folded onto the canonical GitHub row.
		expect(result?.created).toBe(false);
		expect(result?.app.id).toBe(canonicalId);
		expect(await getCatalogAppBySlug(db, "github-2")).toBeNull();
		expect(await getCatalogAppBySlug(db, "github-3")).toBeNull();

		// The canonical row keeps its MCP endpoint and connectorType (attach-only).
		const kept = await getCatalogAppById(db, canonicalId);
		expect(kept?.connectorType).toBe("MCP");
		expect(kept?.mcpEndpointNormalized).toBe(
			"https://api.githubcopilot.com/mcp",
		);
		expect(kept?.developer).toBe("GitHub");

		// The ChatGPT connector is now a store-listing facet of the canonical row.
		const listings = await getCatalogStoreListings(db, canonicalId);
		const sources = listings.map((l) => l.source).sort();
		expect(sources).toEqual(["chatgpt", "official"]);
	});

	it("does NOT fold when the vendor name differs (multi-product vendor safety)", async () => {
		await syncCatalogAppFromStore(db, {
			source: "official",
			sourceAppId: "https://mcp.google.com/gmail",
			name: "Gmail",
			connectorType: "MCP",
			baseUrl: "https://mcp.google.com/gmail",
			website: "https://google.com",
		});
		const result = await syncCatalogAppFromStore(db, {
			source: "chatgpt",
			sourceAppId: "connector_googledrive",
			name: "Google Drive",
			connectorType: "SERVICE",
			baseUrl: null,
			website: "https://google.com",
		});
		// Distinct product → new standalone row, not folded onto Gmail.
		expect(result?.created).toBe(true);
		expect(result?.app.slug).not.toBe("gmail");
	});

	it("keeps multiple same-store listings that share one MCP endpoint", async () => {
		const first = await syncCatalogAppFromStore(db, {
			source: "chatgpt",
			sourceAppId: "asdk_app_aws_data",
			name: "AWS Data Analytics",
			connectorType: "MCP",
			baseUrl: "https://aws.example.com/mcp",
		});
		const second = await syncCatalogAppFromStore(db, {
			source: "chatgpt",
			sourceAppId: "asdk_app_aws_core",
			name: "AWS Core",
			connectorType: "MCP",
			baseUrl: "https://aws.example.com/mcp",
		});

		expect(second?.app.id).toBe(first?.app.id);
		const listings = await getCatalogStoreListings(db, first!.app.id);
		expect(listings.map((listing) => listing.sourceAppId).sort()).toEqual([
			"asdk_app_aws_core",
			"asdk_app_aws_data",
		]);
	});
});

describe("mergeCatalogApps", () => {
	let db: DbClient;
	beforeEach(() => {
		db = migratedDb();
	});

	it("re-parents listings, moves history, and deletes the orphan", async () => {
		const canonical = await syncCatalogAppFromStore(db, {
			source: "official",
			sourceAppId: "https://api.githubcopilot.com/mcp/",
			name: "GitHub",
			connectorType: "MCP",
			baseUrl: "https://api.githubcopilot.com/mcp/",
			website: "https://github.com",
		});
		// A standalone orphan (as github-3 was) with its own chatgpt listing.
		const orphan = await syncCatalogAppFromStore(db, {
			source: "chatgpt",
			sourceAppId: "connector_76869538009648d5b282a4bb21c3d157",
			name: "GitHub Connector",
			connectorType: "SERVICE",
			baseUrl: null,
			website: "https://github.com",
		});
		const orphanId = orphan!.app.id;
		const canonicalId = canonical!.app.id;
		expect(orphanId).not.toBe(canonicalId);

		const dry = await mergeCatalogApps(db, {
			fromCatalogAppId: orphanId,
			intoCatalogAppId: canonicalId,
			dryRun: true,
		});
		expect(dry.dryRun).toBe(true);
		expect(dry.relistedListings).toBe(1);
		expect(dry.deletedOrphan).toBe(false);
		// Dry run mutates nothing.
		expect(await getCatalogAppById(db, orphanId)).not.toBeNull();

		const real = await mergeCatalogApps(db, {
			fromCatalogAppId: orphanId,
			intoCatalogAppId: canonicalId,
			dryRun: false,
		});
		expect(real.deletedOrphan).toBe(true);
		expect(real.relistedListings).toBe(1);

		// Orphan gone; its listing now belongs to the canonical row.
		expect(await getCatalogAppById(db, orphanId)).toBeNull();
		const listings = await getCatalogStoreListings(db, canonicalId);
		expect(listings.map((l) => l.source).sort()).toEqual([
			"chatgpt",
			"official",
		]);
	});

	it("refuses to merge an app into itself", async () => {
		const app = await syncCatalogAppFromStore(db, {
			source: "official",
			sourceAppId: "https://mcp.example.com/mcp",
			name: "Example",
			connectorType: "MCP",
			baseUrl: "https://mcp.example.com/mcp",
		});
		await expect(
			mergeCatalogApps(db, {
				fromCatalogAppId: app!.app.id,
				intoCatalogAppId: app!.app.id,
			}),
		).rejects.toThrow(/into itself/);
	});
});

describe("check_catalog_integrity — brokered_service_connector", () => {
	let db: DbClient;
	beforeEach(() => {
		db = migratedDb();
	});

	it("flags a brokered connector as a merge candidate when a runnable SAME-NAME vendor row exists", async () => {
		// Orphan brokered connector first (no canonical yet → stays standalone),
		// then the canonical runnable row for the same vendor + name.
		await syncCatalogAppFromStore(db, {
			source: "chatgpt",
			sourceAppId: "connector_76869538009648d5b282a4bb21c3d157",
			name: "GitHub",
			connectorType: "SERVICE",
			baseUrl: null,
			website: "https://github.com",
		});
		await syncCatalogAppFromStore(db, {
			source: "official",
			sourceAppId: "https://api.githubcopilot.com/mcp/",
			name: "GitHub",
			connectorType: "MCP",
			baseUrl: "https://api.githubcopilot.com/mcp/",
			website: "https://github.com",
		});

		const report = await checkCatalogIntegrity(db, { apply: false });
		const brokered = report.issues.filter(
			(i) => i.code === "brokered_service_connector",
		);
		expect(brokered).toHaveLength(1);
		expect(brokered[0]?.repairAction).toBe("none");
		expect(brokered[0]?.summary).toMatch(/runnable official row exists/);
	});

	it("does NOT treat a shared domain with a different name as a merge candidate (BigQuery vs Gmail)", async () => {
		// A runnable Gmail row and a brokered BigQuery row share google.com, but
		// they are different products — the finding must NOT call BigQuery a merge
		// candidate just because the domain coincides.
		await syncCatalogAppFromStore(db, {
			source: "official",
			sourceAppId: "https://mcp.google.com/gmail",
			name: "Gmail",
			connectorType: "MCP",
			baseUrl: "https://mcp.google.com/gmail",
			website: "https://google.com",
		});
		await syncCatalogAppFromStore(db, {
			source: "chatgpt",
			sourceAppId: "connector_bigquery",
			name: "BigQuery",
			connectorType: "SERVICE",
			baseUrl: null,
			website: "https://google.com",
		});

		const report = await checkCatalogIntegrity(db, { apply: false });
		const brokered = report.issues.filter(
			(i) => i.code === "brokered_service_connector",
		);
		expect(brokered).toHaveLength(1);
		expect(brokered[0]?.catalogAppName).toBe("BigQuery");
		// Shared domain, different name → discovery-only, NOT a merge candidate.
		expect(brokered[0]?.summary).toMatch(/discovery-only/);
	});

	it("flags a brokered connector with no runnable counterpart as discovery-only", async () => {
		await syncCatalogAppFromStore(db, {
			source: "claude",
			sourceAppId: "connector_lonely_enterprise",
			name: "Acme Enterprise",
			connectorType: "SERVICE",
			baseUrl: null,
			website: "https://acme-enterprise.example",
		});

		const report = await checkCatalogIntegrity(db, { apply: false });
		const brokered = report.issues.filter(
			(i) => i.code === "brokered_service_connector",
		);
		expect(brokered).toHaveLength(1);
		expect(brokered[0]?.summary).toMatch(/discovery-only/);
	});
});
