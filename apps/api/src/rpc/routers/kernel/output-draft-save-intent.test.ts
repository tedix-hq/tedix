import { describe, expect, it } from "vite-plus/test";
import {
	outputDraftSaveTarget,
	renderOutputDraftSaveRequest,
} from "./output-draft-save-intent";

const workspace = {
	workspaceId: "11111111-1111-4111-8111-111111111111",
	workspaceName: "Review workspace",
	workpiece: {
		kind: "output" as const,
		id: "22222222-2222-4222-8222-222222222222",
		name: "Replies to review",
	},
};

describe("selected live-draft save guidance", () => {
	it.each([
		"Save version",
		"Please save a new version.",
		"Snapshot Replies to review rows 21–23 as v12",
		"Save this draft as a new version",
		`Snapshot ${workspace.workpiece.id} as v12`,
		`Snapshot selected draft /workspace/${workspace.workspaceId}?workpiece=output:${workspace.workpiece.id} as v12`,
	])(
		"routes an exact save request to the selected browser editor: %s",
		(request) => {
			expect(outputDraftSaveTarget(request, workspace)).toEqual({
				workspaceId: workspace.workspaceId,
				outputId: workspace.workpiece.id,
				name: workspace.workpiece.name,
			});
		},
	);

	it.each([
		"Save this invoice as a new version",
		"Save version and send it to a customer",
		"Update this draft and save a new version",
		"Save a version with updated content",
		"Save this draft as a new version with updated content",
		"Save this draft as v12 with text from the attachment",
		"Save this draft as v12 and export a PDF",
		"Save a new version in Notion",
		"Explain how to save version",
		"Do not save this draft",
		"Snapshot another ledger as v12",
		"Snapshot 33333333-3333-4333-8333-333333333333 as v12",
	])(
		"leaves unrelated, additional, or differently targeted changes alone: %s",
		(request) => {
			expect(outputDraftSaveTarget(request, workspace)).toBeNull();
		},
	);

	it("requires a selected output and keeps label text inside its link", () => {
		expect(outputDraftSaveTarget("Save version", undefined)).toBeNull();
		expect(
			outputDraftSaveTarget("Save version", {
				...workspace,
				workpiece: { ...workspace.workpiece, kind: "gadget" },
			}),
		).toBeNull();
		const target = outputDraftSaveTarget("Save version", {
			...workspace,
			workpiece: { ...workspace.workpiece, name: "Review [draft]" },
		});
		expect(target).not.toBeNull();
		const message = renderOutputDraftSaveRequest(target!);
		expect(message).toContain("[open Review \\[draft\\]]");
		expect(message).toContain(
			`/workspace/${workspace.workspaceId}?workpiece=output:${workspace.workpiece.id}`,
		);
		expect(message).toContain("Nothing was saved by this chat.");
	});
});
