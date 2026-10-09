// @ts-nocheck - package test type dependencies are not part of the db tsconfig.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../../client";
import { apps } from "../../schema/apps";
import { organizations } from "../../schema/organizations";
import { createD1Facade } from "../../test/d1-facade";
import { getCatalogAppById, updateCatalogApp } from "./get-app";
import { syncCatalogAppFromStore } from "./upsert-sync";
import {
	applyCatalogPlainSlugReassignment,
	type ClassifyCatalogInstallability,
	planCatalogPlainSlugReassignment,
	rankVendorSiblings,
} from "./vendor-siblings";

function migratedDb(): DbClient {
	const sqlite = new DatabaseSync(":memory:");
	const dir = join(__dirname, "../../../drizzle");
	const files = readdirSync(dir)
		.filter((name) => /^\d{14}_/.test(name))
		.sort();
	for (const file of files) {
		sqlite.exec(
			readFileSync(join(dir, file, "migration.sql"), "utf8").replaceAll(
				"--> statement-breakpoint",
				"",
			),
		);
	}
	return createDbClient(createD1Facade(sqlite));
}

describe("rankVendorSiblings", () => {
	it("orders by installability, then tool count, then source", () => {
		const ranked = rankVendorSiblings([
			{
				id: "listing",
				installabilityState: "listing_only",
				mcpToolCount: 90,
				sources: ["official"],
			},
			{
				id: "chatgpt-rich",
				installabilityState: "needs_base_app",
				mcpToolCount: 40,
				sources: ["chatgpt"],
			},
			{
				id: "claude-rich",
				installabilityState: "needs_base_app",
				mcpToolCount: 40,
				sources: ["claude"],
			},
			{
				id: "official-thin",
				installabilityState: "needs_base_app",
				mcpToolCount: 5,
				sources: ["official"],
			},
			{
				id: "installable",
				installabilityState: "installable",
				mcpToolCount: 1,
				sources: ["chatgpt"],
			},
			{
				id: "service",
				installabilityState: "service_connector",
				mcpToolCount: 0,
				sources: ["official", "claude"],
			},
			{
				id: "disabled",
				installabilityState: "disabled",
				mcpToolCount: 200,
				sources: ["official"],
			},
		]);
		expect(ranked.map((row) => row.id)).toEqual([
			"installable",
			"claude-rich",
			"chatgpt-rich",
			"official-thin",
			"listing",
			"service",
			"disabled",
		]);
	});

	it("uses the best source a row is listed in", () => {
		const ranked = rankVendorSiblings([
			{
				id: "a",
				installabilityState: "needs_base_app",
				mcpToolCount: 3,
				sources: ["chatgpt"],
			},
			{
				id: "b",
				installabilityState: "needs_base_app",
				mcpToolCount: 3,
				sources: ["chatgpt", "official"],
			},
		]);
		expect(ranked.map((row) => row.id)).toEqual(["b", "a"]);
	});
});

describe("plain-slug reassignment", () => {
	let db: DbClient;
	// A stand-in for the API's installability derivation.
	const classify: ClassifyCatalogInstallability = (app, baseApp) =>
		baseApp
			? "installable"
			: app.mcpEndpointNormalized
				? "needs_base_app"
				: "service_connector";

	beforeEach(() => {
		db = migratedDb();
	});

	async function seedVendor() {
		// The brokered listing arrives first and takes the plain slug.
		const brokered = await syncCatalogAppFromStore(db, {
			source: "chatgpt",
			sourceAppId: "connector_pipewise",
			name: "Pipewise",
			connectorType: "SERVICE",
			baseUrl: null,
			website: "https://pipewise.example",
		});
		const runnable = await syncCatalogAppFromStore(db, {
			source: "official",
			sourceAppId: "https://mcp.pipewise.example/mcp",
			name: "Pipewise",
			connectorType: "MCP",
			baseUrl: "https://mcp.pipewise.example/mcp",
			website: "https://pipewise.example",
		});
		await updateCatalogApp(db, runnable!.app.id, { mcpToolCount: 12 });
		return { brokered: brokered!.app, runnable: runnable!.app };
	}

	it("plans and applies the slug move toward the best-ranked sibling", async () => {
		const { brokered, runnable } = await seedVendor();
		expect(brokered.slug).toBe("pipewise");
		expect(runnable.slug).toBe("pipewise-2");

		const plan = await planCatalogPlainSlugReassignment(db, {
			slug: "pipewise",
			classifyInstallability: classify,
		});
		expect(plan?.action).toBe("reassign");
		expect(plan?.winner?.catalogAppId).toBe(runnable.id);
		expect(plan?.holderNextSlug).toBe("pipewise-2");
		expect(plan?.ranked.map((row) => row.catalogAppId)).toEqual([
			runnable.id,
			brokered.id,
		]);
		// Planning is read-only.
		expect((await getCatalogAppById(db, brokered.id))?.slug).toBe("pipewise");

		await applyCatalogPlainSlugReassignment(db, plan!);
		expect((await getCatalogAppById(db, runnable.id))?.slug).toBe("pipewise");
		expect((await getCatalogAppById(db, brokered.id))?.slug).toBe("pipewise-2");

		const again = await planCatalogPlainSlugReassignment(db, {
			slug: "pipewise",
			classifyInstallability: classify,
		});
		expect(again?.action).toBe("keep");
	});

	it("keeps the slug on a tie and never hands it to a template endpoint", async () => {
		const holder = await syncCatalogAppFromStore(db, {
			source: "chatgpt",
			sourceAppId: "https://mcp.pipewise.example/openai",
			name: "Pipewise",
			connectorType: "MCP",
			baseUrl: "https://mcp.pipewise.example/openai",
			website: "https://pipewise.example",
		});
		const tied = await syncCatalogAppFromStore(db, {
			source: "official",
			sourceAppId: "https://mcp.pipewise.example/anthropic",
			name: "Pipewise",
			connectorType: "MCP",
			baseUrl: "https://mcp.pipewise.example/anthropic",
			website: "https://pipewise.example",
		});
		await updateCatalogApp(db, holder!.app.id, { mcpToolCount: 4 });
		await updateCatalogApp(db, tied!.app.id, { mcpToolCount: 4 });
		const tie = await planCatalogPlainSlugReassignment(db, {
			slug: holder!.app.slug!,
			classifyInstallability: classify,
		});
		expect(tie?.action).toBe("keep");

		await updateCatalogApp(db, tied!.app.id, {
			mcpToolCount: 40,
			baseUrl: "{url}",
			mcpEndpointNormalized: null,
		});
		const template = await planCatalogPlainSlugReassignment(db, {
			slug: holder!.app.slug!,
			classifyInstallability: () => "needs_base_app",
		});
		expect(template?.action).toBe("keep");
	});

	it("refuses to move the slug off a holder that apps are built from", async () => {
		const { brokered } = await seedVendor();
		const now = new Date().toISOString();
		await db.insert(organizations).values({
			id: "org-fictional",
			name: "Fictional Co",
			slug: "fictional-co",
			createdAt: now,
			updatedAt: now,
		});
		await db.insert(apps).values({
			id: "app-on-holder",
			organizationId: "org-fictional",
			name: "Pipewise",
			slug: "pipewise",
			catalogAppId: brokered.id,
			sourceAppId: null,
		});

		// Rank as if the holder's app did not make it installable, so the
		// runnable sibling still outranks it and only the guard stops the move.
		const plan = await planCatalogPlainSlugReassignment(db, {
			slug: "pipewise",
			classifyInstallability: (app) => classify(app, null),
		});
		expect(plan?.action).toBe("blocked");
		expect(plan?.winner).toBeNull();
		await expect(applyCatalogPlainSlugReassignment(db, plan!)).rejects.toThrow(
			/not a reassignment/,
		);
	});
});

describe("lookalike names at import", () => {
	it("imports a mixed-script name hidden from browsing", async () => {
		const db = migratedDb();
		const lookalike = await syncCatalogAppFromStore(db, {
			source: "chatgpt",
			sourceAppId: "asdk_lookalike",
			name: "Pip\u0435wise",
			connectorType: "MCP",
			baseUrl: "https://lookalike.example/mcp",
			website: "https://lookalike.example",
		});
		const genuine = await syncCatalogAppFromStore(db, {
			source: "official",
			sourceAppId: "https://mcp.pipewise.example/mcp",
			name: "Pipewise",
			connectorType: "MCP",
			baseUrl: "https://mcp.pipewise.example/mcp",
			website: "https://pipewise.example",
		});
		expect(
			(await getCatalogAppById(db, lookalike!.app.id))?.isDiscoverable,
		).toBe(false);
		expect((await getCatalogAppById(db, genuine!.app.id))?.isDiscoverable).toBe(
			true,
		);
	});
});

describe("lookalike names on re-sync", () => {
	it("keeps a clean name when a store sync sends a lookalike spelling", async () => {
		const db = migratedDb();
		const first = await syncCatalogAppFromStore(db, {
			source: "official",
			sourceAppId: "https://connect.relaykit.example/mcp",
			name: "Relaykit",
			connectorType: "MCP",
			baseUrl: "https://connect.relaykit.example/mcp",
			website: "https://relaykit.example",
		});
		await syncCatalogAppFromStore(db, {
			source: "official",
			sourceAppId: "https://connect.relaykit.example/mcp",
			name: "R\u0435laykit",
			connectorType: "MCP",
			baseUrl: "https://connect.relaykit.example/mcp",
			website: "https://relaykit.example",
		});
		expect((await getCatalogAppById(db, first!.app.id))?.name).toBe("Relaykit");
	});
});
