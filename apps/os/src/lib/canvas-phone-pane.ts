/*
 * The tab a person last had open in a workspace on a phone (Chat, Files or
 * an open item), remembered per workspace and browser so opening the workspace again
 * starts where they left it.
 */

export type CanvasPhonePane = "chat" | "workpiece" | "files";

export const CANVAS_PHONE_PANE_KEY_PREFIX = "tedix-os:canvas-phone-pane:";

export function restoreCanvasPhonePane(
	storage: Pick<Storage, "getItem"> | null,
	workspaceId: string,
): CanvasPhonePane | null {
	try {
		const value = storage?.getItem(
			`${CANVAS_PHONE_PANE_KEY_PREFIX}${workspaceId}`,
		);
		return value === "chat" || value === "workpiece" || value === "files"
			? value
			: null;
	} catch {
		return null;
	}
}

export function persistCanvasPhonePane(
	storage: Pick<Storage, "setItem"> | null,
	workspaceId: string,
	pane: string | undefined,
) {
	if (pane !== "chat" && pane !== "workpiece" && pane !== "files") return;
	try {
		storage?.setItem(`${CANVAS_PHONE_PANE_KEY_PREFIX}${workspaceId}`, pane);
	} catch {
		// Remembering the tab is a convenience; the tabs still work.
	}
}
