import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "@tedix/db/query-client";
import { eq } from "drizzle-orm";
import {
	osGadgets,
	osGadgetRevisions,
	osOutputRevisions,
	osOutputs,
	osWorkspaceResources,
} from "@tedix/db/schema/os-workspaces";
import { clients } from "./__tests__/os-workspaces-env";

async function seedOutputWithoutEditor(
	db: ReturnType<typeof createDbQueryClient>,
	workspaceId: string,
	kind: "document" | "sheet" | "presentation",
	accessEnvelope: string | null = JSON.stringify({ version: 1, sources: [] }),
) {
	const output = { id: crypto.randomUUID() };
	const revision = { id: crypto.randomUUID() };
	const content =
		kind === "document"
			? { kind, blocks: [] }
			: kind === "sheet"
				? { kind, columns: [], rows: [] }
				: { kind, slides: [] };
	await db.insert(osOutputs).values({
		id: output.id,
		organizationId: "org-1",
		workspaceId,
		kind,
		title: "Keep",
		currentRevisionId: revision.id,
		createdByKind: "user",
		createdById: "user-1",
	});
	await db.insert(osOutputRevisions).values({
		id: revision.id,
		organizationId: "org-1",
		outputId: output.id,
		revision: 1,
		content: JSON.stringify(content),
		accessEnvelope,
		createdByKind: "user",
		createdById: "user-1",
	});
	return { output, revision };
}

describe("workspace editor blueprints", () => {
	it.each(["document", "sheet", "presentation"] as const)(
		"installs and independently reuses a %s gadget without copying the output",
		async (kind) => {
			const c = clients();
			const { workspace } = await c.org1.workspaces.create({ name: "Office" });
			const made = await c.org1.outputs.create({
				workspaceId: workspace.id,
				kind,
				title: "Original",
			});
			const input = {
				workspaceId: workspace.id,
				outputId: made.output.id,
				kind,
			};
			const installed = await c.org1.gadgets.installOutputEditor(input);
			expect((await c.org1.gadgets.installOutputEditor(input)).gadget.id).toBe(
				installed.gadget.id,
			);
			const resources = await c.org1.resources.list({
				workspaceId: workspace.id,
			});
			expect(resources.items).toHaveLength(1);
			expect(resources.items[0]?.metadata).toMatchObject({
				gadgetId: installed.gadget.id,
				kind,
			});
			expect(
				(await c.org1.outputs.get({ outputId: made.output.id })).currentRevision
					?.id,
			).toBe(made.revision.id);
			const templates = await c.org1.blueprints.list({});
			expect(templates.items).toHaveLength(1);
			const clone = await c.org1.blueprints.instantiate({
				blueprintId: templates.items[0]!.id,
				workspaceName: "Independent",
			});
			const clonedResources = await c.org1.resources.list({
				workspaceId: clone.workspace.id,
			});
			const clonedOutput = clonedResources.items.find(
				(r) => r.resourceType === "output",
			)!;
			expect(clonedOutput.providerResourceId).not.toBe(made.output.id);
			const blank = await c.org1.outputs.get({
				outputId: clonedOutput.providerResourceId,
			});
			expect(blank.currentRevision?.revision).toBe(1);
			expect(blank.output.kind).toBe(kind);
			const reopened = await c.org1.gadgets.installOutputEditor({
				workspaceId: clone.workspace.id,
				outputId: blank.output.id,
				kind,
			});
			expect(reopened.gadget.id).toBe(clone.gadgets[0]!.gadget.id);
			expect(
				(await c.org1.gadgets.list({ workspaceId: clone.workspace.id })).items,
			).toHaveLength(1);
		},
	);

	it("upgrades the pinned editor with CAS and retains the document identity and history", async () => {
		const c = clients();
		const { workspace } = await c.org1.workspaces.create({ name: "Docs" });
		const made = await c.org1.outputs.create({
			workspaceId: workspace.id,
			kind: "document",
			title: "Keep",
			content: {
				kind: "document",
				blocks: [{ type: "paragraph", text: "Keep this paragraph" }],
			},
		});
		const input = {
			workspaceId: workspace.id,
			outputId: made.output.id,
			kind: "document" as const,
		};
		const installed = await c.org1.gadgets.installOutputEditor(input);
		const db = createDbQueryClient(c.env.DB);
		await db
			.update(osGadgets)
			.set({ sourceBlueprintRevisionId: null })
			.where(eq(osGadgets.id, installed.gadget.id));
		const old = await c.org1.gadgets.get({
			workspaceId: workspace.id,
			gadgetId: installed.gadget.id,
		});
		const upgrade = {
			...input,
			upgradeFromRevisionId: old.currentRevision!.id,
		};
		const upgraded = await c.org1.gadgets.installOutputEditor(upgrade);
		expect(upgraded.gadget.id).toBe(installed.gadget.id);
		expect(upgraded.gadget.currentRevisionId).not.toBe(old.currentRevision!.id);
		expect(
			(await c.org1.gadgets.installOutputEditor(upgrade)).gadget
				.currentRevisionId,
		).toBe(upgraded.gadget.currentRevisionId);
		const current = await c.org1.gadgets.get({
			workspaceId: workspace.id,
			gadgetId: upgraded.gadget.id,
		});
		expect(current.currentRevision?.revision).toBe(2);
		expect(current.currentRevision?.manifest.config?.settings).toMatchObject({
			editor: "document-v4",
			blueprintVersion: 15,
		});
		expect((await db.select().from(osGadgetRevisions)).length).toBe(2);
		await expect(
			c.org1.gadgets.installOutputEditor({
				...input,
				upgradeFromRevisionId: crypto.randomUUID(),
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		const output = await c.org1.outputs.get({ outputId: made.output.id });
		expect(output.currentRevision?.id).toBe(made.revision.id);
		expect(output.currentRevision?.content).toEqual(made.revision.content);
	});

	it("rejects reopening a gadget retargeted to another slot without overwriting its custom revision", async () => {
		const c = clients();
		const { workspace } = await c.org1.workspaces.create({ name: "Docs" });
		const made = await c.org1.outputs.create({
			workspaceId: workspace.id,
			kind: "document",
			title: "Original",
		});
		const input = {
			workspaceId: workspace.id,
			outputId: made.output.id,
			kind: "document" as const,
		};
		const installed = await c.org1.gadgets.installOutputEditor(input);
		const current = await c.org1.gadgets.get({
			workspaceId: workspace.id,
			gadgetId: installed.gadget.id,
		});
		const revised = await c.org1.gadgets.revise({
			workspaceId: workspace.id,
			gadgetId: installed.gadget.id,
			files: (
				await c.org1.gadgets.getCode({
					workspaceId: workspace.id,
					gadgetId: installed.gadget.id,
				})
			).code!.files,
			manifest: {
				...current.currentRevision!.manifest,
				config: { version: 1, settings: { slot: "different" } },
			},
			expectedRevision: 1,
		});
		await expect(
			c.org1.gadgets.installOutputEditor(input),
		).rejects.toMatchObject({ code: "CONFLICT" });
		await expect(
			c.org1.gadgets.installOutputEditor({
				...input,
				upgradeFromRevisionId: revised.revision.id,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(
			(
				await c.org1.gadgets.get({
					workspaceId: workspace.id,
					gadgetId: installed.gadget.id,
				})
			).currentRevision?.id,
		).toBe(revised.revision.id);
		expect(
			(await c.org1.outputs.get({ outputId: made.output.id })).currentRevision
				?.id,
		).toBe(made.revision.id);
	});

	it("links an existing resource without losing its metadata or rebinding its output", async () => {
		const c = clients();
		const { workspace } = await c.org1.workspaces.create({ name: "Docs" });
		const db = createDbQueryClient(c.env.DB);
		// An output from before attach-on-create: a resource, but no editor.
		const made = await seedOutputWithoutEditor(db, workspace.id, "sheet");
		await db.insert(osWorkspaceResources).values({
			id: crypto.randomUUID(),
			organizationId: "org-1",
			workspaceId: workspace.id,
			slot: "existing",
			providerId: "tedix",
			connectionScope: "tenant",
			resourceType: "output",
			providerResourceId: made.output.id,
			name: "Keep",
			metadata: JSON.stringify({ custom: "retained" }),
			createdByKind: "user",
			createdById: "user-1",
		});
		const installed = await c.org1.gadgets.installOutputEditor({
			workspaceId: workspace.id,
			outputId: made.output.id,
			kind: "sheet",
		});
		const resources = await c.org1.resources.list({
			workspaceId: workspace.id,
		});
		expect(resources.items).toHaveLength(1);
		expect(resources.items[0]).toMatchObject({
			slot: "existing",
			providerResourceId: made.output.id,
			metadata: {
				custom: "retained",
				gadgetId: installed.gadget.id,
				kind: "sheet",
			},
		});
		await expect(
			c.org2.gadgets.installOutputEditor({
				workspaceId: workspace.id,
				outputId: made.output.id,
				kind: "sheet",
			}),
		).rejects.toThrow();
		await expect(
			c.org1.gadgets.installOutputEditor({
				workspaceId: workspace.id,
				outputId: made.output.id,
				kind: "presentation",
			}),
		).rejects.toThrow();
	});
});

describe("editor gadget attach on create", () => {
	async function editorBinding(
		c: ReturnType<typeof clients>,
		workspaceId: string,
		outputId: string,
	) {
		const resources = await c.org1.resources.list({ workspaceId });
		const binding = resources.items.find(
			(item) =>
				item.resourceType === "output" && item.providerResourceId === outputId,
		);
		if (!binding) return null;
		const gadgetId = (binding.metadata as { gadgetId?: string }).gadgetId;
		const gadget = gadgetId
			? await c.org1.gadgets.get({ workspaceId, gadgetId })
			: null;
		return { metadata: binding.metadata, gadget: gadget?.gadget };
	}

	it.each([
		["a person", "org1"],
		["a tedi or skill key", "machine"],
		["an external agent", "machineAgent"],
	] as const)(
		"opens every office kind created by %s in its editor gadget",
		async (_creator, client) => {
			const c = clients();
			const { workspace } = await c.org1.workspaces.create({ name: "Office" });
			for (const kind of ["document", "sheet", "presentation"] as const) {
				const made = await c[client].outputs.create({
					workspaceId: workspace.id,
					kind,
					title: `New ${kind}`,
				});
				const binding = await editorBinding(c, workspace.id, made.output.id);
				expect(binding?.metadata).toMatchObject({ kind });
				expect(binding?.gadget).toMatchObject({ status: "active" });
				// Opening again reuses the attached editor instead of a second one.
				expect(
					(
						await c.org1.gadgets.installOutputEditor({
							workspaceId: workspace.id,
							outputId: made.output.id,
							kind,
						})
					).gadget.id,
				).toBe(binding?.gadget?.id);
				// The gadget renders the typed Output; its revision is untouched.
				const read = await c.org1.outputs.get({ outputId: made.output.id });
				expect(read.currentRevision?.id).toBe(made.revision.id);
			}
			expect(
				(await c.org1.gadgets.list({ workspaceId: workspace.id })).items,
			).toHaveLength(3);
			expect((await c.org1.blueprints.list({})).items).toHaveLength(3);
		},
	);

	it("attaches an editor when an output without a workspace moves into one", async () => {
		const c = clients();
		const made = await c.org1.outputs.create({ kind: "sheet", title: "Loose" });
		const { workspace } = await c.org1.workspaces.create({ name: "Home" });
		expect(await editorBinding(c, workspace.id, made.output.id)).toBeNull();
		await c.org1.outputs.move({
			outputId: made.output.id,
			workspaceId: workspace.id,
		});
		const binding = await editorBinding(c, workspace.id, made.output.id);
		expect(binding?.gadget).toMatchObject({ status: "active" });
	});

	it("still moves an output whose source access cannot be checked, without forcing an editor", async () => {
		const c = clients();
		const from = await c.org1.workspaces.create({ name: "From" });
		const to = await c.org1.workspaces.create({ name: "To" });
		const db = createDbQueryClient(c.env.DB);
		const made = await seedOutputWithoutEditor(
			db,
			from.workspace.id,
			"document",
			null,
		);
		const moved = await c.org1.outputs.move({
			outputId: made.output.id,
			workspaceId: to.workspace.id,
		});
		expect(moved.output.workspaceId).toBe(to.workspace.id);
		expect(await editorBinding(c, to.workspace.id, made.output.id)).toBeNull();
		expect(
			(await c.org1.gadgets.list({ workspaceId: to.workspace.id })).items,
		).toHaveLength(0);
	});

	it("keeps per-output editors out of a saved blueprint and its limits", async () => {
		const c = clients();
		const { workspace } = await c.org1.workspaces.create({ name: "Files" });
		for (let index = 0; index < 30; index++)
			await c.org1.outputs.create({
				workspaceId: workspace.id,
				kind: "document",
				title: `Private title ${index}`,
			});
		const saved = await c.org1.blueprints.saveWorkspace({
			workspaceId: workspace.id,
			name: "Empty kit",
		});
		expect(saved.revision.definition.gadgets).toEqual([]);
		expect(saved.revision.definition.requirements?.resources).toEqual([]);
		expect(JSON.stringify(saved.revision.definition)).not.toContain(
			"Private title",
		);
	});
});
