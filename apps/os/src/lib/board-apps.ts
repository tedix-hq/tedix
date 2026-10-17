import type {
	OsGadget,
	OsGadgetManifest,
} from "@tedix/api-contract/schemas/os-workspaces";

export function boardAppLink(
	gadget: Pick<OsGadget, "id" | "workspaceId" | "name" | "status">,
	manifest: OsGadgetManifest | null | undefined,
) {
	if (gadget.status !== "active" || manifest?.navigation?.board !== true)
		return null;
	return {
		id: gadget.id,
		name: gadget.name,
		href: `/workspace/${gadget.workspaceId}?workpiece=gadget:${gadget.id}&pane=workpiece`,
	};
}
