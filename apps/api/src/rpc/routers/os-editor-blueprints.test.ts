import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "@tedix/db/query-client";
import { eq } from "drizzle-orm";
import {
	osGadgets,
	osGadgetRevisions,
	osWorkspaceResources,
} from "@tedix/db/schema/os-workspaces";
import { clients } from "./__tests__/os-workspaces-env";

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
			editor: "document-v2",
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

	it("links an existing resource without losing its metadata or rebinding its output", async () => {
		const c = clients();
		const { workspace } = await c.org1.workspaces.create({ name: "Docs" });
		const made = await c.org1.outputs.create({
			workspaceId: workspace.id,
			kind: "sheet",
			title: "Keep",
		});
		const db = createDbQueryClient(c.env.DB);
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
