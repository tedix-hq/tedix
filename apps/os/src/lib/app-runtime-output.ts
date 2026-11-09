import type { OsOutputContent } from "@tedix/api-contract/schemas/os-workspaces";

export async function replaceAppRuntimeOutput(input: {
	workspaceId: string;
	outputId: string;
	content: OsOutputContent;
	expectedRevision: number;
}) {
	const { osApi } = await import("./api");
	return osApi.osWorkspaces.outputs.revise({
		outputId: input.outputId,
		expectedWorkspaceId: input.workspaceId,
		content: input.content,
		expectedRevision: input.expectedRevision,
		note: "Saved from workspace app",
	});
}
