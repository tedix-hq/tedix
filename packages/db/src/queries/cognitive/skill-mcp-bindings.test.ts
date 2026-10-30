import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import { apps } from "../../schema/apps";
import { skillEntries } from "../../schema/cognitive";
import { policyPacks } from "../../schema/control-plane";
import { organizations } from "../../schema/organizations";
import { providerInstallations } from "../../schema/provider-installations";
import { appTools } from "../../schema/tools";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { createSkillEntry, updateSkillEntry } from "./skill-crud";
import {
	skillMcpProxyIncludesSource,
	recordMissingSkillMcpAppBindings,
	repairSkillMcpAppBindings,
	resolveSkillMcpNamespaceSlugs,
} from "./skill-mcp-bindings";
import { validateSkillInput } from "./skill-validation";

/**
 * A skill names apps by namespace; an app slug may be renamed. These tests run
 * the production query path on in-memory SQLite through the D1 facade, which
 * rejects `BEGIN` and duplicate output column names.
 */

const ACME_ORG = "20000000-0000-4000-8000-000000000001";
const OTHER_ORG = "20000000-0000-4000-8000-000000000002";
const PLATFORM_ORG = "20000000-0000-4000-8000-000000000003";

function realDb() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(
		schemaDdl(
			apps,
			skillEntries,
			organizations,
			providerInstallations,
			policyPacks,
		),
	);
	sqlite
		.prepare(
			"INSERT INTO policy_packs (id,name,slug,scope,target,status,version,published_at,published_by,definition) VALUES ('trust', 'Trust', 'installation-trust', 'system', 'shared', 'active', 1, '2026-01-01T00:00:00.000Z', 'operator', ?)",
		)
		.run(
			JSON.stringify({
				installationTrust: {
					version: 1,
					aggregate: {
						sharedSourceOrganizationIds: [PLATFORM_ORG],
						aggregateHostOrganizationIds: [PLATFORM_ORG],
					},
					catalogScan: { endpoints: [] },
				},
			}),
		);
	return { db: createDbClient(createD1Facade(sqlite)), sqlite };
}

function insertApp(
	sqlite: DatabaseSync,
	row: {
		id: string;
		organizationId: string;
		slug: string;
		visibility?: "public" | "private";
	},
) {
	sqlite
		.prepare(
			"INSERT INTO apps (id, organization_id, name, slug, visibility) VALUES (?, ?, ?, ?, ?)",
		)
		.run(
			row.id,
			row.organizationId,
			row.slug,
			row.slug,
			row.visibility ?? "private",
		);
}

function renameApp(sqlite: DatabaseSync, id: string, slug: string) {
	sqlite.prepare("UPDATE apps SET slug = ? WHERE id = ?").run(slug, id);
}

function bindingsOf(sqlite: DatabaseSync, id: string) {
	const row = sqlite
		.prepare("SELECT mcp_app_bindings FROM skill_entries WHERE id = ?")
		.get(id) as { mcp_app_bindings: string | null } | undefined;
	return row?.mcp_app_bindings ? JSON.parse(row.mcp_app_bindings) : null;
}

function skillBody(mcp: Record<string, string[]>): string {
	const lines = Object.entries(mcp).map(
		([namespace, methods]) => `    ${namespace}: [${methods.join(", ")}]`,
	);
	return [
		"---",
		"name: mail-digest",
		"capabilities:",
		"  mcp:",
		...lines,
		"---",
		"Send the digest.",
	].join("\n");
}

async function recordSkill(
	db: ReturnType<typeof realDb>["db"],
	mcp: Record<string, string[]>,
	organizationId = ACME_ORG,
) {
	return createSkillEntry(db, {
		organizationId,
		title: "Mail digest",
		content: skillBody(mcp),
	});
}

describe("skill MCP app bindings", () => {
	it("keeps resolving a namespace after its app slug is renamed", async () => {
		const { db, sqlite } = realDb();
		insertApp(sqlite, {
			id: "app-mail",
			organizationId: ACME_ORG,
			slug: "acme-mail-2",
		});
		const skill = await recordSkill(db, { acme_mail_2: ["send_email"] });
		expect(skill.mcpAppBindings).toEqual({ acme_mail_2: "app-mail" });

		renameApp(sqlite, "app-mail", "acme-mail");
		const { namespaceToSlug, backfill } = await resolveSkillMcpNamespaceSlugs(
			db,
			{
				organizationId: ACME_ORG,
				skillId: skill.id,
				namespaces: ["acme_mail_2"],
			},
		);
		expect(namespaceToSlug).toEqual({ acme_mail_2: "acme-mail" });
		expect(backfill).toEqual({});
	});

	it("keeps an existing binding when an improve rewrites the content after a rename", async () => {
		const { db, sqlite } = realDb();
		insertApp(sqlite, {
			id: "app-mail",
			organizationId: ACME_ORG,
			slug: "acme-mail-2",
		});
		insertApp(sqlite, {
			id: "app-crm",
			organizationId: ACME_ORG,
			slug: "crm",
		});
		const skill = await recordSkill(db, { acme_mail_2: ["send_email"] });
		renameApp(sqlite, "app-mail", "acme-mail");

		await updateSkillEntry(db, skill.id, {
			content: skillBody({
				acme_mail_2: ["send_email", "list_emails"],
				crm: ["list_contacts"],
			}),
		});
		expect(bindingsOf(sqlite, skill.id)).toEqual({
			acme_mail_2: "app-mail",
			crm: "app-crm",
		});

		await updateSkillEntry(db, skill.id, {
			content: skillBody({ crm: ["list_contacts"] }),
		});
		expect(bindingsOf(sqlite, skill.id)).toEqual({ crm: "app-crm" });
	});

	it("never binds or slug-matches reserved or gateway namespaces", async () => {
		const { db, sqlite } = realDb();
		for (const slug of ["home", "kernel", "tedi", "cognitive", "rationale"]) {
			insertApp(sqlite, { id: `app-${slug}`, organizationId: ACME_ORG, slug });
		}
		const skill = await recordSkill(db, {
			home: ["ask"],
			kernel: ["approve_plan_assignments"],
			tedi: ["artifact_read_file"],
			cognitive: ["record_artifact"],
			rationale: ["create_rationale_records"],
		});
		expect(skill.mcpAppBindings).toBeNull();

		const { namespaceToSlug, backfill } = await resolveSkillMcpNamespaceSlugs(
			db,
			{
				organizationId: ACME_ORG,
				skillId: skill.id,
				namespaces: ["home", "tedi", "rationale", "seo"],
			},
		);
		// Reserved namespaces name platform surfaces, never an app: a same-named
		// app row must not become the dispatch target or the manifest check's
		// required source slug.
		expect(namespaceToSlug).toEqual({});
		expect(backfill).toEqual({});
	});

	it("resolves os to the platform tedix app without binding it", async () => {
		const { db, sqlite } = realDb();
		insertApp(sqlite, { id: "app-os", organizationId: ACME_ORG, slug: "os" });
		insertApp(sqlite, {
			id: "app-tedix",
			organizationId: ACME_ORG,
			slug: "tedix",
		});
		const skill = await recordSkill(db, { os: ["list_os_outputs"] });
		expect(skill.mcpAppBindings).toBeNull();

		const { namespaceToSlug, backfill } = await resolveSkillMcpNamespaceSlugs(
			db,
			{ organizationId: ACME_ORG, skillId: skill.id, namespaces: ["os"] },
		);
		expect(namespaceToSlug).toEqual({ os: "tedix" });
		expect(backfill).toEqual({});
	});

	it("does not bind another organization's private app, and ignores a forged binding to one", async () => {
		const { db, sqlite } = realDb();
		insertApp(sqlite, {
			id: "app-foreign",
			organizationId: OTHER_ORG,
			slug: "other-ledger",
		});
		insertApp(sqlite, {
			id: "app-catalog",
			organizationId: PLATFORM_ORG,
			slug: "mailer",
			visibility: "public",
		});
		const skill = await recordSkill(db, {
			other_ledger: ["list_entries"],
			mailer: ["send_email"],
		});
		expect(skill.mcpAppBindings).toEqual({ mailer: "app-catalog" });

		sqlite
			.prepare("UPDATE skill_entries SET mcp_app_bindings = ? WHERE id = ?")
			.run(JSON.stringify({ ledger: "app-foreign" }), skill.id);
		renameApp(sqlite, "app-foreign", "ledger-renamed");
		const { namespaceToSlug } = await resolveSkillMcpNamespaceSlugs(db, {
			organizationId: ACME_ORG,
			skillId: skill.id,
			namespaces: ["ledger"],
		});
		expect(namespaceToSlug).toEqual({});
	});

	it("does not read another organization's skill bindings", async () => {
		const { db, sqlite } = realDb();
		insertApp(sqlite, {
			id: "app-mail",
			organizationId: OTHER_ORG,
			slug: "other-mail-2",
		});
		const skill = await recordSkill(
			db,
			{ other_mail_2: ["send_email"] },
			OTHER_ORG,
		);
		renameApp(sqlite, "app-mail", "other-mail");
		const { namespaceToSlug, backfill } = await resolveSkillMcpNamespaceSlugs(
			db,
			{
				organizationId: ACME_ORG,
				skillId: skill.id,
				namespaces: ["other_mail_2"],
			},
		);
		expect(namespaceToSlug).toEqual({});
		expect(backfill).toEqual({});
	});

	it("backfills a legacy skill so a later rename keeps working, without overwriting existing bindings", async () => {
		const { db, sqlite } = realDb();
		insertApp(sqlite, {
			id: "app-mail",
			organizationId: ACME_ORG,
			slug: "acme-mail-2",
		});
		insertApp(sqlite, { id: "app-crm", organizationId: ACME_ORG, slug: "crm" });
		const skill = await recordSkill(db, {
			acme_mail_2: ["send_email"],
			crm: ["list_contacts"],
		});
		// Simulate a row written before bindings existed, plus one stored key.
		sqlite
			.prepare("UPDATE skill_entries SET mcp_app_bindings = ? WHERE id = ?")
			.run(JSON.stringify({ crm: "app-crm" }), skill.id);

		const first = await resolveSkillMcpNamespaceSlugs(db, {
			organizationId: ACME_ORG,
			skillId: skill.id,
			namespaces: ["acme_mail_2", "crm"],
		});
		expect(first.namespaceToSlug).toEqual({
			acme_mail_2: "acme-mail-2",
			crm: "crm",
		});
		expect(first.backfill).toEqual({ acme_mail_2: "app-mail" });
		await recordMissingSkillMcpAppBindings(db, {
			organizationId: ACME_ORG,
			skillId: skill.id,
			bindings: { ...first.backfill, crm: "app-other" },
		});
		expect(bindingsOf(sqlite, skill.id)).toEqual({
			acme_mail_2: "app-mail",
			crm: "app-crm",
		});

		renameApp(sqlite, "app-mail", "acme-mail");
		const after = await resolveSkillMcpNamespaceSlugs(db, {
			organizationId: ACME_ORG,
			skillId: skill.id,
			namespaces: ["acme_mail_2"],
		});
		expect(after.namespaceToSlug).toEqual({ acme_mail_2: "acme-mail" });
	});

	it("falls back to slug matching when a bound app was deleted", async () => {
		const { db, sqlite } = realDb();
		insertApp(sqlite, {
			id: "app-mail",
			organizationId: ACME_ORG,
			slug: "acme-mail",
		});
		const skill = await recordSkill(db, { acme_mail: ["send_email"] });
		sqlite.prepare("DELETE FROM apps WHERE id = ?").run("app-mail");
		insertApp(sqlite, {
			id: "app-mail-new",
			organizationId: ACME_ORG,
			slug: "acme-mail",
		});
		const { namespaceToSlug, backfill } = await resolveSkillMcpNamespaceSlugs(
			db,
			{
				organizationId: ACME_ORG,
				skillId: skill.id,
				namespaces: ["acme_mail"],
			},
		);
		expect(namespaceToSlug).toEqual({ acme_mail: "acme-mail" });
		// A stale binding is replaced on the next content write, not by backfill.
		expect(backfill).toEqual({});
	});
});

describe("skill MCP bindings follow the organization gateway", () => {
	function gateway(sqlite: DatabaseSync, appIds: string[]) {
		sqlite
			.prepare(
				"INSERT INTO apps (id, organization_id, name, slug, visibility, metadata) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(
				"app-gateway",
				ACME_ORG,
				"acme-unified",
				"acme-unified",
				"private",
				JSON.stringify({
					mcpConfig: {
						codeMode: true,
						authMode: "authenticated",
						aggregateApps: appIds.map((appId) => ({ slug: appId, appId })),
					},
				}),
			);
	}

	it("routes a namespace to the gateway's install, not a same-named base app", async () => {
		const { db, sqlite } = realDb();
		insertApp(sqlite, {
			id: "app-base",
			organizationId: ACME_ORG,
			slug: "codehost",
		});
		insertApp(sqlite, {
			id: "app-install",
			organizationId: ACME_ORG,
			slug: "codehost-tedix",
		});
		gateway(sqlite, ["app-install"]);
		const skill = await recordSkill(db, { codehost: ["get_commit"] });
		expect(bindingsOf(sqlite, skill.id)).toEqual({ codehost: "app-install" });
		const { namespaceToSlug } = await resolveSkillMcpNamespaceSlugs(db, {
			organizationId: ACME_ORG,
			skillId: skill.id,
			namespaces: ["codehost"],
		});
		expect(namespaceToSlug).toEqual({ codehost: "codehost-tedix" });
	});

	it("repairs a binding to an app the gateway does not aggregate", async () => {
		const { db, sqlite } = realDb();
		insertApp(sqlite, {
			id: "app-base",
			organizationId: ACME_ORG,
			slug: "codehost",
		});
		const skill = await recordSkill(db, { codehost: ["get_commit"] });
		expect(bindingsOf(sqlite, skill.id)).toEqual({ codehost: "app-base" });
		insertApp(sqlite, {
			id: "app-install",
			organizationId: ACME_ORG,
			slug: "codehost-tedix",
		});
		// The install wraps the base app; only the Code Mode gateway counts.
		sqlite.prepare("UPDATE apps SET metadata = ? WHERE id = ?").run(
			JSON.stringify({
				mcpConfig: { aggregateApps: [{ slug: "codehost", appId: "app-base" }] },
			}),
			"app-install",
		);
		gateway(sqlite, ["app-install"]);
		const { namespaceToSlug, repair } = await resolveSkillMcpNamespaceSlugs(
			db,
			{
				organizationId: ACME_ORG,
				skillId: skill.id,
				namespaces: ["codehost"],
			},
		);
		expect(namespaceToSlug).toEqual({ codehost: "codehost-tedix" });
		expect(repair).toEqual({ codehost: "app-install" });
		await repairSkillMcpAppBindings(db, {
			organizationId: ACME_ORG,
			skillId: skill.id,
			bindings: repair,
		});
		expect(bindingsOf(sqlite, skill.id)).toEqual({ codehost: "app-install" });
	});

	it("keeps a binding the gateway aggregates, even when another slug matches", async () => {
		const { db, sqlite } = realDb();
		insertApp(sqlite, {
			id: "app-base",
			organizationId: ACME_ORG,
			slug: "codehost",
		});
		gateway(sqlite, ["app-base"]);
		const skill = await recordSkill(db, { codehost: ["get_commit"] });
		insertApp(sqlite, {
			id: "app-install",
			organizationId: ACME_ORG,
			slug: "codehost-tedix",
		});
		const { namespaceToSlug, repair } = await resolveSkillMcpNamespaceSlugs(
			db,
			{
				organizationId: ACME_ORG,
				skillId: skill.id,
				namespaces: ["codehost"],
			},
		);
		expect(namespaceToSlug).toEqual({ codehost: "codehost" });
		expect(repair).toEqual({});
	});
});

describe("validateSkillInput after an app rename", () => {
	function lintDb() {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec("PRAGMA foreign_keys = OFF");
		sqlite.exec(schemaDdl(apps, appTools));
		return { db: createDbClient(createD1Facade(sqlite)), sqlite };
	}
	const unknownNamespace = (warnings: { code: string }[]) =>
		warnings.filter((w) => w.code === "SKILL_CAPABILITY_UNKNOWN_NAMESPACE");
	const input = {
		title: "Mail digest",
		content: skillBody({ mailer_acme: ["list-emails"] }),
	};

	it("trusts a stored binding instead of warning on the old namespace", async () => {
		const { db, sqlite } = lintDb();
		insertApp(sqlite, {
			id: "app-mailer",
			organizationId: ACME_ORG,
			slug: "mailer-2-acme",
		});
		renameApp(sqlite, "app-mailer", "mailer-acme-renamed");

		const unbound = await validateSkillInput(db, input);
		expect(unknownNamespace(unbound.warnings)).toHaveLength(1);

		const bound = await validateSkillInput(db, {
			...input,
			mcpAppBindings: { mailer_acme: "app-mailer" },
			organizationId: ACME_ORG,
		});
		expect(unknownNamespace(bound.warnings)).toHaveLength(0);
	});

	it("ignores a binding to another organization's private app", async () => {
		const { db, sqlite } = lintDb();
		insertApp(sqlite, {
			id: "app-foreign",
			organizationId: OTHER_ORG,
			slug: "foreign-mailer",
		});

		const result = await validateSkillInput(db, {
			...input,
			mcpAppBindings: { mailer_acme: "app-foreign" },
			organizationId: ACME_ORG,
		});
		expect(unknownNamespace(result.warnings)).toHaveLength(1);
	});
});

describe("skill MCP aggregate source authorization", () => {
	it("recognizes a public provider inherited through an installed proxy", async () => {
		const { db, sqlite } = realDb();
		insertApp(sqlite, {
			id: "proxy",
			slug: "acme-source",
			organizationId: ACME_ORG,
		});
		insertApp(sqlite, {
			id: "provider",
			slug: "source",
			organizationId: PLATFORM_ORG,
			visibility: "public",
		});
		sqlite.prepare("UPDATE apps SET metadata=? WHERE id=?").run(
			JSON.stringify({
				mcpConfig: {
					aggregateApps: [{ appId: "provider", slug: "old-source" }],
				},
			}),
			"proxy",
		);
		expect(
			await skillMcpProxyIncludesSource(db, {
				organizationId: ACME_ORG,
				appSlug: "acme-source",
				sourceAppSlug: "source",
			}),
		).toBe(true);
		expect(
			await skillMcpProxyIncludesSource(db, {
				organizationId: ACME_ORG,
				appSlug: "acme-source",
				sourceAppSlug: "unrelated",
			}),
		).toBe(false);
		sqlite.close();
	});
	it.each([
		{
			entry: { appId: "provider", slug: "source", toolIds: ["read_one"] },
			visibility: "public",
			org: PLATFORM_ORG,
		},
		{
			entry: { appId: "provider", slug: "source", endpointPrefixes: ["safe/"] },
			visibility: "public",
			org: PLATFORM_ORG,
		},
		{
			entry: { appId: "provider", slug: "source", readOnly: true },
			visibility: "public",
			org: PLATFORM_ORG,
		},
		{
			entry: { appId: "missing", slug: "source" },
			visibility: "public",
			org: PLATFORM_ORG,
		},
		{
			entry: { appId: "provider", slug: "source" },
			visibility: "private",
			org: OTHER_ORG,
		},
	] as const)(
		"does not widen filtered, stale-id or foreign-private links: %j",
		async ({ entry, visibility, org }) => {
			const { db, sqlite } = realDb();
			insertApp(sqlite, {
				id: "proxy",
				slug: "acme-source",
				organizationId: ACME_ORG,
			});
			insertApp(sqlite, {
				id: "provider",
				slug: "source",
				organizationId: org,
				visibility,
			});
			sqlite
				.prepare("UPDATE apps SET metadata=? WHERE id=?")
				.run(
					JSON.stringify({ mcpConfig: { aggregateApps: [entry] } }),
					"proxy",
				);
			expect(
				await skillMcpProxyIncludesSource(db, {
					organizationId: ACME_ORG,
					appSlug: "acme-source",
					sourceAppSlug: "source",
				}),
			).toBe(false);
			sqlite.close();
		},
	);
	it("follows an org install to a private Tedix platform base app, not another tenant's", async () => {
		const { db, sqlite } = realDb();
		sqlite
			.prepare(
				"INSERT INTO organizations (id, name, slug, descope_tenant_id) VALUES (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)",
			)
			.run(
				PLATFORM_ORG,
				"Tedix",
				"tedix",
				"org_tedix",
				ACME_ORG,
				"Acme",
				"acme",
				"acme_tenant",
				OTHER_ORG,
				"Other",
				"other",
				"other_tenant",
			);
		insertApp(sqlite, {
			id: "proxy",
			slug: "acme-source",
			organizationId: ACME_ORG,
		});
		insertApp(sqlite, {
			id: "provider",
			slug: "source",
			organizationId: PLATFORM_ORG,
		});
		sqlite.prepare("UPDATE apps SET metadata=? WHERE id=?").run(
			JSON.stringify({
				mcpConfig: { aggregateApps: [{ appId: "provider" }] },
			}),
			"proxy",
		);
		const includes = (organizationId: string) =>
			skillMcpProxyIncludesSource(db, {
				organizationId,
				appSlug: "acme-source",
				sourceAppSlug: "source",
			});
		expect(await includes(ACME_ORG)).toBe(true);
		// Another organization's skill cannot use Acme's install.
		expect(await includes(OTHER_ORG)).toBe(false);

		sqlite
			.prepare("UPDATE apps SET visibility='disabled' WHERE id=?")
			.run("provider");
		expect(await includes(ACME_ORG)).toBe(false);

		// A private app of another tenant stays out of reach.
		sqlite
			.prepare(
				"UPDATE apps SET organization_id=?, visibility='private' WHERE id=?",
			)
			.run(OTHER_ORG, "provider");
		expect(await includes(ACME_ORG)).toBe(false);
		sqlite.close();
	});
	it("bounds cycles and rejects a proxy outside the organization", async () => {
		const { db, sqlite } = realDb();
		insertApp(sqlite, {
			id: "proxy",
			slug: "acme-source",
			organizationId: OTHER_ORG,
		});
		sqlite
			.prepare("UPDATE apps SET metadata=? WHERE id=?")
			.run(
				JSON.stringify({ mcpConfig: { aggregateApps: [{ appId: "proxy" }] } }),
				"proxy",
			);
		expect(
			await skillMcpProxyIncludesSource(db, {
				organizationId: ACME_ORG,
				appSlug: "acme-source",
				sourceAppSlug: "source",
			}),
		).toBe(false);
		sqlite
			.prepare("UPDATE apps SET organization_id=? WHERE id=?")
			.run(ACME_ORG, "proxy");
		expect(
			await skillMcpProxyIncludesSource(db, {
				organizationId: ACME_ORG,
				appSlug: "acme-source",
				sourceAppSlug: "source",
			}),
		).toBe(false);
		sqlite.close();
	});
});
