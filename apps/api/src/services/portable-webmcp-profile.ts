import type { PortableWebMcpProfile } from "@tedix/api-contract/schemas/portable-webmcp";
import type { SignedPortableRoute } from "@tedix/auth/gateway-browser-token";

export interface ProviderRouteAssertion {
	routeId: string;
	pathname: string;
	routeKey?: string;
	params?: Record<string, string | number | boolean>;
	entity?: { type: string; id: string };
}

function assertedRouteParams(
	pattern: string,
	pathname: string,
): Record<string, string> | null {
	const keys: string[] = [];
	const escaped = pattern
		.split("/")
		.map((part) => {
			if (part.startsWith(":")) {
				keys.push(part.slice(1));
				return "([^/]+)";
			}
			if (part === "*") return ".*";
			return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		})
		.join("/");
	const match = new RegExp(`^${escaped}/?$`).exec(
		pathname.split("?")[0] || "/",
	);
	if (!match) return null;
	try {
		return Object.fromEntries(
			keys.map((key, index) => [
				key,
				decodeURIComponent(match[index + 1] || ""),
			]),
		);
	} catch {
		return null;
	}
}

/** Resolve only a route asserted by the authenticated provider server. */
export function resolveProviderRouteAssertion(
	profile: PortableWebMcpProfile | undefined,
	assertion: ProviderRouteAssertion,
): { profile: PortableWebMcpProfile; signedRoute: SignedPortableRoute } | null {
	if (
		!profile ||
		!assertion.pathname.startsWith("/") ||
		assertion.pathname.startsWith("//") ||
		assertion.pathname.includes("?")
	)
		return null;
	const route = profile.routes.find((item) => item.id === assertion.routeId);
	if (
		!route ||
		(route.match.routeKey && route.match.routeKey !== assertion.routeKey)
	)
		return null;
	const routeParams = route.match.pathname
		? assertedRouteParams(route.match.pathname, assertion.pathname)
		: {};
	if (!routeParams) return null;
	if (
		Object.entries(routeParams).some(
			([key, value]) =>
				assertion.params &&
				Object.hasOwn(assertion.params, key) &&
				String(assertion.params[key]) !== value,
		)
	)
		return null;
	const context = {
		pathname: assertion.pathname,
		...(assertion.routeKey ? { routeKey: assertion.routeKey } : {}),
		...(assertion.params ? { params: assertion.params } : {}),
		...(assertion.entity ? { entity: assertion.entity } : {}),
	};
	const bindings: SignedPortableRoute["bindings"] = {};
	for (const tool of route.tools) {
		const expected: Record<string, string | number | boolean> = {};
		for (const [argument, source] of Object.entries(tool.bind ?? {})) {
			const [root, ...segments] = source.slice(1).split(".");
			let value: unknown = root === "route" ? routeParams : context;
			for (const segment of segments)
				value =
					value && typeof value === "object"
						? (value as Record<string, unknown>)[segment]
						: undefined;
			if (
				(typeof value !== "string" &&
					typeof value !== "number" &&
					typeof value !== "boolean") ||
				(typeof value === "number" && !Number.isFinite(value))
			)
				return null;
			expected[argument] = value;
		}
		if (tool.action && Object.keys(expected).length) {
			for (const fields of [
				tool.action.prepareFields,
				tool.action.convergeFields,
			])
				if (
					fields &&
					!Object.keys(expected).every((key) => fields.includes(key))
				)
					return null;
		}
		for (const callable of [
			tool.callable,
			...(tool.action
				? [tool.action.prepareCallable, tool.action.convergeCallable].filter(
						(value): value is string => Boolean(value),
					)
				: []),
		]) {
			const previous = bindings[callable];
			if (previous && JSON.stringify(previous) !== JSON.stringify(expected))
				return null;
			bindings[callable] = expected;
		}
	}
	return {
		profile: { ...profile, routes: [route] },
		signedRoute: {
			id: route.id,
			pathname: assertion.pathname,
			...(assertion.routeKey ? { routeKey: assertion.routeKey } : {}),
			...(assertion.params ? { params: assertion.params } : {}),
			...(assertion.entity ? { entity: assertion.entity } : {}),
			bindings,
		},
	};
}

export interface PortableWebMcpCatalogTool {
	toolId: string;
	writeCapability: "read" | "write" | "destructive" | null;
}

export interface PortableWebMcpAdmissionDiagnostic {
	callable: string;
	status: "admitted" | "rejected";
	reason?:
		| "namespace_mismatch"
		| "tool_unavailable"
		| "not_declared_read_only"
		| "write_confirmation_required"
		| "prepare_tool_not_read_only"
		| "converge_tool_not_read_only"
		| "destructive_tool_forbidden";
}

const EMBEDDED_TENANT_TOOLS = new Map<
	string,
	PortableWebMcpCatalogTool["writeCapability"]
>([
	["work.list_work_items", "read"],
	["work.list_work_item_events", "read"],
	["work.add_comment", "write"],
]);

/** Remove the installation-owned tenant binding before a schema reaches UI. */
export function publicPortableWebMcpInputSchema(
	inputSchema: Record<string, unknown>,
	hostTenantArgument: string,
): Record<string, unknown> {
	const properties =
		inputSchema.properties &&
		typeof inputSchema.properties === "object" &&
		!Array.isArray(inputSchema.properties)
			? { ...(inputSchema.properties as Record<string, unknown>) }
			: {};
	delete properties[hostTenantArgument];
	const required = Array.isArray(inputSchema.required)
		? inputSchema.required.filter(
				(value) => value !== hostTenantArgument && typeof value === "string",
			)
		: undefined;
	return {
		...inputSchema,
		properties,
		...(required ? { required } : {}),
	};
}

export function admitPortableWebMcpProfile(input: {
	profile: PortableWebMcpProfile | undefined;
	hostTenantNamespace: string | null;
	catalogTools: readonly PortableWebMcpCatalogTool[];
}): {
	profile?: PortableWebMcpProfile;
	diagnostics: PortableWebMcpAdmissionDiagnostic[];
} {
	if (!input.profile) return { diagnostics: [] };
	const catalog = new Map(
		input.catalogTools.map((tool) => [tool.toolId, tool]),
	);
	const diagnostics = new Map<string, PortableWebMcpAdmissionDiagnostic>();
	const routes = input.profile.routes.flatMap((route) => {
		const tools = route.tools.filter((tool) => {
			const separator = tool.callable.indexOf(".");
			const namespace = tool.callable.slice(0, separator);
			const toolId = tool.callable.slice(separator + 1);
			let diagnostic: PortableWebMcpAdmissionDiagnostic;
			const tenantTool =
				tool.authority === "tedix_tenant"
					? EMBEDDED_TENANT_TOOLS.get(tool.callable)
					: undefined;
			const admittedCatalogTool = tenantTool
				? { toolId, writeCapability: tenantTool }
				: catalog.get(toolId);
			if (
				tool.authority === "tedix_tenant" &&
				(!tenantTool || namespace !== "work")
			) {
				diagnostic = {
					callable: tool.callable,
					status: "rejected",
					reason: "namespace_mismatch",
				};
			} else if (
				tool.authority !== "tedix_tenant" &&
				(!input.hostTenantNamespace || namespace !== input.hostTenantNamespace)
			) {
				diagnostic = {
					callable: tool.callable,
					status: "rejected",
					reason: "namespace_mismatch",
				};
			} else {
				const catalogTool = admittedCatalogTool;
				if (!catalogTool) {
					diagnostic = {
						callable: tool.callable,
						status: "rejected",
						reason: "tool_unavailable",
					};
				} else if (catalogTool.writeCapability === "destructive") {
					diagnostic = {
						callable: tool.callable,
						status: "rejected",
						reason: "destructive_tool_forbidden",
					};
				} else if (catalogTool.writeCapability === "write") {
					if (!tool.action || tool.annotations.readOnlyHint !== false) {
						diagnostic = {
							callable: tool.callable,
							status: "rejected",
							reason: "write_confirmation_required",
						};
					} else {
						const prepareId = tool.action.prepareCallable.split(".")[1];
						const convergeId = tool.action.convergeCallable.split(".")[1];
						const platformTool = (callable: string) =>
							EMBEDDED_TENANT_TOOLS.has(callable)
								? {
										toolId: callable.split(".")[1]!,
										writeCapability: EMBEDDED_TENANT_TOOLS.get(callable)!,
									}
								: undefined;
						const prepare =
							tool.authority === "tedix_tenant"
								? platformTool(tool.action.prepareCallable)
								: prepareId
									? catalog.get(prepareId)
									: undefined;
						const converge =
							tool.authority === "tedix_tenant"
								? platformTool(tool.action.convergeCallable)
								: convergeId
									? catalog.get(convergeId)
									: undefined;
						const requiredNamespace =
							tool.authority === "tedix_tenant"
								? "work"
								: input.hostTenantNamespace;
						const sameNamespace = [
							tool.action.prepareCallable,
							tool.action.convergeCallable,
						]
							.filter(Boolean)
							.every((callable) =>
								String(callable).startsWith(`${requiredNamespace}.`),
							);
						if (!sameNamespace)
							diagnostic = {
								callable: tool.callable,
								status: "rejected",
								reason: "namespace_mismatch",
							};
						else if (!prepare || prepare.writeCapability !== "read")
							diagnostic = {
								callable: tool.callable,
								status: "rejected",
								reason: "prepare_tool_not_read_only",
							};
						else if (!converge || converge.writeCapability !== "read")
							diagnostic = {
								callable: tool.callable,
								status: "rejected",
								reason: "converge_tool_not_read_only",
							};
						else diagnostic = { callable: tool.callable, status: "admitted" };
					}
				} else if (
					catalogTool.writeCapability !== "read" ||
					tool.annotations.readOnlyHint !== true
				) {
					diagnostic = {
						callable: tool.callable,
						status: "rejected",
						reason: "not_declared_read_only",
					};
				} else {
					diagnostic = { callable: tool.callable, status: "admitted" };
				}
			}
			diagnostics.set(tool.callable, diagnostic);
			return diagnostic.status === "admitted";
		});
		return tools.length > 0 ? [{ ...route, tools }] : [];
	});
	return {
		...(routes.length > 0 ? { profile: { ...input.profile, routes } } : {}),
		diagnostics: [...diagnostics.values()],
	};
}
