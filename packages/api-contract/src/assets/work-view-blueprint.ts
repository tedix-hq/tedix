import type { OsGadgetManifest } from "../schemas/os-workspaces";
import { APP_RUNTIME_ENTRY } from "../schemas/os-app-runtime";

import activityFiles from "../blueprints/activity/files.json";
import decisionsFiles from "../blueprints/decisions/files.json";
import { workLayouts } from "../blueprints/work-layout";

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
		"layout.json": JSON.stringify(workLayouts[role], null, 2) + "\n",
		...(role === "feed" ? activityFiles : decisionsFiles),
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
