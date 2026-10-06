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
				{ path: "/development", label: "Code and deployments", icon: "code" },
			],
		},
	});
}
