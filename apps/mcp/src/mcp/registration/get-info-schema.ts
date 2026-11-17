import * as z from "zod";

/** The fields every get_info result carries; native bootstrap data may follow. */
export const getInfoOutputSchema = z.looseObject({
	name: z.string().describe("App name."),
	slug: z.string().describe("App slug used in URLs and namespaces."),
	description: z.string().nullable().describe("What the app is for."),
	domain: z.string().nullable().describe("App domain, when set."),
	logoUrl: z.string().nullable().describe("App logo URL, when set."),
	serverVersion: z.string().describe("Version this MCP server reports."),
	toolCount: z.number().describe("Tools registered for this connection."),
	capabilities: z.unknown().describe("Capabilities the app declares."),
});

export const connectionInfoOutputSchema = z.strictObject({
	serverVersion: z.string().describe("Version this MCP server reports."),
	organizations: z.array(
		z.strictObject({
			id: z.string().describe("Organization ID accepted by directory tools."),
			label: z.string().describe("Organization label shown to the user."),
		}),
	),
	views: z.array(
		z.strictObject({
			id: z.string(),
			label: z.string(),
			tool: z.string(),
		}),
	),
});
