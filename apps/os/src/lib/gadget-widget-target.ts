import type { OsGadgetManifest } from "@tedix/api-contract/schemas/os-workspaces";

export type GadgetWidgetTarget = {
	appSlug: string;
	resourceUri: string;
};

const MCP_APP_SLUG_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;

/** Validate the standard MCP Apps resource URI accepted by the governed host. */
export function widgetTargetFromResourceUri(
	resourceUri: unknown,
): GadgetWidgetTarget | null {
	if (typeof resourceUri !== "string" || resourceUri.trim() === "") return null;
	const normalizedResourceUri = resourceUri.trim();
	let parsed: URL;
	try {
		parsed = new URL(normalizedResourceUri);
	} catch {
		return null;
	}
	if (
		parsed.protocol !== "ui:" ||
		parsed.hostname !== "widgets" ||
		parsed.username !== "" ||
		parsed.password !== "" ||
		parsed.port !== ""
	) {
		return null;
	}
	const segments = parsed.pathname.split("/").filter(Boolean);
	const [namespace, appSlug, ...resourcePath] = segments;
	if (
		namespace !== "mcp-app" ||
		!appSlug ||
		!MCP_APP_SLUG_PATTERN.test(appSlug) ||
		resourcePath.length === 0
	) {
		return null;
	}
	return { appSlug, resourceUri: normalizedResourceUri };
}

/** Validate a gadget manifest entry for the governed MCP Apps host. */
export function gadgetWidgetTargetFromManifest(
	manifest: OsGadgetManifest | null | undefined,
): GadgetWidgetTarget | null {
	return widgetTargetFromResourceUri(manifest?.entry);
}
