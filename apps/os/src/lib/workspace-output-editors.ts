import type { OsWorkspaceResource } from "@tedix/api-contract/schemas/os-workspaces";

type EditorResource = Pick<
	OsWorkspaceResource,
	"providerId" | "resourceType" | "providerResourceId" | "metadata"
> & { status?: string };

/** Navigation hints never grant access; only apps in this workspace can match. */
export function workspaceOutputEditors(
	resources: readonly EditorResource[],
	gadgets: readonly { id: string; status?: string }[],
): Map<string, string> {
	const active = new Set(
		gadgets.filter((row) => row.status !== "archived").map((row) => row.id),
	);
	const editors = new Map<string, string>();
	for (const row of resources) {
		const gadgetId = row.metadata.gadgetId;
		if (
			row.providerId === "tedix" &&
			row.resourceType === "output" &&
			(row.status === undefined || row.status === "active") &&
			typeof gadgetId === "string" &&
			active.has(gadgetId)
		)
			editors.set(row.providerResourceId, gadgetId);
	}
	return editors;
}

/** File editors follow the bound file's title while app names identify standalone apps. */
export function workspaceAppTitles<App extends { id: string; name: string }>(
	apps: readonly App[],
	outputs: readonly { id: string; title: string }[],
	editors: ReadonlyMap<string, string>,
): App[] {
	const titles = new Map<string, string>();
	for (const output of outputs) {
		const appId = editors.get(output.id);
		if (appId) titles.set(appId, output.title);
	}
	return apps.map((app) => {
		const name = titles.get(app.id);
		return name === undefined ? app : { ...app, name };
	});
}
