import type { EmDashConfig } from "emdash/astro";

export const seoAeoPluginMetadata = {
	settingsSchema: {
		identityType: {
			type: "select" as const,
			label: "Site owner identity",
			description:
				"Use Person for a personal website, Organization for a company or publication.",
			options: [
				{ value: "Organization", label: "Organization" },
				{ value: "Person", label: "Person" },
			],
			default: "Organization",
		},
	},
} satisfies Pick<
	NonNullable<EmDashConfig["plugins"]>[number],
	"settingsSchema"
>;
