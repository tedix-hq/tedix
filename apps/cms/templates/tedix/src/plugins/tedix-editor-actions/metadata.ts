import type { PluginCapability, PluginDescriptor } from "emdash";

const collections = ["pages", "posts"];
const textFields = ["title", "meta_description"];
const access = {
	read: { fields: textFields },
	patch: { fields: textFields },
};

/** Native standard plugins take trust and editor registration from the descriptor. */
export const editorActionsMetadata = {
	id: "tedix-editor-actions",
	version: "0.1.0",
	format: "standard",
	capabilities: [
		"network:request",
		"admin.editor-draft:read",
		"admin.editor-draft:patch",
	] satisfies PluginCapability[],
	allowedHosts: ["api.tedix.dev"],
	editorActions: [
		{
			id: "rewrite",
			label: "Rewrite title and description",
			route: "rewrite",
			placement: "overflow",
			collections,
			draft: access,
		},
		{
			id: "translate",
			label: "Translate title and description",
			route: "translate",
			placement: "overflow",
			collections,
			draft: access,
		},
	],
	editorPanels: [
		{
			id: "seo",
			title: "SEO suggestions",
			route: "seo",
			collections,
			draft: { read: { fields: textFields } },
		},
	],
} satisfies Omit<PluginDescriptor, "entrypoint">;
