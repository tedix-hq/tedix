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
