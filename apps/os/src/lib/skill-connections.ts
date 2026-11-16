import type { SkillEntry } from "@tedix/api-contract/schemas/cognitive";
import { deriveSkillAnatomy, inputLabel } from "@/lib/skill-anatomy";

/*
 * The connections a skill may call, read from what its saved version says:
 * the apps its connection names are linked to, the calls its workflow source
 * makes, and the tools its instructions name. Whether each one is ready comes
 * from the organization's installed apps; nothing here contacts a provider.
 */

export type SkillConnectionStatus =
	/** The linked app is installed and its requirements are met. */
	| "ready"
	| "setup_needed"
	| "plan_upgrade"
	/** Part of Tedix itself; nothing to connect. */
	| "built_in"
	/** The saved version links this name to no installed app. */
	| "no_app"
	/** Linked, or never checked, and the installed apps do not say. */
	| "unknown";

export type SkillConnection = {
	/** The name the skill's source uses for the connection. */
	namespace: string;
	/** The installed app's name, or the connection name in plain words. */
	label: string;
	appId: string | null;
	status: SkillConnectionStatus;
	/** What the skill calls on it: the raw call and a readable label. */
	tools: { call: string; label: string }[];
};

export type InstalledAppStatus = {
	appId: string;
	appName: string;
	badge: "ready" | "setup_needed" | "plan_upgrade";
};

/** Names Tedix answers itself; they are never linked to an app. */
const BUILT_IN = new Set([
	"os",
	"home",
	"kernel",
	"tedi",
	"cognitive",
	"rationale",
]);

export function deriveSkillConnections(
	skill: Pick<
		SkillEntry,
		"content" | "files" | "inputSchema" | "mcpAppBindings" | "tools"
	>,
	installed: readonly InstalledAppStatus[] | undefined,
): SkillConnection[] {
	const calls = new Map<string, Set<string>>();
	const note = (namespace: string, method?: string) => {
		if (!namespace) return;
		const methods = calls.get(namespace) ?? new Set<string>();
		if (method) methods.add(method);
		calls.set(namespace, methods);
	};
	for (const namespace of Object.keys(skill.mcpAppBindings ?? {}))
		note(namespace);
	for (const step of deriveSkillAnatomy(skill).steps)
		for (const call of step.toolCalls) {
			const [namespace, method] = call.split(".");
			note(namespace ?? "", method);
		}
	for (const tool of skill.tools ?? []) {
		const [namespace, method] = tool.split(".");
		note(namespace ?? "", method);
	}
	const apps = new Map((installed ?? []).map((app) => [app.appId, app]));
	return [...calls]
		.map(([namespace, methods]): SkillConnection => {
			const appId = skill.mcpAppBindings?.[namespace] ?? null;
			const app = appId ? apps.get(appId) : undefined;
			const builtIn = !appId && BUILT_IN.has(namespace);
			return {
				namespace,
				label: app?.appName ?? (builtIn ? "Tedix" : inputLabel(namespace)),
				appId,
				status: builtIn
					? "built_in"
					: app
						? app.badge
						: // A saved version with links that leaves this name out
							// found no app for it.
							!appId && skill.mcpAppBindings && installed
							? "no_app"
							: "unknown",
				tools: [...methods].sort().map((method) => ({
					call: `${namespace}.${method}`,
					label: inputLabel(method),
				})),
			};
		})
		.sort((a, b) => a.label.localeCompare(b.label));
}
