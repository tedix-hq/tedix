/**
 * WebMCP invocation attribution for outbound osApi requests.
 *
 * While a native WebMCP tool's execute is in flight, the webmcp-core registry
 * holds that invocation's freshly minted UUID in an ambient slot
 * (`currentWebMcpInvocationId`; best-effort under concurrent executes — see
 * the caveat there). This module projects that id onto every same-origin API
 * request made during the execute as `X-Tedix-Webmcp-Invocation`, which is
 * what lets `apps/api`'s os-audit middleware stamp the resulting mutation
 * rows as agent-initiated instead of indistinguishable from human clicks.
 *
 * TRUST BOUNDARY: the header is telemetry metadata and grants NOTHING — it
 * changes no authorization, tenancy, or identity decision anywhere. That is
 * why it deliberately is NOT in worker-kit's `INTERNAL_TRUST_HEADERS`
 * deny-list and matches none of its stripped prefixes (`x-tedix-auth-`,
 * `x-tedix-external-agent-`): the OS worker's `/api` proxy hygiene
 * (`applyInboundTrustHeaderHygiene`) forwards it untouched, like the other
 * client-legit `X-Tedix-*` trace headers. Never promote this header into an
 * authority signal; `apps/api` validates it as a UUID and records it as
 * metadata only.
 */
import { currentWebMcpInvocationId } from "@tedix/webmcp-core/registry";

/**
 * Read by `apps/api/src/rpc/os-audit.ts` (constant duplicated there — apps
 * cannot import each other and the string is the wire contract).
 */
const WEBMCP_INVOCATION_HEADER = "X-Tedix-Webmcp-Invocation";

type HeadersFunction = () =>
	| Promise<Record<string, string>>
	| Record<string, string>;

/**
 * Wraps a client's `getHeaders` so requests issued while a WebMCP execute is
 * in flight carry the invocation id; every other request is untouched.
 */
export function withWebMcpInvocationHeader(
	base: HeadersFunction,
): HeadersFunction {
	return async () => {
		const headers = await base();
		const invocationId = currentWebMcpInvocationId();
		return invocationId === null
			? headers
			: { ...headers, [WEBMCP_INVOCATION_HEADER]: invocationId };
	};
}
