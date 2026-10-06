export interface PortableRouteContext {
	pathname: string;
	routeKey?: string;
	params?: Record<string, unknown>;
	entity?: Record<string, unknown>;
	revision?: string;
	[key: string]: unknown;
}

export interface PortableToolProfile {
	authority?: "host" | "tedix_tenant";
	callable: string;
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	bind?: Record<string, string>;
	resultFields?: string[];
	action?: {
		prepareCallable: string;
		convergeCallable: string;
		confirmationTitle: string;
		confirmationLabel: string;
		prepareFields?: string[];
		convergeFields?: string[];
	};
	annotations: { readOnlyHint: boolean; untrustedContentHint?: boolean };
}

export interface PortableRouteProfile {
	id: string;
	match: { pathname?: string; routeKey?: string };
	tools: PortableToolProfile[];
}

export interface PortableWebMcpProfile {
	version: 1;
	routes: PortableRouteProfile[];
}

export interface PortableContextTarget {
	context(value: PortableRouteContext): unknown;
}

export interface PortableToolCall {
	callable: string;
	args: Record<string, unknown>;
	/** Present only for first-party route-scoped same-origin calls. */
	routeCapability?: { token: string; routeId: string };
}

export type PortableToolCaller = (input: PortableToolCall) => Promise<unknown>;

export interface PortableRouteAdapter<
	RouteKey extends string,
	RouteParams extends Partial<Record<RouteKey, Record<string, unknown>>>,
> {
	setRoute<Key extends RouteKey>(
		routeKey: Key,
		context?: Omit<PortableRouteContext, "pathname" | "routeKey" | "params"> & {
			pathname?: string;
			params?: RouteParams[Key];
		},
	): PortableRouteContext;
	setPathname(
		pathname: string,
		context?: Omit<PortableRouteContext, "pathname">,
	): PortableRouteContext;
}

/**
 * Framework-neutral typed adapter for the white-label loader's `context()` API.
 * Hosts define route keys once and call this from their router integration;
 * tenant authority remains in the signed embedded session, never this context.
 */
export function createPortableRouteAdapter<
	const RouteParams extends Record<string, Record<string, unknown>>,
>(input: {
	target: PortableContextTarget;
	routes: RouteParams;
	pathname?: () => string;
}): PortableRouteAdapter<keyof RouteParams & string, RouteParams> {
	const publish = (context: PortableRouteContext) => {
		input.target.context(context);
		return context;
	};
	return {
		setRoute(routeKey, context = {}) {
			return publish({
				...context,
				pathname: context.pathname ?? input.pathname?.() ?? "/",
				routeKey,
			});
		},
		setPathname(pathname, context = {}) {
			return publish({ ...context, pathname });
		},
	};
}

const PORTABLE_CALLABLE_PATTERN =
	/^([a-z][a-z0-9_]{1,127})\.([a-z][a-z0-9_]{1,127})$/;

function portableToolResult(value: unknown, callable: string): unknown {
	if (!value || typeof value !== "object") return value;
	const record = value as Record<string, unknown>;
	const text = Array.isArray(record.content)
		? record.content
				.filter((item): item is { type: "text"; text: string } =>
					Boolean(
						item &&
						typeof item === "object" &&
						(item as { type?: unknown }).type === "text" &&
						typeof (item as { text?: unknown }).text === "string",
					),
				)
				.map((item) => item.text)
				.join("\n")
		: "";
	if (record.isError === true)
		throw new Error(`${callable} failed: ${text || "Tool call failed"}`);
	if (record.structuredContent !== undefined) return record.structuredContent;
	if (!Array.isArray(record.content)) return value;
	if (!text) return record.content;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

/**
 * Execute one signed portable callable through a host's same-origin MCP relay.
 * The browser session remains the authority and the MCP edge rechecks the exact
 * inner tool scope; the SDK never receives or stores a credential.
 */
export function createSameOriginPortableToolCaller(
	input: {
		/** Root-relative relay path, never an absolute or protocol-relative URL. */
		endpoint?: string;
		fetch?: typeof fetch;
		/** Use the dedicated route-checking relay instead of generic Code Mode. */
		routeScoped?: boolean;
	} = {},
): PortableToolCaller {
	const endpoint = input.endpoint ?? "/mcp";
	// Parse against a fixed origin without depending on a browser global. The
	// browser also enforces same-origin mode if a host supplies an external base URI.
	const base = "https://portable.invalid";
	if (
		!endpoint.startsWith("/") ||
		endpoint.startsWith("//") ||
		endpoint.includes("\\") ||
		new URL(endpoint, base).origin !== base
	)
		throw new Error(
			"Portable MCP endpoint must be a same-origin absolute path",
		);
	const fetchImpl = input.fetch ?? fetch;
	let requestId = 0;
	return async ({ callable, args, routeCapability }) => {
		const match = PORTABLE_CALLABLE_PATTERN.exec(callable);
		if (!match) throw new Error("Invalid portable callable");
		if (input.routeScoped) {
			if (!routeCapability?.token || !routeCapability.routeId)
				throw new Error("Signed portable route is required");
			const response = await fetchImpl(endpoint, {
				method: "POST",
				credentials: "same-origin",
				mode: "same-origin",
				redirect: "error",
				headers: {
					accept: "application/json",
					"content-type": "application/json",
				},
				body: JSON.stringify({ ...routeCapability, callable, args }),
			});
			const payload = (await response.json()) as {
				result?: unknown;
				error?: string;
			};
			if (!response.ok || payload.error)
				throw new Error(payload.error ?? "Portable route call failed");
			const outer = portableToolResult(payload.result, "code");
			return outer &&
				typeof outer === "object" &&
				"executionId" in outer &&
				"result" in outer
				? (outer as { result: unknown }).result
				: outer;
		}
		const namespace = match[1];
		const tool = match[2];
		const code = `async () => await ${namespace}.${tool}(${JSON.stringify(args)})`;
		const response = await fetchImpl(endpoint, {
			method: "POST",
			credentials: "same-origin",
			mode: "same-origin",
			redirect: "error",
			headers: {
				accept: "application/json",
				"content-type": "application/json",
				"mcp-protocol-version": "2025-06-18",
				"mcp-method": "tools/call",
				"mcp-name": "code",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: ++requestId,
				method: "tools/call",
				params: { name: "code", arguments: { code } },
			}),
		});
		const payload = (await response.json()) as {
			result?: unknown;
			error?: { message?: string };
		};
		if (!response.ok || payload.error)
			throw new Error(payload.error?.message ?? "Portable MCP call failed");
		const outer = portableToolResult(payload.result, "code");
		if (
			outer &&
			typeof outer === "object" &&
			"executionId" in outer &&
			"result" in outer
		)
			return (outer as { result: unknown }).result;
		return outer;
	};
}

function pathnameMatch(pattern: string, pathname: string) {
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
	return Object.fromEntries(
		keys.map((key, index) => [key, decodeURIComponent(match[index + 1] || "")]),
	);
}

export function selectPortableRoute(
	profile: PortableWebMcpProfile | undefined,
	context: PortableRouteContext,
): { route: PortableRouteProfile; routeParams: Record<string, string> } | null {
	for (const route of profile?.routes ?? []) {
		if (route.match.routeKey && route.match.routeKey !== context.routeKey)
			continue;
		const routeParams = route.match.pathname
			? pathnameMatch(route.match.pathname, context.pathname)
			: {};
		if (routeParams) return { route, routeParams };
	}
	return null;
}

function pathValue(value: unknown, path: string): unknown {
	return path
		.split(".")
		.reduce<unknown>(
			(current, key) =>
				current && typeof current === "object"
					? (current as Record<string, unknown>)[key]
					: undefined,
			value,
		);
}

export function bindPortableToolArguments(input: {
	args: Record<string, unknown>;
	bindings?: Record<string, string>;
	context: PortableRouteContext;
	routeParams: Record<string, string>;
}): Record<string, unknown> {
	const result = { ...input.args };
	for (const [argument, source] of Object.entries(input.bindings ?? {})) {
		const value = source.startsWith("$route.")
			? pathValue(input.routeParams, source.slice(7))
			: source.startsWith("$context.")
				? pathValue(input.context, source.slice(9))
				: undefined;
		if (value !== undefined) result[argument] = value;
	}
	return result;
}

export function compactPortableResult(
	value: unknown,
	fields?: string[],
): unknown {
	if (!fields?.length || !value || typeof value !== "object") return value;
	return Object.fromEntries(
		fields.flatMap((field) => {
			const selected = pathValue(value, field);
			return selected === undefined ? [] : [[field, selected]];
		}),
	);
}

export async function executePortableTool(input: {
	tool: PortableToolProfile;
	args: Record<string, unknown>;
	/** Stops undispatched work; an already dispatched write must still converge. */
	signal?: AbortSignal;
	call: (callable: string, args: Record<string, unknown>) => Promise<unknown>;
	confirm: (preview: unknown) => Promise<boolean>;
}): Promise<
	| { status: "cancelled"; changed: false }
	| { status: "completed"; result: unknown; convergence: unknown }
	| { status: "read"; result: unknown }
> {
	if (input.signal?.aborted) return { status: "cancelled", changed: false };
	if (!input.tool.action) {
		return {
			status: "read",
			result: compactPortableResult(
				await input.call(input.tool.callable, input.args),
				input.tool.resultFields,
			),
		};
	}
	const pickArgs = (fields?: string[]) =>
		fields
			? Object.fromEntries(
					fields.flatMap((field) =>
						Object.hasOwn(input.args, field)
							? [[field, input.args[field]]]
							: [],
					),
				)
			: input.args;
	const preview = await input.call(
		input.tool.action.prepareCallable,
		pickArgs(input.tool.action.prepareFields),
	);
	if (input.signal?.aborted) return { status: "cancelled", changed: false };
	if (!(await input.confirm(preview)) || input.signal?.aborted)
		return { status: "cancelled", changed: false };
	// Cancellation after this point cannot establish changed:false. Preserve
	// the write result and convergence even if the browser stops waiting.
	const result = await input.call(input.tool.callable, input.args);
	const convergence = await input.call(
		input.tool.action.convergeCallable,
		pickArgs(input.tool.action.convergeFields),
	);
	return {
		status: "completed",
		result: compactPortableResult(result, input.tool.resultFields),
		convergence,
	};
}
