import type {
	OsOutput,
	OsOutputLibraryItem,
} from "@tedix/api-contract/schemas/os-workspaces";
import { canvasDocKey, type CanvasSearch } from "@/lib/canvas-search";

export type OutputNavigationTarget =
	| {
			kind: "workspace";
			workspaceId: string;
			search: CanvasSearch;
	  }
	| { kind: "standalone"; outputId: string };

/**
 * Open outputs in their active workspace. Outputs without an active workspace
 * retain their standalone detail route.
 */
export function primaryOutputNavigationTarget(
	output: Pick<OsOutput, "id" | "workspaceId">,
	activeWorkspaceIds: ReadonlySet<string>,
): OutputNavigationTarget {
	if (output.workspaceId && activeWorkspaceIds.has(output.workspaceId)) {
		return {
			kind: "workspace",
			workspaceId: output.workspaceId,
			search: {
				workpiece: canvasDocKey({ type: "output", id: output.id }),
				pane: "workpiece",
			},
		};
	}
	return { kind: "standalone", outputId: output.id };
}

/**
 * Derive card and menu labels from the navigation target so their wording
 * matches the destination.
 */
export function outputOpenAffordance(
	item: Pick<OsOutputLibraryItem, "output" | "workspace">,
): { target: OutputNavigationTarget; cardLabel: string; menuLabel: string } {
	const target = primaryOutputNavigationTarget(
		item.output,
		new Set(item.workspace?.status === "active" ? [item.workspace.id] : []),
	);
	if (target.kind === "workspace") {
		return {
			target,
			cardLabel: `Open ${item.output.title} in ${item.workspace?.name ?? "its workspace"}`,
			menuLabel: "Open in workspace",
		};
	}
	return {
		target,
		cardLabel: `Open ${item.output.title}`,
		menuLabel: "Open output",
	};
}
