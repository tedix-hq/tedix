import { isRecord } from "@tedix/api-contract/utils/is-record";
import {
	MCP_CLIENT_CAPABILITIES_META_KEY,
	MCP_MODERN_PROTOCOL_VERSION,
} from "@tedix/mcp-shared/protocol";

// The legacy client echoes this declaration on subsequent HTTP exchanges. It
// carries no authority or server state, just like capabilities in request _meta.
export const LEGACY_APPS_SESSION_PREFIX = "tedix-ui-v1-";

/** Read declarations from this exchange; never infer UI support from a client name. */
export function clientSupportsMcpApps(
	body: unknown,
	headers?: Headers,
): boolean {
	if (!isRecord(body)) return false;
	const params = isRecord(body.params) ? body.params : {};
	const meta = isRecord(params._meta) ? params._meta : {};
	if (
		body.method !== "initialize" &&
		!(MCP_CLIENT_CAPABILITIES_META_KEY in meta) &&
		headers?.get("MCP-Protocol-Version") !== MCP_MODERN_PROTOCOL_VERSION
	) {
		return /^tedix-ui-v1-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
			headers?.get("Mcp-Session-Id") ?? "",
		);
	}
	const capabilities =
		body.method === "initialize"
			? params.capabilities
			: meta[MCP_CLIENT_CAPABILITIES_META_KEY];
	if (!isRecord(capabilities)) return false;
	const extensions = isRecord(capabilities.extensions)
		? capabilities.extensions
		: {};
	const experimental = isRecord(capabilities.experimental)
		? capabilities.experimental
		: {};
	return [extensions, experimental].some((declarations) =>
		["io.modelcontextprotocol/ui", "io.modelcontextprotocol/apps"].some(
			(key) => {
				const capability = declarations[key];
				return (
					isRecord(capability) &&
					(capability.mimeTypes === undefined ||
						(Array.isArray(capability.mimeTypes) &&
							capability.mimeTypes.includes("text/html;profile=mcp-app")))
				);
			},
		),
	);
}
