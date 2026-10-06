import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import {
	applyRoleTemplate,
	archiveRoleTemplate,
	CMO_ROLE_TEMPLATE_SEED,
	createRoleTemplate,
	getRoleTemplateByKey,
	listRoleTemplates,
	RoleTemplateError,
	upsertRoleTemplateSeed,
} from "./role-templates";
import { listObjectives } from "./tedi-objectives";

/**
 * Role Templates (reusable role primitive) — CRUD, seed upsert, and
 * `applyRoleTemplate` provisioning against a REAL in-memory SQLite engine via
 * the production createDbClient path (mirrors projects.test.ts /
 * tedi-objectives.test.ts).
 */

const DDL = `
CREATE TABLE role_templates (
	id TEXT PRIMARY KEY NOT NULL,
	org_id TEXT,
	key TEXT NOT NULL,
	name TEXT NOT NULL,
	description TEXT,
	persona TEXT NOT NULL,
	standing_objectives TEXT NOT NULL DEFAULT '[]',
	tags TEXT NOT NULL DEFAULT '[]',
	capability_profile TEXT NOT NULL DEFAULT 'standard',
	cron_template_names TEXT NOT NULL DEFAULT '[]',
	metadata TEXT NOT NULL DEFAULT '{}',
	created_at TEXT NOT NULL,
	updated_at TEXT,
	archived_at TEXT
);
CREATE UNIQUE INDEX uniq_role_templates_org_key ON role_templates (org_id, key);
-- Full tedis DDL: updateTedi uses .returning() (all columns), so every
-- physical column must exist. Generated from schema/tedis.ts, all permissive.
CREATE TABLE tedis (
	id TEXT PRIMARY KEY NOT NULL,
	organization_id TEXT,
	owner_user_id TEXT,
	scope TEXT,
	name TEXT,
	slug TEXT,
	display_name TEXT,
	descope_user_id TEXT,
	descope_mcp_resource_id TEXT,
	external_ref TEXT,
	tags TEXT,
	personality TEXT,
	avatar TEXT,
	timezone TEXT,
	language TEXT,
	installed_skills TEXT,
	installed_plugins TEXT,
	retired_at TEXT,
	retired_slug TEXT,
	status TEXT,
	billing_state TEXT,
	worker_name TEXT,
	r2_bucket_name TEXT,
	mcp_capability_profile TEXT NOT NULL DEFAULT 'standard',
	tool_policy TEXT,
	self_improvement_policy TEXT,
	budgets TEXT,
	quiet_hours TEXT,
	governance_override TEXT,
	runtime_profile_id TEXT,
	policy_pack_id TEXT,
	workspace_template_set_id TEXT,
	runtime_overrides TEXT,
	channels TEXT,
	cron_jobs TEXT,
	repo_config TEXT,
	runtime_state TEXT,
	last_activity_at TEXT,
	last_heartbeat_at TEXT,
	idle_since TEXT,
	runtime_status TEXT,
	last_seen_at TEXT,
	last_sync_at TEXT,
	last_sync_result TEXT,
	last_backup_handles TEXT,
	placement_id TEXT,
	body_generation_id TEXT,
	body_generation_kind TEXT,
	body_generation_status TEXT,
	body_generation_token_hash TEXT,
	body_generation_token_expires_at TEXT,
	body_generation_external_id TEXT,
	body_generation_heartbeat_at TEXT,
	runtime_kind TEXT,
	isolate_agent_id TEXT,
	created_at TEXT,
	updated_at TEXT
);
CREATE TABLE tedi_objectives (
	id TEXT PRIMARY KEY NOT NULL,
	tedi_id TEXT NOT NULL,
	org_id TEXT NOT NULL,
	purpose_charter_id TEXT,
	title TEXT NOT NULL,
	description TEXT,
	approach TEXT,
	success_criteria TEXT,
	constraints TEXT,
	type TEXT NOT NULL DEFAULT 'standing',
	status TEXT NOT NULL DEFAULT 'active',
	risk_level TEXT NOT NULL DEFAULT 'medium',
	priority INTEGER NOT NULL DEFAULT 0,
	linked_domains TEXT DEFAULT '[]',
	gate_config TEXT DEFAULT '{}',
	budget_config TEXT DEFAULT '{}',
	progress TEXT DEFAULT '{}',
	created_at TEXT NOT NULL,
	updated_at TEXT,
	completed_at TEXT
);
CREATE TABLE organization_purpose_charters (
	id TEXT PRIMARY KEY NOT NULL,
	org_id TEXT NOT NULL,
	version INTEGER NOT NULL,
	status TEXT NOT NULL DEFAULT 'active',
	purpose TEXT NOT NULL,
	principles TEXT NOT NULL DEFAULT '[]',
	strategic_theses TEXT NOT NULL DEFAULT '[]',
	non_goals TEXT NOT NULL DEFAULT '[]',
	evidence_refs TEXT NOT NULL DEFAULT '[]',
	review_cadence_days INTEGER NOT NULL DEFAULT 30,
	revision_reason TEXT NOT NULL,
	created_by_user_id TEXT,
	created_at TEXT NOT NULL,
	activated_at TEXT NOT NULL,
	superseded_at TEXT
);
CREATE TABLE tedi_role_assignments (
	id TEXT PRIMARY KEY NOT NULL,
	organization_id TEXT NOT NULL,
	tedi_id TEXT NOT NULL,
	role_template_id TEXT,
	role_key TEXT NOT NULL,
	role_name TEXT NOT NULL,
	status TEXT NOT NULL,
	career_stage TEXT NOT NULL,
	assigned_at TEXT NOT NULL,
	stage_changed_at TEXT NOT NULL,
	ended_at TEXT,
	revision INTEGER NOT NULL,
	last_decision_id TEXT,
	evidence_snapshot_hash TEXT,
	metadata TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uniq_tedi_role_assignment_active
	ON tedi_role_assignments (organization_id, tedi_id)
	WHERE status = 'active';
`;

const ORG = "org-1";
const OTHER_ORG = "org-2";
const NOW = "2026-07-18T00:00:00.000Z";

function fixture(): { db: DbClient; sqlite: DatabaseSync } {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(DDL);
	return { db: createDbClient(createD1Facade(sqlite)), sqlite };
}

function seedTedi(
	sqlite: DatabaseSync,
	id: string,
	orgId = ORG,
	tags: string[] = [],
): void {
	sqlite
		.prepare(
			"INSERT INTO tedis (id, organization_id, tags, mcp_capability_profile) VALUES (?, ?, ?, 'standard')",
		)
		.run(id, orgId, JSON.stringify(tags));
}

function readTedi(sqlite: DatabaseSync, id: string) {
	return sqlite
		.prepare(
			"SELECT personality, tags, mcp_capability_profile FROM tedis WHERE id = ?",
		)
		.get(id) as
		| {
				personality: string | null;
				tags: string | null;
				mcp_capability_profile: string;
		  }
		| undefined;
}

describe("role templates CRUD", () => {
	it("creates, reads by key (org + platform), and lists", async () => {
		const { db } = fixture();
		const platform = await createRoleTemplate(db, {
			orgId: null,
			key: "cmo",
			name: "Chief Marketing Officer",
			persona: "SOUL",
			standingObjectives: [{ title: "Own CMS blog operations" }],
			tags: ["marketing"],
			createdAt: NOW,
		});
		expect(platform.orgId).toBeNull();
		expect(platform.capabilityProfile).toBe("standard");

		await createRoleTemplate(db, {
			orgId: ORG,
			key: "cto",
			name: "Chief Technology Officer",
			persona: "SOUL2",
			createdAt: NOW,
		});

		// Exact-owner lookup distinguishes platform (null) from org rows.
		expect(
			(await getRoleTemplateByKey(db, { key: "cmo", orgId: null }))?.id,
		).toBe(platform.id);
		expect(
			await getRoleTemplateByKey(db, { key: "cmo", orgId: ORG }),
		).toBeUndefined();

		// List returns org rows PLUS platform-wide blueprints.
		const listed = await listRoleTemplates(db, { orgId: ORG });
		expect(listed.data.map((t) => t.key).sort()).toEqual(["cmo", "cto"]);

		// Without an org, only platform templates surface.
		const platformOnly = await listRoleTemplates(db, {});
		expect(platformOnly.data.map((t) => t.key)).toEqual(["cmo"]);
	});

	it("soft-archives and excludes archived from list by default", async () => {
		const { db } = fixture();
		const t = await createRoleTemplate(db, {
			orgId: ORG,
			key: "cmo",
			name: "CMO",
			persona: "SOUL",
			createdAt: NOW,
		});
		await archiveRoleTemplate(db, t.id, NOW);
		expect((await listRoleTemplates(db, { orgId: ORG })).data).toHaveLength(0);
		expect(
			(await listRoleTemplates(db, { orgId: ORG, includeArchived: true })).data,
		).toHaveLength(1);
	});
});

describe("seed upsert", () => {
	it("inserts then updates the cmo seed idempotently (no duplicate row)", async () => {
		const { db } = fixture();
		const first = await upsertRoleTemplateSeed(db, CMO_ROLE_TEMPLATE_SEED);
		expect(first.orgId).toBeNull();
		expect(first.key).toBe("cmo");
		expect(first.standingObjectives).toHaveLength(3);
		expect(first.tags).toEqual([
			"marketing",
			"cms",
			"analytics",
			"gateway:operator",
		]);
		expect(first.capabilityProfile).toBe("standard");
		expect(first.cronTemplateNames).toEqual(["objective-review"]);
		// The active CMO profile must fit the API update limit and keep the
		// current CMS route plus the authority boundaries together.
		expect(first.persona.length).toBeLessThanOrEqual(5000);
		expect(first.persona).toContain("cms_landing.get_site_overview");
		expect(first.persona).toContain("https://tedix.dev/blog/{slug}");
		expect(first.persona).toContain("cms_tedix are retired publishing targets");
		expect(first.persona).toContain("low-risk posts on tedix.dev/blog");
		expect(first.persona).toContain(
			"Pages, homepage, legal pages, other collections",
		);
		expect(first.persona).toContain(
			"SERVER-ATTRIBUTED authorization receipt from an ACCOUNTABLE PRINCIPAL",
		);
		expect(first.persona).toContain("a tedi OTHER than you");
		expect(first.persona).toContain(
			"A receipt authored by YOU is self-authorization",
		);
		expect(first.persona).toContain("7 days when a non-human did");
		expect(first.persona).toContain("metadata.marketingCampaign.key");
		expect(first.persona).toContain("before and after _rev");
		expect(first.persona).toContain("submit that exact receipt");
		expect(first.persona).toContain("read-only instructions override");
		expect(first.persona).toContain("Home-delegated turn bound to a Work Item");
		expect(first.persona).toContain(
			"do not call Work readiness/start/heartbeat/settle",
		);
		expect(first.persona).toContain("exact slug-and-locale match");
		expect(first.persona).toContain(
			"retry at most once only after proven absence",
		);
		expect(first.persona).toContain("promptwatch_project_tedix.update_project");
		expect(first.persona).toContain("promptwatch_tedix.listProjects");
		expect(first.persona).toContain("honor Retry-After and retry once");
		expect(first.persona).not.toMatch(
			/projectKey|claimedByMe|checkoutId|work_item_claim|work_item_release/,
		);
		expect(first.metadata).toMatchObject({
			operatingModel: "bounded-autonomy",
			steeringSurface: "objective-linked-work-item",
			evidenceReceipt: "workflow-run-and-work-item",
			skillWorkflowSlug: "cmo-daily-operating-loop",
			promptwatchProfileReadback: "required",
			publicActions: "owned-channel-work-item-gate",
			ownedChannel: "tedix.dev/blog",
			ownedChannelTool: "cms_landing.content_publish",
			ownedChannelGateScope: "tedix-unified:cms_landing__content_publish",
			ownedChannelPublishReceipt: "work_item_evidence",
			ownedChannelAuthorization:
				"server-attributed-accountable-principal-receipt",
			ownedChannelRevocation: "project-pause-or-user-revocation-event",
			ownedChannelRisk: "low",
		});

		const second = await upsertRoleTemplateSeed(db, CMO_ROLE_TEMPLATE_SEED);
		expect(second.id).toBe(first.id);
		const all = await listRoleTemplates(db, {});
		expect(all.data).toHaveLength(1);
	});
});

describe("applyRoleTemplate", () => {
	it("sets persona + tags + profile and seeds the standing objectives", async () => {
		const { db, sqlite } = fixture();
		seedTedi(sqlite, "tedi-1", ORG, ["existing"]);
		await createRoleTemplate(db, {
			orgId: null,
			key: "cmo",
			name: "CMO",
			persona: "MARKETING SOUL",
			standingObjectives: [
				{ title: "Own CMS blog operations", riskLevel: "medium" },
				{ title: "Weekly marketing analytics review", riskLevel: "low" },
				{ title: "Self-improve marketing capability", riskLevel: "low" },
			],
			tags: ["marketing", "cms", "analytics"],
			capabilityProfile: "standard",
			createdAt: NOW,
		});

		const summary = await applyRoleTemplate(db, {
			tediId: "tedi-1",
			templateKey: "cmo",
			orgId: ORG,
		});

		expect(summary.personaSet).toBe(true);
		expect(summary.requestedCapabilityProfile).toBe("standard");
		expect(summary.capabilityProfileChange).toBe(
			"not_applied_role_does_not_grant_authority",
		);
		expect(summary.careerStage).toBe("shadow");
		expect(summary.tagsAdded).toEqual(["marketing", "cms", "analytics"]);
		expect(summary.objectivesCreated).toHaveLength(3);
		expect(summary.objectivesUpdated).toHaveLength(0);
		expect(summary.objectivesSkipped).toHaveLength(0);
		expect(summary.assignmentReconcile).toBe(
			"not_run_setting_tags_is_the_trigger",
		);

		const tedi = readTedi(sqlite, "tedi-1");
		expect(tedi?.personality).toBe("MARKETING SOUL");
		// Existing tag preserved, template tags unioned on.
		expect(JSON.parse(tedi?.tags ?? "[]")).toEqual([
			"existing",
			"marketing",
			"cms",
			"analytics",
		]);

		const objectives = await listObjectives(db, {
			tediId: "tedi-1",
			type: "standing",
			status: "active",
			limit: 100,
			offset: 0,
		});
		expect(objectives.data).toHaveLength(3);
		// Reused the mission-os first_n standing gate default.
		expect(objectives.data[0]?.gateConfig).toMatchObject({
			gateType: "always",
			autonomyLevel: "supervised",
		});
	});

	it("is idempotent — re-apply does not duplicate objectives or tags", async () => {
		const { db, sqlite } = fixture();
		seedTedi(sqlite, "tedi-1", ORG);
		await upsertRoleTemplateSeed(db, CMO_ROLE_TEMPLATE_SEED);

		const first = await applyRoleTemplate(db, {
			tediId: "tedi-1",
			templateKey: "cmo",
			orgId: ORG,
		});
		expect(first.objectivesCreated).toHaveLength(3);

		const second = await applyRoleTemplate(db, {
			tediId: "tedi-1",
			templateKey: "cmo",
			orgId: ORG,
		});
		expect(second.objectivesCreated).toHaveLength(0);
		expect(second.objectivesUpdated).toHaveLength(0);
		expect(second.objectivesSkipped).toHaveLength(3);
		expect(second.tagsAdded).toHaveLength(0);

		const objectives = await listObjectives(db, {
			tediId: "tedi-1",
			type: "standing",
			status: "active",
			limit: 100,
			offset: 0,
		});
		expect(objectives.data).toHaveLength(3);
	});

	it("rejects a different active role before changing persona, tags, or objectives", async () => {
		const { db, sqlite } = fixture();
		seedTedi(sqlite, "tedi-1", ORG, ["existing"]);
		await createRoleTemplate(db, {
			orgId: null,
			key: "cmo",
			name: "CMO",
			persona: "MARKETING SOUL",
			standingObjectives: [{ title: "Own marketing" }],
			tags: ["marketing"],
			createdAt: NOW,
		});
		await createRoleTemplate(db, {
			orgId: null,
			key: "cto",
			name: "CTO",
			persona: "TECHNOLOGY SOUL",
			standingObjectives: [{ title: "Own technology" }],
			tags: ["technology"],
			createdAt: NOW,
		});

		await applyRoleTemplate(db, {
			tediId: "tedi-1",
			templateKey: "cmo",
			orgId: ORG,
		});
		const before = readTedi(sqlite, "tedi-1");
		const objectivesBefore = sqlite
			.prepare(
				"SELECT title FROM tedi_objectives WHERE tedi_id = ? ORDER BY title",
			)
			.all("tedi-1");

		await expect(
			applyRoleTemplate(db, {
				tediId: "tedi-1",
				templateKey: "cto",
				orgId: ORG,
			}),
		).rejects.toMatchObject({
			name: "EarnedDelegationError",
			reason: "invalid_transition",
		});

		expect(readTedi(sqlite, "tedi-1")).toEqual(before);
		expect(
			sqlite
				.prepare(
					"SELECT title FROM tedi_objectives WHERE tedi_id = ? ORDER BY title",
				)
				.all("tedi-1"),
		).toEqual(objectivesBefore);
	});

	it("reconciles stale objective content and autonomy policy on re-apply", async () => {
		const { db, sqlite } = fixture();
		seedTedi(sqlite, "tedi-1", ORG);
		await upsertRoleTemplateSeed(db, CMO_ROLE_TEMPLATE_SEED);
		await applyRoleTemplate(db, {
			tediId: "tedi-1",
			templateKey: "cmo",
			orgId: ORG,
		});
		sqlite
			.prepare(
				`UPDATE tedi_objectives
				 SET approach = 'stale', gate_config = '{"autonomyLevel":"supervised"}'
				 WHERE title = 'Keep Tedix market strategy current'`,
			)
			.run();

		const summary = await applyRoleTemplate(db, {
			tediId: "tedi-1",
			templateKey: "cmo",
			orgId: ORG,
		});
		expect(summary.objectivesUpdated).toEqual([
			"Keep Tedix market strategy current",
		]);
		const objective = (
			await listObjectives(db, {
				tediId: "tedi-1",
				type: "standing",
				status: "active",
				limit: 100,
				offset: 0,
			})
		).data.find((item) => item.title === "Keep Tedix market strategy current");
		expect(objective?.approach).not.toBe("stale");
		expect(objective?.gateConfig).toMatchObject({
			autonomyLevel: "supervised",
			gateType: "always",
		});
	});

	it("rejects a missing template", async () => {
		const { db, sqlite } = fixture();
		seedTedi(sqlite, "tedi-1", ORG);
		await expect(
			applyRoleTemplate(db, {
				tediId: "tedi-1",
				templateKey: "nope",
				orgId: ORG,
			}),
		).rejects.toMatchObject({
			name: "RoleTemplateError",
			reason: "template_not_found",
		});
	});

	it("enforces the cross-org guard on the target tedi", async () => {
		const { db, sqlite } = fixture();
		seedTedi(sqlite, "tedi-other", OTHER_ORG);
		await upsertRoleTemplateSeed(db, CMO_ROLE_TEMPLATE_SEED);
		await expect(
			applyRoleTemplate(db, {
				tediId: "tedi-other",
				templateKey: "cmo",
				orgId: ORG,
			}),
		).rejects.toBeInstanceOf(RoleTemplateError);
		await expect(
			applyRoleTemplate(db, {
				tediId: "tedi-other",
				templateKey: "cmo",
				orgId: ORG,
			}),
		).rejects.toMatchObject({ reason: "tedi_out_of_scope" });
	});

	it("does not apply an org-scoped template from another org", async () => {
		const { db, sqlite } = fixture();
		seedTedi(sqlite, "tedi-1", ORG);
		// Template belongs to OTHER_ORG only — invisible to ORG.
		await createRoleTemplate(db, {
			orgId: OTHER_ORG,
			key: "secret",
			name: "Secret",
			persona: "SOUL",
			createdAt: NOW,
		});
		await expect(
			applyRoleTemplate(db, {
				tediId: "tedi-1",
				templateKey: "secret",
				orgId: ORG,
			}),
		).rejects.toMatchObject({ reason: "template_not_found" });
	});
});
