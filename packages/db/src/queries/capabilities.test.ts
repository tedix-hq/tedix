import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { MAX_CAPABILITY_DEPTH } from "../schema/capabilities";
import { createD1Facade } from "../test/d1-facade";
import {
	archiveCapabilitySubtree,
	CapabilityDepthError,
	CapabilityLinkEntityError,
	CapabilityParentError,
	createCapability,
	getCapabilityByIdForOrganization,
	getCapabilityCoverage,
	getCapabilityTree,
	getUnmappedEntities,
	linkCapability,
	listCapabilities,
	unlinkCapability,
	updateCapability,
} from "./capabilities";

const ORG = "org-1";
const OTHER_ORG = "org-2";
const NOW = "2026-07-16T12:00:00.000Z";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE org_capabilities (
			id TEXT PRIMARY KEY NOT NULL,
			organization_id TEXT NOT NULL,
			parent_id TEXT,
			name TEXT NOT NULL,
			slug TEXT NOT NULL,
			description TEXT,
			value_stream TEXT,
			pace_layer TEXT NOT NULL,
			maturity_score REAL,
			status TEXT NOT NULL DEFAULT 'active',
			created_at TEXT NOT NULL,
			updated_at TEXT,
			archived_at TEXT
		);
		CREATE UNIQUE INDEX uniq_org_capabilities_org_slug
			ON org_capabilities (organization_id, slug);
		CREATE TABLE capability_links (
			id TEXT PRIMARY KEY NOT NULL,
			capability_id TEXT NOT NULL,
			organization_id TEXT NOT NULL,
			entity_kind TEXT NOT NULL,
			entity_id TEXT NOT NULL,
			created_at TEXT NOT NULL
		);
		CREATE UNIQUE INDEX uniq_capability_links_target
			ON capability_links (capability_id, entity_kind, entity_id);
		CREATE TABLE skill_entries (
			id TEXT PRIMARY KEY NOT NULL,
			organization_id TEXT NOT NULL,
			tedi_id TEXT,
			app_id TEXT,
			title TEXT NOT NULL,
			slug TEXT,
			lifecycle_state TEXT,
			pace_layer TEXT
		);
		CREATE TABLE tedi_objectives (
			id TEXT PRIMARY KEY NOT NULL,
			tedi_id TEXT NOT NULL,
			org_id TEXT NOT NULL,
			title TEXT NOT NULL,
			type TEXT NOT NULL DEFAULT 'standing',
			status TEXT NOT NULL DEFAULT 'active'
		);
		CREATE TABLE tedis (
			id TEXT PRIMARY KEY NOT NULL,
			organization_id TEXT NOT NULL
		);
		CREATE TABLE apps (
			id TEXT PRIMARY KEY NOT NULL,
			organization_id TEXT NOT NULL
		);
	`);
	return { db: createDbClient(createD1Facade(sqlite)), sqlite };
}

function seedSkill(
	sqlite: DatabaseSync,
	id: string,
	organizationId = ORG,
	lifecycleState: string | null = "active",
) {
	sqlite
		.prepare(
			`INSERT INTO skill_entries (id, organization_id, title, slug, lifecycle_state)
			 VALUES (?, ?, ?, ?, ?)`,
		)
		.run(id, organizationId, id, id, lifecycleState);
}

function seedObjective(sqlite: DatabaseSync, id: string, orgId = ORG) {
	sqlite
		.prepare(
			`INSERT INTO tedi_objectives (id, tedi_id, org_id, title) VALUES (?, 'tedi-1', ?, ?)`,
		)
		.run(id, orgId, id);
}

function seedTediRow(sqlite: DatabaseSync, id: string, orgId = ORG) {
	sqlite
		.prepare(`INSERT INTO tedis (id, organization_id) VALUES (?, ?)`)
		.run(id, orgId);
}

let idCounter = 0;
function nextId(prefix: string): string {
	idCounter += 1;
	return `${prefix}-${idCounter}`;
}

async function createNode(
	db: ReturnType<typeof createDbClient>,
	options: {
		organizationId?: string;
		parentId?: string | null;
		name: string;
		paceLayer?: "innovation" | "differentiation" | "record";
	},
) {
	return createCapability(db, {
		id: nextId("cap"),
		organizationId: options.organizationId ?? ORG,
		parentId: options.parentId ?? null,
		name: options.name,
		slug: options.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
		paceLayer: options.paceLayer ?? "differentiation",
		createdAt: NOW,
	});
}

describe("capability tree depth enforcement", () => {
	it("allows exactly MAX_CAPABILITY_DEPTH levels and rejects a fourth", async () => {
		const { db } = fixture();
		const root = await createNode(db, { name: "Root A" });
		const child = await createNode(db, { name: "Child A", parentId: root.id });
		const grandchild = await createNode(db, {
			name: "Grandchild A",
			parentId: child.id,
		});
		expect(MAX_CAPABILITY_DEPTH).toBe(3);
		await expect(
			createNode(db, { name: "Too Deep", parentId: grandchild.id }),
		).rejects.toBeInstanceOf(CapabilityDepthError);
	});

	it("rejects re-parenting that would push the subtree past the ceiling", async () => {
		const { db } = fixture();
		const rootA = await createNode(db, { name: "Root A" });
		const childA = await createNode(db, {
			name: "Child A",
			parentId: rootA.id,
		});
		await createNode(db, { name: "Grandchild A", parentId: childA.id });
		const rootB = await createNode(db, { name: "Root B" });
		// rootA has height 3 → under rootB it would reach depth 4.
		await expect(
			updateCapability(db, rootA.id, { parentId: rootB.id, updatedAt: NOW }),
		).rejects.toBeInstanceOf(CapabilityDepthError);
		// The grandchild (height 1) fits under rootB's depth-1 node.
		const grandchildMove = await updateCapability(db, childA.id, {
			parentId: rootB.id,
			updatedAt: NOW,
		});
		expect(grandchildMove?.parentId).toBe(rootB.id);
	});

	it("rejects cycles and self-parenting", async () => {
		const { db } = fixture();
		const root = await createNode(db, { name: "Root" });
		const child = await createNode(db, { name: "Child", parentId: root.id });
		await expect(
			updateCapability(db, root.id, { parentId: child.id, updatedAt: NOW }),
		).rejects.toBeInstanceOf(CapabilityParentError);
		await expect(
			updateCapability(db, root.id, { parentId: root.id, updatedAt: NOW }),
		).rejects.toBeInstanceOf(CapabilityParentError);
	});

	it("rejects cross-org and archived parents", async () => {
		const { db } = fixture();
		const foreign = await createNode(db, {
			name: "Foreign Root",
			organizationId: OTHER_ORG,
		});
		await expect(
			createNode(db, { name: "Orphan", parentId: foreign.id }),
		).rejects.toBeInstanceOf(CapabilityParentError);

		const archivedRoot = await createNode(db, { name: "Archived Root" });
		await archiveCapabilitySubtree(db, archivedRoot.id, NOW);
		await expect(
			createNode(db, { name: "Child Of Archived", parentId: archivedRoot.id }),
		).rejects.toBeInstanceOf(CapabilityParentError);
	});
});

describe("capability links", () => {
	it("link is idempotent — the second call returns the existing row", async () => {
		const { db, sqlite } = fixture();
		seedSkill(sqlite, "skill-1");
		const cap = await createNode(db, { name: "Deploy" });
		const first = await linkCapability(db, {
			id: nextId("link"),
			capabilityId: cap.id,
			organizationId: ORG,
			entityKind: "skill",
			entityId: "skill-1",
			createdAt: NOW,
		});
		const second = await linkCapability(db, {
			id: nextId("link"),
			capabilityId: cap.id,
			organizationId: ORG,
			entityKind: "skill",
			entityId: "skill-1",
			createdAt: NOW,
		});
		expect(first.created).toBe(true);
		expect(second.created).toBe(false);
		expect(second.link.id).toBe(first.link.id);
	});

	it("unlink is idempotent — second removal reports false", async () => {
		const { db, sqlite } = fixture();
		seedObjective(sqlite, "obj-1");
		const cap = await createNode(db, { name: "Deploy" });
		await linkCapability(db, {
			id: nextId("link"),
			capabilityId: cap.id,
			organizationId: ORG,
			entityKind: "objective",
			entityId: "obj-1",
			createdAt: NOW,
		});
		const first = await unlinkCapability(db, {
			capabilityId: cap.id,
			entityKind: "objective",
			entityId: "obj-1",
		});
		const second = await unlinkCapability(db, {
			capabilityId: cap.id,
			entityKind: "objective",
			entityId: "obj-1",
		});
		expect(first).toBe(true);
		expect(second).toBe(false);
	});

	it("rejects a link to a fabricated entity id with a typed not_found error", async () => {
		const { db } = fixture();
		const cap = await createNode(db, { name: "Deploy" });
		const attempt = linkCapability(db, {
			id: nextId("link"),
			capabilityId: cap.id,
			organizationId: ORG,
			entityKind: "skill",
			entityId: "skill-does-not-exist",
			createdAt: NOW,
		});
		await expect(attempt).rejects.toBeInstanceOf(CapabilityLinkEntityError);
		await expect(attempt).rejects.toMatchObject({ reason: "not_found" });
	});

	it("rejects a link to another org's entity with a typed wrong_org error", async () => {
		const { db, sqlite } = fixture();
		seedSkill(sqlite, "skill-foreign-org", OTHER_ORG);
		const cap = await createNode(db, { name: "Deploy" });
		await expect(
			linkCapability(db, {
				id: nextId("link"),
				capabilityId: cap.id,
				organizationId: ORG,
				entityKind: "skill",
				entityId: "skill-foreign-org",
				createdAt: NOW,
			}),
		).rejects.toMatchObject({
			name: "CapabilityLinkEntityError",
			reason: "wrong_org",
		});
	});

	it("skipEntityValidation bypasses the target check for trusted bulk seeding", async () => {
		const { db } = fixture();
		const cap = await createNode(db, { name: "Deploy" });
		const { link, created } = await linkCapability(db, {
			id: nextId("link"),
			capabilityId: cap.id,
			organizationId: ORG,
			entityKind: "tedi",
			entityId: "tedi-preverified",
			createdAt: NOW,
			skipEntityValidation: true,
		});
		expect(created).toBe(true);
		expect(link.entityId).toBe("tedi-preverified");
	});

	it("validates every link kind against its own table", async () => {
		const { db, sqlite } = fixture();
		seedTediRow(sqlite, "tedi-real");
		sqlite
			.prepare(`INSERT INTO apps (id, organization_id) VALUES (?, ?)`)
			.run("app-real", ORG);
		const cap = await createNode(db, { name: "Deploy" });
		for (const [entityKind, entityId] of [
			["tedi", "tedi-real"],
			["app", "app-real"],
		] as const) {
			const { created } = await linkCapability(db, {
				id: nextId("link"),
				capabilityId: cap.id,
				organizationId: ORG,
				entityKind,
				entityId,
				createdAt: NOW,
			});
			expect(created).toBe(true);
		}
		await expect(
			linkCapability(db, {
				id: nextId("link"),
				capabilityId: cap.id,
				organizationId: ORG,
				entityKind: "app",
				entityId: "app-missing",
				createdAt: NOW,
			}),
		).rejects.toMatchObject({ reason: "not_found" });
	});
});

describe("coverage report", () => {
	it("computes per-capability counts, skill maturity mix, and distinct totals", async () => {
		const { db, sqlite } = fixture();
		sqlite.exec(`
			INSERT INTO skill_entries (id, organization_id, title, slug, lifecycle_state, pace_layer)
			VALUES
				('skill-active', '${ORG}', 'Active Skill', 'active-skill', 'active', 'differentiation'),
				('skill-draft', '${ORG}', 'Draft Skill', 'draft-skill', 'draft', 'innovation');
		`);
		seedTediRow(sqlite, "tedi-1");
		seedObjective(sqlite, "obj-1");
		const capA = await createNode(db, { name: "Deploy", paceLayer: "record" });
		const capB = await createNode(db, { name: "Docs" });
		const child = await createNode(db, { name: "Canary", parentId: capA.id });

		for (const [entityKind, entityId] of [
			["skill", "skill-active"],
			["skill", "skill-draft"],
			["tedi", "tedi-1"],
			["objective", "obj-1"],
		] as const) {
			await linkCapability(db, {
				id: nextId("link"),
				capabilityId: capA.id,
				organizationId: ORG,
				entityKind,
				entityId,
				createdAt: NOW,
			});
		}
		// skill-active also supports capB — must count once in totals.
		await linkCapability(db, {
			id: nextId("link"),
			capabilityId: capB.id,
			organizationId: ORG,
			entityKind: "skill",
			entityId: "skill-active",
			createdAt: NOW,
		});

		const report = await getCapabilityCoverage(db, ORG);
		const entryA = report.capabilities.find((c) => c.capabilityId === capA.id);
		const entryB = report.capabilities.find((c) => c.capabilityId === capB.id);
		const entryChild = report.capabilities.find(
			(c) => c.capabilityId === child.id,
		);

		expect(entryA).toMatchObject({
			linkedSkillCount: 2,
			linkedTediCount: 1,
			linkedObjectiveCount: 1,
			linkedAppCount: 0,
			depth: 1,
			paceLayer: "record",
		});
		expect(entryA?.skillLifecycleMix).toEqual({ active: 1, draft: 1 });
		expect(entryA?.skillPaceLayerMix).toEqual({
			differentiation: 1,
			innovation: 1,
		});
		expect(entryB?.linkedSkillCount).toBe(1);
		expect(entryChild?.depth).toBe(2);
		expect(report.totals).toEqual({
			capabilityCount: 3,
			mappedSkillCount: 2,
			mappedTediCount: 1,
			mappedObjectiveCount: 1,
			mappedAppCount: 0,
		});
	});
});

describe("unmapped-entity report", () => {
	it("lists org skills and active objectives with no capability link", async () => {
		const { db, sqlite } = fixture();
		sqlite.exec(`
			INSERT INTO skill_entries (id, organization_id, app_id, title, slug, lifecycle_state, pace_layer)
			VALUES
				('skill-linked', '${ORG}', NULL, 'Linked Skill', 'linked-skill', 'active', 'differentiation'),
				('skill-gap', '${ORG}', NULL, 'Gap Skill', 'gap-skill', 'draft', 'innovation'),
				('skill-null-lifecycle', '${ORG}', NULL, 'Unlabeled Skill', 'unlabeled-skill', NULL, NULL),
				('skill-app-scoped', '${ORG}', 'app-1', 'App Docs Skill', 'app-docs', 'active', NULL),
				('skill-archived', '${ORG}', NULL, 'Archived Skill', 'old-skill', 'archived', 'innovation'),
				('skill-foreign', '${OTHER_ORG}', NULL, 'Foreign Skill', 'foreign', 'active', NULL);
			INSERT INTO tedi_objectives (id, tedi_id, org_id, title, type, status)
			VALUES
				('obj-linked', 'tedi-1', '${ORG}', 'Linked Objective', 'standing', 'active'),
				('obj-gap', 'tedi-1', '${ORG}', 'Gap Objective', 'standing', 'active'),
				('obj-paused', 'tedi-1', '${ORG}', 'Paused Objective', 'standing', 'paused');
		`);
		const cap = await createNode(db, { name: "Deploy" });
		await linkCapability(db, {
			id: nextId("link"),
			capabilityId: cap.id,
			organizationId: ORG,
			entityKind: "skill",
			entityId: "skill-linked",
			createdAt: NOW,
		});
		await linkCapability(db, {
			id: nextId("link"),
			capabilityId: cap.id,
			organizationId: ORG,
			entityKind: "objective",
			entityId: "obj-linked",
			createdAt: NOW,
		});

		const report = await getUnmappedEntities(db, ORG);
		// NULL lifecycle counts as draft (unmapped), NOT archived — `<>
		// 'archived'` alone is NULL for NULL rows and silently dropped them.
		expect(report.skills.map((s) => s.id)).toEqual([
			"skill-gap",
			"skill-null-lifecycle",
		]);
		expect(report.objectives.map((o) => o.id)).toEqual(["obj-gap"]);
		expect(report.totals).toEqual({
			unmappedSkillCount: 2,
			unmappedObjectiveCount: 1,
			skillTotal: 3,
			objectiveTotal: 2,
		});

		const withAppScoped = await getUnmappedEntities(db, ORG, {
			includeAppScopedSkills: true,
		});
		expect(withAppScoped.skills.map((s) => s.id).sort()).toEqual([
			"skill-app-scoped",
			"skill-gap",
			"skill-null-lifecycle",
		]);
	});
});

describe("tree + archive", () => {
	it("assembles the org tree and archive removes the whole subtree from it", async () => {
		const { db } = fixture();
		const root = await createNode(db, { name: "Root" });
		const child = await createNode(db, { name: "Child", parentId: root.id });
		const grandchild = await createNode(db, {
			name: "Grandchild",
			parentId: child.id,
		});
		const sibling = await createNode(db, { name: "Sibling Root" });

		const tree = await getCapabilityTree(db, ORG);
		expect(tree.map((n) => n.id).sort()).toEqual([root.id, sibling.id].sort());
		const rootNode = tree.find((n) => n.id === root.id);
		expect(rootNode?.children[0]?.id).toBe(child.id);
		expect(rootNode?.children[0]?.children[0]?.id).toBe(grandchild.id);

		const archived = await archiveCapabilitySubtree(db, root.id, NOW);
		expect(archived.map((c) => c.id).sort()).toEqual(
			[root.id, child.id, grandchild.id].sort(),
		);
		// Idempotent: nothing left to archive on the second pass.
		const rearchived = await archiveCapabilitySubtree(db, root.id, NOW);
		expect(rearchived).toHaveLength(0);

		const after = await getCapabilityTree(db, ORG);
		expect(after.map((n) => n.id)).toEqual([sibling.id]);

		const archivedList = await listCapabilities(db, {
			organizationId: ORG,
			status: "archived",
		});
		expect(archivedList.total).toBe(3);
	});
});

describe("tenant-scoped capability lookup", () => {
	it("does not resolve a capability through another organization", async () => {
		const { db } = fixture();
		const capability = await createNode(db, { name: "Deploy" });
		expect(
			(await getCapabilityByIdForOrganization(db, ORG, capability.id))?.id,
		).toBe(capability.id);
		expect(
			await getCapabilityByIdForOrganization(db, OTHER_ORG, capability.id),
		).toBeUndefined();
	});
});
