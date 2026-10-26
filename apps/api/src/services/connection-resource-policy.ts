import * as z from "zod";
import { ConnectionAllowedResourcesSchema } from "@tedix/api-contract/schemas/connections";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import type { ConnectionInstanceRow } from "@tedix/db/schema/connection-instances";
import { getToolByAppAndToolIdForOrganization } from "@tedix/db/queries/tools";
import { type BaseContext, ErrorCodes, createError } from "../rpc/orpc";

const pageRead = z
	.object({
		page_id: z.string(),
		filter_properties: z.array(z.string()).optional(),
	})
	.strict();
const pageFetch = z.object({ url: z.string() }).strict();
const pageTool = z.object({
	transport: z.literal("mcp"),
	mcpToolName: z.string(),
	auth: z.object({ type: z.literal("connection"), connectionId: z.string() }),
});
const pageId = (value: string) => {
	if (
		!/^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(
			value,
		)
	)
		return null;
	return value.replaceAll("-", "").toLowerCase();
};

/** Resolve only reviewed page reads. Blocks, searches and unknown commands have no proven page boundary. */
export async function assertConnectionResourceArguments(
	context: BaseContext,
	instance: ConnectionInstanceRow,
	toolUse?: { appId: string; arguments: JsonValue },
) {
	const denied = () => {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Provider call is outside the connection's allowed resources or its target cannot be verified",
		);
	};
	const policy = ConnectionAllowedResourcesSchema.safeParse(
		instance.allowedResources,
	);
	const toolId = context.headers.get("X-Tedix-Mcp-Tool-Id");
	if (!policy.success || !instance.organizationId || !toolUse || !toolId)
		return denied();
	const tool = await getToolByAppAndToolIdForOrganization(context.db, {
		organizationId: instance.organizationId,
		appId: toolUse.appId,
		toolId,
	});
	const config = pageTool.safeParse(tool?.config);
	if (
		!tool?.enabled ||
		!config.success ||
		config.data.auth.connectionId !== instance.providerId
	)
		return denied();
	let target: string | null = null;
	if (config.data.mcpToolName === "API-retrieve-a-page") {
		const args = pageRead.safeParse(toolUse.arguments);
		if (args.success) target = pageId(args.data.page_id);
	} else if (config.data.mcpToolName === "notion-fetch") {
		const args = pageFetch.safeParse(toolUse.arguments);
		if (args.success) {
			target = pageId(args.data.url);
			try {
				const url = new URL(args.data.url);
				if (
					url.protocol === "https:" &&
					!url.username &&
					!url.password &&
					!url.port &&
					(url.hostname === "notion.com" ||
						url.hostname.endsWith(".notion.com") ||
						url.hostname === "notion.so" ||
						url.hostname.endsWith(".notion.so") ||
						url.hostname.endsWith(".notion.site"))
				) {
					// A view/block fragment must never turn into authority for a different resource.
					if (!url.hash && !url.search) {
						target = pageId(url.pathname.slice(1).replace(/\/$/, ""));
					}
				}
			} catch {
				/* Invalid URLs have no verifiable target. */
			}
		}
	}
	if (
		!target ||
		!policy.data.some((resource) => pageId(resource.resourceId) === target)
	)
		return denied();
}
