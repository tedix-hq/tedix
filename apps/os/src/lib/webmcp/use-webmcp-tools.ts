import { useEffect } from "react";
import { registerWebMcpScope } from "@tedix/webmcp-core/registry";
import type { WebMcpToolDef } from "@tedix/webmcp-core/model-context";
import { installWebMcpTelemetry } from "./telemetry-client";

// Every native tool scope registers through this hook, so its module scope is
// the one place the invocation observer is guaranteed to exist before the
// first tool can run — and it loads only in bundles that actually register
// tools, so a page with no WebMCP surface pays nothing. Inert outside a
// browser (node suites import host components freely).
installWebMcpTelemetry();

/**
 * Register a scope of WebMCP tools for the lifetime of the calling component.
 *
 * The builder runs on mount and whenever `deps` change; its closures should
 * capture the SAME query options and mutation callbacks the visible UI uses,
 * so every agent action flows through the app's one cache namespace and the
 * human watches it happen live. With no WebMCP surface in the browser this
 * is a free no-op.
 *
 * `deps` follows the useEffect contract: stable identities only — an inline
 * object or unmemoized callback here re-registers the scope on every render.
 */
export function useWebMcpTools(
	scopeKey: string,
	build: () => WebMcpToolDef[],
	deps: readonly unknown[],
): void {
	// The builder is deliberately not a dependency: `deps` names its inputs.
	useEffect(() => {
		return registerWebMcpScope(scopeKey, build());
	}, [scopeKey, ...deps]);
}
