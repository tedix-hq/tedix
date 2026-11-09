import type { OsOutputExportFormat } from "@tedix/api-contract/schemas/os-workspaces";

export async function exportAppRuntimeOutput(input: {
	workspaceId: string;
	outputId: string;
	format: OsOutputExportFormat;
	expectedRevision: number;
	sheetId?: string;
}) {
	const { osApi, OS_API_URL } = await import("./api");
	const { workspaceId, ...request } = input;
	const result = await osApi.osWorkspaces.outputs.export({
		...request,
		expectedWorkspaceId: workspaceId,
	});
	if (result.revision !== input.expectedRevision)
		throw new Error("The saved revision changed. Reload before exporting.");
	const url = new URL(result.url);
	if (!url.pathname.startsWith("/os-exports/"))
		throw new Error("The export download is unavailable.");
	const filename = url.pathname.split("/").pop() ?? `export.${input.format}`;
	const download = document.createElement("a");
	download.href = `${OS_API_URL}${url.pathname}${url.search}`;
	download.download = filename;
	download.click();
	return { filename, revision: result.revision, format: result.format };
}
