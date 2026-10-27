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
