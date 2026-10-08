import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import { apps } from "../../schema/apps";
import { skillEntries } from "../../schema/cognitive";
import { appTools } from "../../schema/tools";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { createSkillEntry, updateSkillEntry } from "./skill-crud";
import {
	recordMissingSkillMcpAppBindings,
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
	sqlite.exec(schemaDdl(apps, skillEntries));
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

	it("never binds reserved or gateway namespaces", async () => {
		const { db, sqlite } = realDb();
		for (const slug of ["home", "kernel", "tedi", "cognitive"]) {
			insertApp(sqlite, { id: `app-${slug}`, organizationId: ACME_ORG, slug });
		}
		const skill = await recordSkill(db, {
			home: ["ask"],
			kernel: ["approve_plan_assignments"],
			tedi: ["artifact_read_file"],
			cognitive: ["record_artifact"],
		});
		expect(skill.mcpAppBindings).toBeNull();

		const { namespaceToSlug, backfill } = await resolveSkillMcpNamespaceSlugs(
			db,
			{
				organizationId: ACME_ORG,
				skillId: skill.id,
				namespaces: ["home", "tedi", "seo"],
			},
		);
		// Slug matching is unchanged; resolveMcpTarget still routes reserved
		// namespaces to the aggregate before it reads this map.
		expect(namespaceToSlug).toEqual({ home: "home", tedi: "tedi" });
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
