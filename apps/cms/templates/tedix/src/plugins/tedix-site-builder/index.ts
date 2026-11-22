import { definePlugin } from "emdash";

export function createPlugin() {
	return definePlugin({
		id: "tedix-site-builder",
		version: "1.0.0",
		capabilities: [],
		admin: {
			fieldWidgets: [
				{
					name: "derived-search-text",
					label: "Generated search text",
					fieldTypes: ["text"],
				},
			],
			pages: [
				{ path: "/back-to-tedix", label: "Back to Tedix", icon: "arrow-left" },
				{ path: "/development", label: "Code and deployments", icon: "code" },
			],
		},
	});
}
