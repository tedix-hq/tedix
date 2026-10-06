import { getCmsSiteOverview } from "./cms-proxy-inspection";
import {
	callCmsRest,
	type CmsProxyContext,
	SANDBOX_FREE_CMS_PROXY_TOOLS,
	type ToolResult,
} from "./cms-proxy-runtime";

export async function callSandboxFreeCmsProxyTool(
	ctx: CmsProxyContext,
	toolName: string,
	args: Record<string, unknown>,
): Promise<ToolResult | null> {
	if (!SANDBOX_FREE_CMS_PROXY_TOOLS.has(toolName)) return null;
	if (toolName === "get_site_overview") return getCmsSiteOverview(ctx, args);
	return callCmsRest(ctx, toolName, args);
}
