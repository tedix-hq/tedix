import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "@tedix/db/query-client";
import { eq } from "drizzle-orm";
import { osOutputRevisions } from "@tedix/db/schema/os-workspaces";
import { clients } from "./__tests__/os-workspaces-env";

describe("Doc blueprint installation", () => {
	it("pins a real reusable app to the existing output without copying content or history", async () => {
		const c = clients();
		const { workspace } = await c.org1.workspaces.create({ name: "Docs" });
		const made = await c.org1.outputs.create({
			workspaceId: workspace.id,
			kind: "document",
			title: "Notes",
			content: {
				kind: "document",
				blocks: [{ type: "paragraph", text: "Keep my content" }],
			},
		});
		const installed = await c.org1.gadgets.installDocument({
			workspaceId: workspace.id,
			outputId: made.output.id,
		});
		expect(
			await c.org1.gadgets.installDocument({
				workspaceId: workspace.id,
				outputId: made.output.id,
			}),
		).toEqual(installed);
		const { gadget, currentRevision } = await c.org1.gadgets.get({
			workspaceId: workspace.id,
			gadgetId: installed.gadget.id,
		});
		expect(gadget.sourceBlueprintRevisionId).toBeTruthy();
		expect(currentRevision?.manifest.entry).toBe("tedix:runtime/v1");
		expect(
			currentRevision?.manifest.operations?.map((operation) => operation.name),
		).toEqual([
			"readDocument",
			"replaceDocument",
			"editDocument",
			"exportMarkdown",
		]);
		const code = await c.org1.gadgets.getCode({
			workspaceId: workspace.id,
			gadgetId: gadget.id,
		});
		expect(code.code?.files["server.js"]).toContain("outputsRead");
		const resources = await c.org1.resources.list({
			workspaceId: workspace.id,
		});
		expect(
			resources.items.filter(
				(resource) => resource.providerResourceId === made.output.id,
			),
		).toHaveLength(1);
		const after = await c.org1.outputs.get({ outputId: made.output.id });
		expect(after.currentRevision?.id).toBe(made.revision.id);
		expect(after.currentRevision?.content).toEqual(made.revision.content);
		const templates = await c.org1.blueprints.list({});
		expect(templates.items).toHaveLength(1);
		const template = await c.org1.blueprints.get({
			blueprintId: templates.items[0]!.id,
		});
		expect(JSON.stringify(template.currentRevision?.definition)).not.toContain(
			"Keep my content",
		);
		expect(template.blueprint.visibility).toBe("org");
	});
	it("rejects another workspace, tenant, non-document and unverified source access", async () => {
		const c = clients();
		const { workspace } = await c.org1.workspaces.create({ name: "Docs" });
		const { workspace: other } = await c.org1.workspaces.create({
			name: "Other",
		});
		const made = await c.org1.outputs.create({
			workspaceId: workspace.id,
			kind: "document",
			title: "Restricted",
		});
		await expect(
			c.org1.gadgets.installDocument({
				workspaceId: other.id,
				outputId: made.output.id,
			}),
		).rejects.toThrow();
		await expect(
			c.org2.gadgets.installDocument({
				workspaceId: workspace.id,
				outputId: made.output.id,
			}),
		).rejects.toThrow();
		const sheet = await c.org1.outputs.create({
			workspaceId: workspace.id,
			kind: "sheet",
			title: "Sheet",
		});
		await expect(
			c.org1.gadgets.installDocument({
				workspaceId: workspace.id,
				outputId: sheet.output.id,
			}),
		).rejects.toThrow();
		await createDbQueryClient(c.env.DB)
			.update(osOutputRevisions)
			.set({ accessEnvelope: null })
			.where(eq(osOutputRevisions.id, made.revision.id));
		await expect(
			c.org1.gadgets.installDocument({
				workspaceId: workspace.id,
				outputId: made.output.id,
			}),
		).rejects.toThrow("Output source access is unavailable");
		expect(
			(await c.org1.gadgets.list({ workspaceId: workspace.id })).items,
		).toHaveLength(0);
	});
});
