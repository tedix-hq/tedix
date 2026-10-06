import type { BaseContext } from "./orpc";

export interface TrustedMcpHostAppContext {
	appId?: string;
	appOrgId?: string;
	appSlug?: string;
}

function header(headers: Headers, name: string): string | undefined {
	return headers.get(name) ?? headers.get(name.toLowerCase()) ?? undefined;
}

export function getTrustedMcpHostAppContext(
	context: Pick<BaseContext, "authType" | "headers">,
): TrustedMcpHostAppContext {
	if (context.authType !== "service-binding") {
		return {};
	}

	return {
		appId: header(context.headers, "X-Tedix-Mcp-App-Id"),
		appOrgId: header(context.headers, "X-Tedix-Mcp-App-Org-Id"),
		appSlug: header(context.headers, "X-Tedix-Mcp-App-Slug"),
	};
}
