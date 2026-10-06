import type { Organization } from "@tedix/api-contract/schemas/organization";

export type TediWidgetConfig = NonNullable<
	NonNullable<Organization["metadata"]>["tediWidget"]
>;

export function defaultTediWidgetConfig(
	organization: Pick<Organization, "name">,
): TediWidgetConfig {
	return {
		version: 1,
		analyticsEnabled: false,
		locale: "en-US",
		title: "Tedi",
		subtitle: `Your assistant for ${organization.name}`,
		product: organization.name,
		accentColor: "#2557d6",
		accentColorDark: "#7aa2ff",
		themeMode: "host",
		launcherPosition: "bottom-right",
		horizontalOffset: 22,
		bottomOffset: 22,
		zIndex: 2_147_483_000,
		launcherMode: "default",
		startMode: "home",
		homeModules: ["welcome", "attention", "recent"],
		conversationStarters: [
			"What needs my attention?",
			"Summarize my recent activity",
			"Explain this page",
		],
	};
}

export function resolveTediWidgetConfig(
	organization: Pick<Organization, "name" | "metadata">,
): TediWidgetConfig {
	const defaults = defaultTediWidgetConfig(organization);
	const published = organization.metadata?.tediWidget;
	return published ? { ...defaults, ...published } : defaults;
}
