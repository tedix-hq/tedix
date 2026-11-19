import { describe, expect, it } from "vite-plus/test";
import { OsAppDraftContentSchema } from "@tedix/api-contract/schemas/os-workspaces";
import { clients } from "../rpc/routers/__tests__/os-workspaces-env";
import { mergeBlueprintApp } from "./os-blueprint-upgrade";

function app(client: string, server = "export default {};\n") {
	return OsAppDraftContentSchema.parse({
		manifest: { entry: "tedix:runtime/v1", config: { version: 1 } },
		files: { "client.js": client, "server.js": server },
	});
}

describe("mergeBlueprintApp", () => {
	it("keeps local changes when the release has no changes for this app", () => {
		const base = app("const label = 'original';\n");
		const current = app("const label = 'my label';\n");
		expect(mergeBlueprintApp(base, current, base)).toMatchObject({
			content: current,
			conflicts: [],
			changed: false,
		});
	});

	it("combines edits on different lines of the same file", () => {
		const base = app("const label = 'original';\nconst count = 1;\n");
		const current = app("const label = 'my label';\nconst count = 1;\n");
		const release = app("const label = 'original';\nconst count = 2;\n");
		expect(mergeBlueprintApp(base, current, release)).toMatchObject({
			content: app("const label = 'my label';\nconst count = 2;\n"),
			conflicts: [],
			changed: true,
		});
	});

	it("keeps both versions of an overlapping edit for review", () => {
		const result = mergeBlueprintApp(
			app("const label = 'original';\n"),
			app("const label = 'my label';\n"),
			app("const label = 'new label';\n"),
		);
		expect(result.conflicts).toEqual(["client.js"]);
		expect(result.content.files["client.js"]).toContain("my label");
		expect(result.content.files["client.js"]).toContain("new label");
		expect(result.changed).toBe(true);
	});
});

it("opens a single-app update for review and discards it without changing any app", async () => {
	const { org1: os } = clients();
	const { blueprint } = await os.blueprints.create({ name: "Planning" });
	const installed = app("const label = 'original';\nconst count = 1;\n");
	const personal = app("const label = 'mine';\nconst count = 1;\n");
	const release = app("const label = 'original';\nconst count = 2;\n");
	const untouched = { name: "Notes", ...installed };
	await os.blueprints.revise({
		blueprintId: blueprint.id,
		definition: { gadgets: [{ name: "Plan", ...installed }, untouched] },
	});
	await os.blueprints.publish({ blueprintId: blueprint.id });
	const { workspace, gadgets } = await os.blueprints.instantiate({
		blueprintId: blueprint.id,
		workspaceName: "Team planning",
	});
	const plan = gadgets.find(({ gadget }) => gadget.name === "Plan")!;
	const notes = gadgets.find(({ gadget }) => gadget.name === "Notes")!;
	const scope = { workspaceId: workspace.id, gadgetId: plan.gadget.id };
	const notesScope = { workspaceId: workspace.id, gadgetId: notes.gadget.id };
	const local = await os.gadgets.revise({
		...scope,
		...personal,
		expectedRevision: 1,
	});

	await os.blueprints.revise({
		blueprintId: blueprint.id,
		definition: { gadgets: [{ name: "Plan", ...release }, untouched] },
	});
	await os.blueprints.publish({ blueprintId: blueprint.id });

	expect(await os.collaboration.previewBlueprintAppUpdate(notesScope)).toEqual({
		status: "no_change",
	});
	const preview = await os.collaboration.previewBlueprintAppUpdate(scope);
	expect(preview).toMatchObject({ status: "ready", conflicts: [] });
	if (preview.status !== "ready") throw new Error("Expected an update");
	const result = await os.collaboration.createBlueprintAppUpdate({
		...scope,
		releaseId: preview.releaseId,
		appRevisionId: preview.appRevisionId,
		mode: "merge",
	});
	expect(result).toMatchObject({
		status: "created",
		proposal: {
			status: "open",
			documentId: plan.gadget.id,
			baseRevisionId: local.revision.id,
			content: app("const label = 'mine';\nconst count = 2;\n"),
		},
	});
	if (result.status !== "created") throw new Error("Expected a draft");
	const discarded = await os.collaboration.reject({
		proposalId: result.proposal.id,
		expectedSequence: result.proposal.sequence,
		rationale: "Keep my current app",
	});
	expect(discarded.proposal.status).toBe("rejected");
	expect((await os.gadgets.getCode(scope)).code).toMatchObject({
		revisionId: local.revision.id,
		files: personal.files,
	});
	expect((await os.gadgets.getCode(notesScope)).code).toMatchObject({
		revisionId: notes.revision.id,
		files: installed.files,
	});
});
