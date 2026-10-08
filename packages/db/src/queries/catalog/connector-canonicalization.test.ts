// @ts-nocheck - package test type dependencies are not part of the db tsconfig.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createDbClient, type DbClient } from "../../client";
import { apps } from "../../schema/apps";
import { organizations } from "../../schema/organizations";
import { createD1Facade } from "../../test/d1-facade";
import {
	extractVendorDomain,
	getCanonicalCatalogAppForConnector,
	normalizeMcpEndpoint,
	normalizeVendorName,
	registrableVendorDomain,
} from "./endpoint-normalization";
import {
	getCatalogAppById,
	getCatalogAppBySlug,
	qualifySlugWithDomain,
} from "./get-app";
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

describe("templated and endpoint-less imports", () => {
	let db: DbClient;
	beforeEach(() => {
		db = migratedDb();
	});

	it("treats a templated base URL as no endpoint", () => {
		expect(normalizeMcpEndpoint("{url}")).toBeNull();
		expect(normalizeMcpEndpoint("https://{tenant}.crm.example/mcp")).toBeNull();
		expect(
			normalizeMcpEndpoint("https://mcp.example.com/{workspace}"),
		).toBeNull();
		expect(normalizeMcpEndpoint("https://mcp.example.com/mcp/")).toBe(
			"https://mcp.example.com/mcp",
		);
	});

	it("folds a template-endpoint listing into the existing same-vendor template row", async () => {
		const first = await syncCatalogAppFromStore(db, {
			source: "claude",
			sourceAppId: "claude_dir_ledgerly_a",
			name: "Ledgerly",
			connectorType: "MCP",
			baseUrl: "{url}",
			website: "https://ledgerly.example",
		});
		const second = await syncCatalogAppFromStore(db, {
			source: "claude",
			sourceAppId: "claude_dir_ledgerly_b",
			name: "Ledgerly",
			connectorType: "MCP",
			baseUrl: "{url}",
			website: "https://www.ledgerly.example/",
		});

		expect(first?.created).toBe(true);
		expect(first?.app.mcpEndpointHash).toBeNull();
		expect(second?.created).toBe(false);
		expect(second?.app.id).toBe(first?.app.id);
		expect(await getCatalogAppBySlug(db, "ledgerly-2")).toBeNull();
		const listings = await getCatalogStoreListings(db, first!.app.id);
		expect(listings.map((l) => l.sourceAppId).sort()).toEqual([
			"claude_dir_ledgerly_a",
			"claude_dir_ledgerly_b",
		]);
	});

	it("attaches an endpoint-less MCP connector to the runnable same-vendor row", async () => {
		const runnable = await syncCatalogAppFromStore(db, {
			source: "official",
			sourceAppId: "https://mcp.mailtide.example/mcp",
			name: "Mailtide",
			connectorType: "MCP",
			baseUrl: "https://mcp.mailtide.example/mcp",
			website: "https://mailtide.example",
		});
		const brokered = await syncCatalogAppFromStore(db, {
			source: "chatgpt",
			sourceAppId: "connector_1p_mailtide",
			name: "Mailtide",
			connectorType: "MCP",
			baseUrl: null,
			website: "https://mailtide.example",
		});

		expect(brokered?.created).toBe(false);
		expect(brokered?.app.id).toBe(runnable?.app.id);
		expect(await getCatalogAppBySlug(db, "mailtide-2")).toBeNull();
		const kept = await getCatalogAppById(db, runnable!.app.id);
		expect(kept?.mcpEndpointNormalized).toBe(
			"https://mcp.mailtide.example/mcp",
		);
		const listings = await getCatalogStoreListings(db, runnable!.app.id);
		expect(listings.map((l) => l.source).sort()).toEqual([
			"chatgpt",
			"official",
		]);
	});

	it("keeps per-store endpoint variants of one vendor as separate rows", async () => {
		const openai = await syncCatalogAppFromStore(db, {
			source: "chatgpt",
			sourceAppId: "asdk_app_dealflow",
			name: "Dealflow",
			connectorType: "MCP",
			baseUrl: "https://mcp.dealflow.example/openai",
			website: "https://dealflow.example",
		});
		const anthropic = await syncCatalogAppFromStore(db, {
			source: "claude",
			sourceAppId: "claude_dir_dealflow",
			name: "Dealflow",
			connectorType: "MCP",
			baseUrl: "https://mcp.dealflow.example/anthropic",
			website: "https://dealflow.example",
		});

		expect(anthropic?.created).toBe(true);
		expect(anthropic?.app.id).not.toBe(openai?.app.id);
		// Same vendor: a domain suffix would not distinguish them, so `-N`.
		expect(anthropic?.app.slug).toBe("dealflow-2");
	});

	it("gives a same-name app of a different company a domain-qualified slug", async () => {
		await syncCatalogAppFromStore(db, {
			source: "chatgpt",
			sourceAppId: "asdk_app_breeze_hr",
			name: "Breeze",
			connectorType: "MCP",
			baseUrl: "https://mcp.breeze-hr.example/mcp",
			website: "https://breeze-hr.example",
		});
		const security = await syncCatalogAppFromStore(db, {
			source: "claude",
			sourceAppId: "claude_dir_breeze_sec",
			name: "Breeze",
			connectorType: "MCP",
			baseUrl: "https://mcp.breezesec.example/mcp",
			website: "https://app.breezesec.example",
		});
		// Never merged across companies, and named for its own domain.
		expect(security?.created).toBe(true);
		expect(security?.app.slug).toBe("breeze-breezesec");

		const pm = await syncCatalogAppFromStore(db, {
			source: "claude",
			sourceAppId: "claude_dir_breeze_pm",
			name: "Breeze",
			connectorType: "SERVICE",
			baseUrl: null,
			website: "https://breeze.pm",
		});
		expect(pm?.created).toBe(true);
		expect(pm?.app.slug).toBe("breeze-pm");
	});

	it("derives the registrable domain and the qualified slug", () => {
		expect(registrableVendorDomain("https://app.breezesec.example")).toBe(
			"breezesec.example",
		);
		expect(registrableVendorDomain("https://shop.example.co.jp")).toBe(
			"example.co.jp",
		);
		expect(qualifySlugWithDomain("breeze", "breezesec.com")).toBe(
			"breeze-breezesec",
		);
		expect(qualifySlugWithDomain("breeze", "breeze.in")).toBe("breeze-in");
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

	it("repoints apps built from the orphan and writes everything in one batch", async () => {
		const canonical = await syncCatalogAppFromStore(db, {
			source: "official",
			sourceAppId: "https://mcp.notebay.example/mcp",
			name: "Notebay",
			connectorType: "MCP",
			baseUrl: "https://mcp.notebay.example/mcp",
			website: "https://notebay.example",
		});
		const orphan = await syncCatalogAppFromStore(db, {
			source: "chatgpt",
			sourceAppId: "connector_notebay",
			name: "Notebay Connector",
			connectorType: "SERVICE",
			baseUrl: null,
			website: "https://notebay.example",
		});
		const now = new Date().toISOString();
		await db.insert(organizations).values({
			id: "org-fictional",
			name: "Fictional Co",
			slug: "fictional-co",
			createdAt: now,
			updatedAt: now,
		});
		await db.insert(apps).values({
			id: "app-built-from-orphan",
			organizationId: "org-fictional",
			name: "Notebay",
			slug: "notebay",
			catalogAppId: orphan!.app.id,
		});

		const dry = await mergeCatalogApps(db, {
			fromCatalogAppId: orphan!.app.id,
			intoCatalogAppId: canonical!.app.id,
			dryRun: true,
		});
		expect(dry.repointedApps).toBe(1);
		expect(dry.summary).toMatch(/repoint 1 app/);

		const batch = vi.spyOn(db, "batch");
		const real = await mergeCatalogApps(db, {
			fromCatalogAppId: orphan!.app.id,
			intoCatalogAppId: canonical!.app.id,
			dryRun: false,
		});
		expect(real.deletedOrphan).toBe(true);
		expect(batch).toHaveBeenCalledTimes(1);

		const [app] = await db
			.select({ catalogAppId: apps.catalogAppId })
			.from(apps)
			.where(eq(apps.id, "app-built-from-orphan"));
		expect(app?.catalogAppId).toBe(canonical!.app.id);
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
