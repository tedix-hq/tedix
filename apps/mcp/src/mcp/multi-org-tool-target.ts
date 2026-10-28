import { isOrganizationMountNamespace } from "./aggregate-namespaces";
import type { AppTool, ServerContext } from "./server-context";

/** Resolve only server-mounted tools covered by the caller's verified consent. */
export function resolveMultiOrgToolTarget(
	agent: Partial<
		Pick<ServerContext, "appSlug" | "appMetadata" | "callerIdentity">
	>,
	tool: Pick<AppTool, "toolId"> & Partial<Pick<AppTool, "config">>,
) {
	if (
		agent.appSlug !== "connect" ||
		agent.appMetadata?.mcpConfig?.multiOrgConsent !== true
	)
		return null;
	const verified = agent.callerIdentity?.verifiedMultiOrgOrganizations;
	if (agent.callerIdentity?.authType !== "oauth" || !verified?.length) {
		throw new Error("A live multi-organization consent is required");
	}
	if (tool.toolId === "code") return null;
	const target = tool.config?._multiOrgOrganizationId;
	const selected = verified.find((org) => org.organizationId === target);
	const toolNamespace = tool.toolId.split("__", 1)[0] ?? "";
	if (
		!selected ||
		!tool.toolId.includes("__") ||
		!isOrganizationMountNamespace(
			selected.gatewaySlug,
			toolNamespace.replace(/[^a-zA-Z0-9_]/g, "_"),
		)
	) {
		throw new Error("Tool is outside the selected organizations");
	}
	return selected;
}
