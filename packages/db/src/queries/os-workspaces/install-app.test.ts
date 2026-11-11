import { eq } from "drizzle-orm";
import { createOsBlueprintRevision } from "./blueprints";
import { createOsGadgetRevision } from "./gadgets";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import {
	osBlueprints,
	osBlueprintRevisions,
	osGadgets,
	osGadgetRevisions,
	osGadgetCode,
	osGadgetCodeBlobs,
	osWorkspaceResources,
	osWorkspaces,
} from "../../schema/os-workspaces";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import {
	installWorkspaceApp,
	publishWorkspaceAppTemplate,
	findWorkspaceOutputEditor,
	linkWorkspaceOutputEditor,
	type InstallWorkspaceAppParams,
} from "./install-app";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		"PRAGMA foreign_keys = ON; CREATE TABLE organizations(id TEXT PRIMARY KEY); INSERT INTO organizations VALUES ('org');",
	);
	sqlite.exec(
		schemaDdl(
			osWorkspaces,
			osBlueprints,
			osBlueprintRevisions,
			osGadgets,
			osGadgetRevisions,
			osGadgetCode,
			osGadgetCodeBlobs,
			osWorkspaceResources,
		),
	);
	const base = {
		organizationId: "org",
		createdByKind: "user" as const,
		createdById: "user",
	};
	const params: InstallWorkspaceAppParams = {
		templateVersion: 1,
		blueprint: {
			...base,
			id: "blueprint",
			name: "Doc",
			currentRevisionId: "blueprint-revision",
		},
		blueprintRevision: {
			...base,
			id: "blueprint-revision",
			blueprintId: "blueprint",
			definition: '{"gadgets":[]}',
		},
		gadget: {
			...base,
			id: "app",
			workspaceId: "workspace",
			name: "Doc",
			currentRevisionId: "revision",
			sourceBlueprintRevisionId: "blueprint-revision",
		},
		revision: {
			...base,
			id: "revision",
			gadgetId: "app",
			revision: 1,
			manifest: "{}",
		},
		code: {
			organizationId: "org",
			revisionId: "revision",
			gadgetId: "app",
			files: '{"client.js":"","server.js":""}',
			codeLength: 0,
		},
		resource: {
			...base,
			id: "resource",
			workspaceId: "workspace",
			slot: "document",
			providerId: "tedix",
			connectionScope: "tenant",
			resourceType: "output",
			providerResourceId: "output",
			name: "Doc",
		},
	};
	return { db: createDbQueryClient(createD1Facade(sqlite)), params };
}

function templateDefinition(version: number, custom = false) {
	return JSON.stringify({
		gadgets: [
			{
				manifest: {
					config: { settings: { blueprintVersion: version, custom } },
				},
			},
		],
	});
}

function publication(params: InstallWorkspaceAppParams, version: number) {
	return {
		templateVersion: version,
		blueprint: params.blueprint,
		blueprintRevision: {
			...params.blueprintRevision,
			id: `bundled-${version}`,
			definition: templateDefinition(version),
		},
	};
}

async function seedWorkspace(db: ReturnType<typeof createDbQueryClient>) {
	await db.insert(osWorkspaces).values({
		id: "workspace",
		organizationId: "org",
		name: "Docs",
		createdByKind: "user",
		createdById: "user",
	});
}

describe("workspace app installation", () => {
	it("allocates bundle revisions after custom edits and preserves same-version custom publication on retry", async () => {
		const { db, params } = fixture();
		await seedWorkspace(db);
		await installWorkspaceApp(db, params);
		const custom = templateDefinition(1, true);
		expect(
			(
				await createOsBlueprintRevision(db, {
					id: "custom-2",
					organizationId: "org",
					blueprintId: "blueprint",
					definition: custom,
					createdByKind: "user",
					createdById: "user",
					expectedRevision: 1,
				})
			).ok,
		).toBe(true);
		await publishWorkspaceAppTemplate(db, publication(params, 2));
		let history = await db.select().from(osBlueprintRevisions);
		expect(history.map((row) => row.revision)).toEqual([1, 2, 3]);
		expect(history.find((row) => row.id === "custom-2")?.definition).toBe(
			custom,
		);
		expect((await db.select().from(osBlueprints))[0]?.currentRevisionId).toBe(
			"bundled-2",
		);
		expect(
			(await db.select().from(osGadgets))[0]?.sourceBlueprintRevisionId,
		).toBe("blueprint-revision");
		expect(
			(
				await createOsBlueprintRevision(db, {
					id: "custom-4",
					organizationId: "org",
					blueprintId: "blueprint",
					definition: templateDefinition(2, true),
					createdByKind: "user",
					createdById: "user",
					expectedRevision: 3,
				})
			).ok,
		).toBe(true);
		await publishWorkspaceAppTemplate(db, publication(params, 2));
		await publishWorkspaceAppTemplate(db, params);
		history = await db.select().from(osBlueprintRevisions);
		expect(history).toHaveLength(4);
		expect((await db.select().from(osBlueprints))[0]?.currentRevisionId).toBe(
			"custom-4",
		);
	});
	it("does not regress publication when an older bundle is first encountered after a newer historical bundle", async () => {
		const { db, params } = fixture();
		await seedWorkspace(db);
		await installWorkspaceApp(db, params);
		await publishWorkspaceAppTemplate(db, publication(params, 3));
		expect(
			(
				await createOsBlueprintRevision(db, {
					id: "custom-current",
					organizationId: "org",
					blueprintId: "blueprint",
					definition: templateDefinition(1, true),
					createdByKind: "user",
					createdById: "user",
					expectedRevision: 2,
				})
			).ok,
		).toBe(true);
		await publishWorkspaceAppTemplate(db, publication(params, 2));
		const history = await db.select().from(osBlueprintRevisions);
		expect(history.find((row) => row.id === "bundled-2")?.revision).toBe(4);
		expect((await db.select().from(osBlueprints))[0]?.currentRevisionId).toBe(
			"custom-current",
		);
		const authored = await createOsBlueprintRevision(db, {
			id: "custom-after-hidden-history",
			organizationId: "org",
			blueprintId: "blueprint",
			definition: templateDefinition(3, true),
			createdByKind: "user",
			createdById: "user",
			expectedRevision: 3,
		});
		expect(authored).toMatchObject({ ok: true, revision: { revision: 5 } });
		expect((await db.select().from(osBlueprints))[0]?.currentRevisionId).toBe(
			"custom-after-hidden-history",
		);
		expect(
			await createOsBlueprintRevision(db, {
				id: "stale-custom",
				organizationId: "org",
				blueprintId: "blueprint",
				definition: templateDefinition(3, true),
				createdByKind: "user",
				createdById: "user",
				expectedRevision: 3,
			}),
		).toEqual({ ok: false, reason: "revision_conflict" });
		expect((await db.select().from(osBlueprints))[0]?.currentRevisionId).toBe(
			"custom-after-hidden-history",
		);
	});
	it("refuses a stale or archived gadget revision when attaching its output editor", async () => {
		const { db, params } = fixture();
		await seedWorkspace(db);
		await installWorkspaceApp(db, params);
		const link = {
			organizationId: "org",
			workspaceId: "workspace",
			resourceId: "resource",
			outputId: "output",
			expectedSlot: "document",
			expectedGadgetRevisionId: "revision",
			gadgetId: "app",
			kind: "document",
			now: new Date().toISOString(),
		};
		expect(
			(
				await createOsGadgetRevision(db, {
					id: "next-revision",
					organizationId: "org",
					gadgetId: "app",
					manifest: "{}",
					createdByKind: "user",
					createdById: "user",
					expectedRevision: 1,
				})
			).ok,
		).toBe(true);
		expect(await linkWorkspaceOutputEditor(db, link)).toBeUndefined();
		expect((await db.select().from(osWorkspaceResources))[0]?.metadata).toBe(
			"{}",
		);
		expect(
			await linkWorkspaceOutputEditor(db, {
				...link,
				expectedGadgetRevisionId: "next-revision",
			}),
		).toEqual({ id: "resource" });
		await db
			.update(osGadgets)
			.set({ status: "archived" })
			.where(eq(osGadgets.id, "app"));
		expect(
			await linkWorkspaceOutputEditor(db, {
				...link,
				expectedGadgetRevisionId: "next-revision",
			}),
		).toBeUndefined();
	});

	it("refuses to link an editor after its resource slot was renamed", async () => {
		const { db, params } = fixture();
		await db.insert(osWorkspaces).values({
			id: "workspace",
			organizationId: "org",
			name: "Docs",
			createdByKind: "user",
			createdById: "user",
		});
		await installWorkspaceApp(db, params);
		const link = {
			organizationId: "org",
			workspaceId: "workspace",
			resourceId: "resource",
			outputId: "output",
			gadgetId: "app",
			expectedGadgetRevisionId: "revision",
			kind: "document",
			now: new Date().toISOString(),
		};
		expect(
			await linkWorkspaceOutputEditor(db, { ...link, expectedSlot: "renamed" }),
		).toBeUndefined();
		expect((await db.select().from(osWorkspaceResources))[0]?.metadata).toBe(
			"{}",
		);
		expect(
			await linkWorkspaceOutputEditor(db, {
				...link,
				expectedSlot: "document",
			}),
		).toEqual({ id: "resource" });
	});
	it("publishes newer template versions without moving existing app pins or regressing publication", async () => {
		const { db, params } = fixture();
		await db.insert(osWorkspaces).values({
			id: "workspace",
			organizationId: "org",
			name: "Docs",
			createdByKind: "user",
			createdById: "user",
		});
		params.revision.manifest = JSON.stringify({
			config: { settings: { slot: "document" } },
		});
		await installWorkspaceApp(db, params);
		const next = {
			templateVersion: 2,
			blueprint: params.blueprint,
			blueprintRevision: {
				...params.blueprintRevision,
				id: "blueprint-v2",
				definition: templateDefinition(2),
			},
		};
		await publishWorkspaceAppTemplate(db, next);
		await publishWorkspaceAppTemplate(db, params);
		expect((await db.select().from(osBlueprints))[0]?.currentRevisionId).toBe(
			"blueprint-v2",
		);
		expect(
			(await db.select().from(osGadgets))[0]?.sourceBlueprintRevisionId,
		).toBe("blueprint-revision");
		expect(
			await findWorkspaceOutputEditor(db, {
				organizationId: "org",
				workspaceId: "workspace",
				blueprintId: "blueprint",
				slot: "document",
			}),
		).toMatchObject({ id: "app" });
		expect(
			await findWorkspaceOutputEditor(db, {
				organizationId: "other-org",
				workspaceId: "workspace",
				blueprintId: "blueprint",
				slot: "document",
			}),
		).toBeUndefined();
		expect(
			await findWorkspaceOutputEditor(db, {
				organizationId: "org",
				workspaceId: "workspace",
				blueprintId: "blueprint",
				slot: "other",
			}),
		).toBeUndefined();
	});
	it("installs the template, code and capability atomically and retries by stable identity", async () => {
		const { db, params } = fixture();
		await db.insert(osWorkspaces).values({
			id: "workspace",
			organizationId: "org",
			name: "Docs",
			createdByKind: "user",
			createdById: "user",
		});
		await installWorkspaceApp(db, params);
		await installWorkspaceApp(db, params);
		expect(await db.select().from(osGadgets)).toHaveLength(1);
		expect(await db.select().from(osGadgetCode)).toHaveLength(1);
		expect(await db.select().from(osBlueprintRevisions)).toHaveLength(1);
		expect(await db.select().from(osWorkspaceResources)).toHaveLength(1);
	});
	it("adds only a pointer when another output gets the same editor", async () => {
		const { db, params } = fixture();
		await db.insert(osWorkspaces).values({
			id: "workspace",
			organizationId: "org",
			name: "Docs",
			createdByKind: "user",
			createdById: "user",
		});
		await installWorkspaceApp(db, params);
		await installWorkspaceApp(db, {
			...params,
			gadget: {
				...params.gadget,
				id: "app-2",
				name: "Second editor",
				currentRevisionId: "app-2-revision",
			},
			revision: { ...params.revision, id: "app-2-revision", gadgetId: "app-2" },
			code: { ...params.code, revisionId: "app-2-revision", gadgetId: "app-2" },
			resource: undefined,
		});
		const code = await db.select().from(osGadgetCode);
		expect(code).toHaveLength(2);
		expect(code.every((row) => row.files === "")).toBe(true);
		expect(new Set(code.map((row) => row.filesSha256)).size).toBe(1);
		const blobs = await db.select().from(osGadgetCodeBlobs);
		expect(blobs).toHaveLength(1);
		expect(blobs[0]).toMatchObject({
			organizationId: "org",
			sha256: code[0]!.filesSha256,
			files: params.code.files,
		});
	});
	it("rolls back every app and template row when the output slot conflicts", async () => {
		const { db, params } = fixture();
		await db.insert(osWorkspaces).values({
			id: "workspace",
			organizationId: "org",
			name: "Docs",
			createdByKind: "user",
			createdById: "user",
		});
		await db.insert(osWorkspaceResources).values({
			...params.resource!,
			id: "other",
			providerResourceId: "other-output",
		});
		await expect(installWorkspaceApp(db, params)).rejects.toThrow();
		expect(await db.select().from(osGadgets)).toHaveLength(0);
		expect(await db.select().from(osGadgetCode)).toHaveLength(0);
		expect(await db.select().from(osGadgetCodeBlobs)).toHaveLength(0);
		expect(await db.select().from(osBlueprints)).toHaveLength(0);
	});
});
