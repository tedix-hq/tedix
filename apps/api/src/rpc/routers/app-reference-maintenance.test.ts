import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { apps } from "@tedix/db/schema/apps";
import { auditEvents } from "@tedix/db/schema/audit-events";
import { appCatalog } from "@tedix/db/schema/catalog";
import { organizations } from "@tedix/db/schema/organizations";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";

const descope = vi.hoisted(() => ({
	loadAllApplications: vi.fn(),
}));
vi.mock("./connections/policy-resolution", () => ({
	getDescopeManagement: () => ({
		management: {
			outboundApplication: {
				loadAllApplications: descope.loadAllApplications,
			},
		},
	}),
}));
const purge = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../lib/mcp-subscriptions", () => ({
	purgeMcpAggregateCache: purge,
}));

import {
	backfillAggregateAppIdsProcedure,
	relinkConnectionProviderProcedure,
	renameAppSlugProcedure,
} from "./app-reference-maintenance";

const router = {
	backfillAggregateAppIds: backfillAggregateAppIdsProcedure,
	renameSlug: renameAppSlugProcedure,
	relinkConnectionProvider: relinkConnectionProviderProcedure,
};

const ACME = "00000000-0000-4000-8000-00000000ac01";
const SAMPLE = "00000000-0000-4000-8000-000000005a01";
const BASE = "00000000-0000-4000-8000-0000000000b1";
const PROXY = "00000000-0000-4000-8000-0000000000b2";
const GATEWAY = "00000000-0000-4000-8000-0000000000b3";
const SAMPLE_GATEWAY = "00000000-0000-4000-8000-0000000000b4";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	for (const table of [organizations, appCatalog, apps, auditEvents]) {
		sqlite.exec(schemaDdl(table));
	}
	// Only the columns the relink query reads (the db package covers the rest).
	sqlite.exec(`CREATE TABLE app_tools (
		id text PRIMARY KEY, app_id text NOT NULL REFERENCES apps(id),
		tool_id text NOT NULL, config text, updated_at text
	)`);
	sqlite.exec(`
		INSERT INTO organizations (id, name, slug) VALUES
			('${ACME}', 'Acme', 'acme'), ('${SAMPLE}', 'Sample', 'sample');
	`);
	const insertApp = (
		id: string,
		organizationId: string,
		slug: string,
		metadata: unknown,
	) =>
		sqlite
			.prepare(
				"INSERT INTO apps (id, organization_id, name, slug, metadata) VALUES (?, ?, ?, ?, ?)",
			)
			.run(id, organizationId, slug, slug, JSON.stringify(metadata));
	// Platform base app (sample org), acme's tenant proxy of it, acme's unified
	// gateway linking the proxy, and sample's gateway linking the base app.
	insertApp(BASE, SAMPLE, "mailer", { mcpConfig: {} });
	insertApp(PROXY, ACME, "acme-mailer", {
		mcpConfig: {
			connectionProviderId: "mailer-2",
			aggregateApps: [{ slug: "mailer" }],
		},
	});
	insertApp(GATEWAY, ACME, "acme-unified", {
		mcpConfig: {
			aggregateApps: [
				{
					slug: "acme-mailer",
					prefix: "mail",
					connectionProviderId: "mailer-2",
				},
				{ slug: "ghost" },
			],
			guidanceSkillApps: ["acme-mailer"],
		},
	});
	insertApp(SAMPLE_GATEWAY, SAMPLE, "sample-unified", {
		mcpConfig: { aggregateApps: [{ slug: "mailer", appId: BASE }] },
	});
	sqlite.exec(`
		INSERT INTO app_catalog (id, name, connector_type, last_synced_at, scan_connection_id, scan_organization_id)
			VALUES ('cat-1', 'Mailer', 'mcp', 'now', 'mailer-2', '${ACME}');
	`);
	const snapshot = () =>
		JSON.stringify([
			sqlite.prepare("SELECT id, slug, metadata FROM apps ORDER BY id").all(),
			sqlite.prepare("SELECT id, scan_connection_id FROM app_catalog").all(),
		]);
	const metadata = (id: string) =>
		JSON.parse(
			(
				sqlite.prepare("SELECT metadata FROM apps WHERE id = ?").get(id) as {
					metadata: string;
				}
			).metadata,
		);
	const auditActions = () =>
		(
			sqlite
				.prepare("SELECT action FROM audit_events ORDER BY rowid")
				.all() as {
				action: string;
			}[]
		).map((row) => row.action);
	return {
		db: createDbClient(createD1Facade(sqlite)),
		sqlite,
		snapshot,
		metadata,
		auditActions,
	};
}

function context(
	db: ReturnType<typeof createDbClient>,
	scopes: string[],
): BaseContext {
	return {
		authType: "apikey",
		organizationId: ACME,
		userRole: "owner",
		db,
		env: { ENVIRONMENT: "test" },
		headers: new Headers(),
		url: new URL("https://api.tedix.test/rpc/apps"),
		apiKey: { id: "key", name: "operator", organizationId: ACME, scopes },
	} as unknown as BaseContext;
}

function client(
	db: ReturnType<typeof createDbClient>,
	scopes = ["platform:admin"],
) {
	return createRouterClient(router, { context: context(db, scopes) });
}

beforeEach(() => {
	descope.loadAllApplications.mockReset();
	descope.loadAllApplications.mockResolvedValue({
		ok: true,
		data: [{ id: "mailer-2" }, { id: "mailer-3" }],
	});
	purge.mockClear();
});

describe("backfill_aggregate_app_ids", () => {
	it("dry run returns the plan, reports unresolved entries, and writes nothing", async () => {
		const f = fixture();
		const before = f.snapshot();
		const result = await client(f.db).backfillAggregateAppIds({});
		expect(result).toMatchObject({
			dryRun: true,
			applied: false,
			scannedApps: 2,
		});
		expect(result.changes).toEqual([
			{
				recordType: "app",
				recordId: PROXY,
				appId: PROXY,
				organizationId: ACME,
				field: "metadata.mcpConfig.aggregateApps[0].appId",
				before: null,
				after: BASE,
			},
			{
				recordType: "app",
				recordId: GATEWAY,
				appId: GATEWAY,
				organizationId: ACME,
				field: "metadata.mcpConfig.aggregateApps[0].appId",
				before: null,
				after: PROXY,
			},
		]);
		expect(result.unresolved).toEqual([
			{
				appId: GATEWAY,
				organizationId: ACME,
				list: "aggregateApps",
				index: 1,
				slug: "ghost",
				reason: "not_found",
				candidates: [],
			},
		]);
		expect(f.snapshot()).toBe(before);
		expect(f.auditActions()).toEqual([
			"app.aggregate_app_ids.backfill.planned",
		]);
	});

	it("apply writes exactly the plan and keeps unresolved entries", async () => {
		const f = fixture();
		const result = await client(f.db).backfillAggregateAppIds({
			dryRun: false,
		});
		expect(result.applied).toBe(true);
		expect(f.metadata(PROXY).mcpConfig.aggregateApps).toEqual([
			{ slug: "mailer", appId: BASE },
		]);
		expect(f.metadata(GATEWAY).mcpConfig.aggregateApps).toEqual([
			{
				slug: "acme-mailer",
				prefix: "mail",
				connectionProviderId: "mailer-2",
				appId: PROXY,
			},
			{ slug: "ghost" },
		]);
		const again = await client(f.db).backfillAggregateAppIds({});
		expect(again.changes).toEqual([]);
		expect(again.unresolved).toHaveLength(1);
		expect(purge).toHaveBeenCalledTimes(1);
	});

	it("reports an ambiguous slug instead of guessing", async () => {
		const f = fixture();
		f.sqlite
			.prepare(
				"INSERT INTO apps (id, organization_id, name, slug) VALUES (?, ?, 'dup', 'mailer')",
			)
			.run("00000000-0000-4000-8000-0000000000c9", ACME);
		const result = await client(f.db).backfillAggregateAppIds({
			organizationId: ACME,
		});
		expect(result.unresolved.find((u) => u.slug === "mailer")).toMatchObject({
			reason: "ambiguous",
			candidates: [
				{ appId: BASE, organizationId: SAMPLE },
				{ appId: "00000000-0000-4000-8000-0000000000c9", organizationId: ACME },
			],
		});
		expect(result.changes.map((c) => c.after)).toEqual([PROXY]);
	});
});

describe("rename_app_slug", () => {
	it("renames across organizations and rewrites every link in one batch", async () => {
		const f = fixture();
		const dry = await client(f.db).renameSlug({
			appId: PROXY,
			newSlug: "acme-mail",
		});
		expect(dry).toMatchObject({
			dryRun: true,
			applied: false,
			fromSlug: "acme-mailer",
			toSlug: "acme-mail",
			blockers: [],
		});
		expect(dry.changes.map((c) => `${c.recordId}:${c.field}`)).toEqual([
			`${GATEWAY}:metadata.mcpConfig.aggregateApps[0].appId`,
			`${GATEWAY}:metadata.mcpConfig.aggregateApps[0].slug`,
			`${GATEWAY}:metadata.mcpConfig.guidanceSkillApps[0]`,
			`${PROXY}:slug`,
		]);

		const applied = await client(f.db).renameSlug({
			appId: PROXY,
			newSlug: "acme-mail",
			dryRun: false,
		});
		expect(applied.changes).toEqual(dry.changes);
		expect(f.metadata(GATEWAY).mcpConfig).toMatchObject({
			aggregateApps: [
				{
					slug: "acme-mail",
					prefix: "mail",
					connectionProviderId: "mailer-2",
					appId: PROXY,
				},
				{ slug: "ghost" },
			],
			guidanceSkillApps: ["acme-mail"],
		});
		expect(
			f.sqlite.prepare("SELECT slug FROM apps WHERE id = ?").get(PROXY),
		).toEqual({ slug: "acme-mail" });
	});

	it("updates a link held by appId in another organization and pins the tool prefix", async () => {
		const f = fixture();
		await client(f.db).renameSlug({
			appId: BASE,
			newSlug: "mailer-base",
			dryRun: false,
		});
		// Sample's gateway linked by appId; acme's proxy linked by slug only.
		expect(f.metadata(SAMPLE_GATEWAY).mcpConfig.aggregateApps).toEqual([
			{ slug: "mailer-base", appId: BASE, prefix: "mailer" },
		]);
		expect(f.metadata(PROXY).mcpConfig.aggregateApps).toEqual([
			{ slug: "mailer-base", appId: BASE, prefix: "mailer" },
		]);
	});

	it("refuses to apply while a slug-only link is ambiguous", async () => {
		const f = fixture();
		f.sqlite
			.prepare(
				"INSERT INTO apps (id, organization_id, name, slug) VALUES (?, ?, 'dup', 'mailer')",
			)
			.run("00000000-0000-4000-8000-0000000000c9", ACME);
		const before = f.snapshot();
		const dry = await client(f.db).renameSlug({
			appId: BASE,
			newSlug: "mailer-base",
		});
		expect(dry.blockers).toMatchObject([
			{ appId: PROXY, slug: "mailer", reason: "ambiguous" },
		]);
		await expect(
			client(f.db).renameSlug({
				appId: BASE,
				newSlug: "mailer-base",
				dryRun: false,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(f.snapshot()).toBe(before);
	});

	it("enforces slug format, reservation and global uniqueness", async () => {
		const f = fixture();
		await expect(
			client(f.db).renameSlug({ appId: PROXY, newSlug: "Bad_Slug" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			client(f.db).renameSlug({ appId: PROXY, newSlug: "sample-unified" }),
		).rejects.toThrow(/already exists/);
		await expect(
			client(f.db).renameSlug({ appId: PROXY, newSlug: "tedix-unified" }),
		).rejects.toThrow(/reserved/);
	});
});

describe("relink_connection_provider", () => {
	it("dry run plans every reference; apply writes exactly that plan", async () => {
		const f = fixture();
		const before = f.snapshot();
		const dry = await client(f.db).relinkConnectionProvider({
			from: "mailer-2",
			to: "mailer-3",
		});
		expect(dry.changes.map((c) => `${c.recordId}:${c.field}`)).toEqual([
			`${PROXY}:metadata.mcpConfig.connectionProviderId`,
			`${GATEWAY}:metadata.mcpConfig.aggregateApps[0].connectionProviderId`,
			"cat-1:app_catalog.scan_connection_id",
		]);
		expect(f.snapshot()).toBe(before);

		const applied = await client(f.db).relinkConnectionProvider({
			from: "mailer-2",
			to: "mailer-3",
			dryRun: false,
		});
		expect(applied.changes).toEqual(dry.changes);
		expect(f.metadata(PROXY).mcpConfig.connectionProviderId).toBe("mailer-3");
		expect(
			f.metadata(GATEWAY).mcpConfig.aggregateApps[0].connectionProviderId,
		).toBe("mailer-3");
		expect(
			f.sqlite.prepare("SELECT scan_connection_id FROM app_catalog").get(),
		).toEqual({ scan_connection_id: "mailer-3" });
		expect(f.auditActions()).toEqual([
			"app.connection_provider.relink.planned",
			"app.connection_provider.relink.applied",
		]);
	});

	it("honours the organization filter", async () => {
		const f = fixture();
		const dry = await client(f.db).relinkConnectionProvider({
			from: "mailer-2",
			to: "mailer-3",
			organizationId: SAMPLE,
		});
		expect(dry.changes).toEqual([]);
	});

	it("refuses a target provider that does not exist and writes nothing", async () => {
		const f = fixture();
		const before = f.snapshot();
		await expect(
			client(f.db).relinkConnectionProvider({
				from: "mailer-2",
				to: "mailer-404",
				dryRun: false,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		descope.loadAllApplications.mockResolvedValue({ ok: false });
		await expect(
			client(f.db).relinkConnectionProvider({
				from: "mailer-2",
				to: "mailer-3",
			}),
		).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
		expect(f.snapshot()).toBe(before);
	});
});

describe("platform-admin guard", () => {
	it("refuses tenant callers on every procedure before touching storage", async () => {
		const f = fixture();
		const before = f.snapshot();
		const tenant = client(f.db, ["apps:read", "apps:write"]);
		await expect(
			tenant.backfillAggregateAppIds({ dryRun: false }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			tenant.renameSlug({ appId: PROXY, newSlug: "acme-mail", dryRun: false }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			tenant.relinkConnectionProvider({
				from: "mailer-2",
				to: "mailer-3",
				dryRun: false,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(descope.loadAllApplications).not.toHaveBeenCalled();
		expect(f.snapshot()).toBe(before);
		expect(f.auditActions()).toEqual([]);
	});

	it("refuses a tenant owner signed in as a user", async () => {
		const f = fixture();
		const userContext = {
			...context(f.db, []),
			authType: "user",
			apiKey: undefined,
			user: { sub: "owner", permissions: ["apps:update"], roles: ["owner"] },
		} as unknown as BaseContext;
		await expect(
			createRouterClient(router, { context: userContext }).renameSlug({
				appId: PROXY,
				newSlug: "acme-mail",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});
