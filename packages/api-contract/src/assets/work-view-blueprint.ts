import type { OsGadgetManifest } from "../schemas/os-workspaces";
import { APP_RUNTIME_ENTRY } from "../schemas/os-app-runtime";

const workEntries = {
	feed: "tedix:app/activity-feed",
	deck: "tedix:app/decision-deck",
} as const;

export function workViewRole(manifest: OsGadgetManifest) {
	const role = manifest.navigation?.work;
	const settings = manifest.config?.settings;
	return role &&
		manifest.entry === APP_RUNTIME_ENTRY &&
		settings &&
		typeof settings === "object" &&
		!Array.isArray(settings) &&
		settings.workView === role
		? role
		: null;
}

/** The authenticated Work tools use the same source settings as the installed view. */
export function workSourceManifest(
	manifest: OsGadgetManifest,
): OsGadgetManifest {
	const role = workViewRole(manifest);
	if (!role) return manifest;
	const settings = manifest.config!.settings as Record<string, unknown>;
	return {
		...manifest,
		entry: workEntries[role],
		config: settings.workConfig as OsGadgetManifest["config"],
	};
}

export function buildWorkView(manifest: OsGadgetManifest) {
	const role = manifest.navigation?.work;
	if (
		!role ||
		manifest.entry !== workEntries[role] ||
		manifest.config?.presentationGadgetId
	)
		return null;
	const files = {
		"server.js": "export class App {}",
		"client.js": 'void tedix.call("work.display", {});\n',
		"README.md": `This workspace owns this copy. Edit client.js and publish a new revision. tedix.call("work.display", {}) opens the signed-in member’s ${role === "feed" ? "Activity feed. Set postsPerPage to 1–50 to change the number of updates." : "Decisions. Set cardLayout to compact or full."} You can add your own interface in #app. Private cards and approval controls stay in the host. For MCP calls from server.js, bind a connection and call its granted tools through env.TEDIX.connectionsCall.\n`,
	};
	return {
		manifest: {
			...manifest,
			entry: APP_RUNTIME_ENTRY,
			config: {
				version: 1,
				settings: { workView: role, workConfig: manifest.config ?? {} },
			},
		},
		files,
	};
}
