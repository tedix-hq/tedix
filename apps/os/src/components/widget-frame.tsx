import { createWidgetAppBridge } from "./widget-app-bridge";
import type { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import { WidgetAppFrame } from "./widget-app-frame";
import { readWidgetProxyResponse } from "./widget-proxy-response";
import {
	McpUiResourcePermissionsSchema,
	type McpUiResourcePermissions,
	type McpUiUpdateModelContextRequest,
	type McpUiResourceCsp,
	type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import type { ReactNode } from "react";
import {
	Component,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Skeleton } from "@/components/kumo/skeleton";
import { Text } from "@/components/kumo/text";
import { resolveThemeMode, useOsTheme } from "@/lib/theme";
import { isRecord } from "@tedix/api-contract/utils/is-record";

/**
 * MCP Apps host mount for Tedix OS (docs/engineering/mcp/apps.md, "Host Architecture").
 *
 * Fetches the widget's `ui://` resource through the governed same-origin
 * proxy (`GET /widgets/resource`), then mounts the HTML with
 * the official ext-apps AppBridge pointed at
 * `/sandbox_proxy.html` on the OS origin. Widget-originated MCP calls are relayed through
 * `POST /widgets/mcp` — the iframe never sees a bearer token.
 */

type WidgetCsp = McpUiResourceCsp;
type WidgetToolResult = Parameters<AppBridge["sendToolResult"]>[0];
type WidgetCallTool = NonNullable<AppBridge["oncalltool"]>;
type WidgetHostContext = McpUiHostContext;
export type WidgetModelContextUpdate = McpUiUpdateModelContextRequest["params"];
type WidgetUpdateModelContext = NonNullable<AppBridge["onupdatemodelcontext"]>;
const MCP_APP_PERMISSION_KEYS = new Set([
	"camera",
	"microphone",
	"geolocation",
	"clipboardWrite",
]);

/**
 * Keep the outer static sandbox proxy opaque to widget content. The proxy owns
 * the trusted OS origin; the inner guest receives this exact, smaller grant.
 */
export const WIDGET_SANDBOX_PERMISSIONS = "allow-scripts allow-forms";

export interface WidgetFrameProps {
	appSlug: string;
	resourceUri: string;
	toolInput?: unknown;
	toolResult?: unknown;
	title?: string;
	layout?: "content" | "fill";
	/**
	 * Latest widget-state snapshot (`ui/update-model-context`) from the guest.
	 * The host acknowledges every update either way; embedders that want the
	 * data (e.g. to persist gadget state) observe it here.
	 */
	onModelContextUpdate?: (params: WidgetModelContextUpdate) => void;
	/** A user-initiated widget follow-up for the surrounding Workspace chat. */
	onFollowUp?: (message: string) => void;
}

type MountState =
	| { status: "loading" }
	| {
			status: "ready";
			html: string;
			csp?: WidgetCsp;
			permissions?: McpUiResourcePermissions;
	  }
	| { status: "unavailable"; reason: string };

function parseWidgetPermissions(
	value: unknown,
): McpUiResourcePermissions | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) return undefined;
	for (const [key, request] of Object.entries(value)) {
		if (
			!MCP_APP_PERMISSION_KEYS.has(key) ||
			!isRecord(request) ||
			Object.keys(request).length > 0
		) {
			return undefined;
		}
	}
	const parsed = McpUiResourcePermissionsSchema.safeParse(value);
	return parsed.success ? parsed.data : undefined;
}

/**
 * Pull the HTML document and MCP Apps CSP out of a `resources/read` result.
 * Security metadata rides on the resource `_meta.ui`, not the tool
 * (docs/engineering/mcp/apps.md, "Resource Contract").
 */
export function extractWidgetResource(payload: unknown): {
	html: string;
	csp?: WidgetCsp;
	permissions?: McpUiResourcePermissions;
} {
	if (!isRecord(payload) || !Array.isArray(payload.contents)) {
		throw new Error("Widget resource response carried no contents.");
	}
	const first: unknown = payload.contents[0];
	if (!isRecord(first)) {
		throw new Error("Widget resource response carried no content item.");
	}
	const mimeType = typeof first.mimeType === "string" ? first.mimeType : "";
	if (!mimeType.startsWith("text/html")) {
		throw new Error(`Widget resource has unsupported MIME type: ${mimeType}`);
	}
	let html: string;
	if (typeof first.text === "string") {
		html = first.text;
	} else if (typeof first.blob === "string") {
		html = atob(first.blob);
	} else {
		throw new Error("Widget resource content is neither text nor blob.");
	}
	const meta = first._meta;
	const ui = isRecord(meta) && isRecord(meta.ui) ? meta.ui : undefined;
	const csp = ui && isRecord(ui.csp) ? (ui.csp as WidgetCsp) : undefined;
	const permissions = parseWidgetPermissions(ui?.permissions);
	return { html, csp, permissions };
}

/** Encode the closed permission set for the same-origin sandbox proxy. */
export function widgetSandboxUrl(permissions?: McpUiResourcePermissions): URL {
	const url = new URL("/sandbox_proxy.html", window.location.origin);
	if (permissions && Object.keys(permissions).length > 0) {
		url.searchParams.set("permissions", JSON.stringify(permissions));
	}
	return url;
}

/** Governed resource proxy URL for a widget `ui://` resource. */
export function widgetResourceUrl(
	appSlug: string,
	resourceUri: string,
): string {
	const params = new URLSearchParams({ app: appSlug, uri: resourceUri });
	return `/widgets/resource?${params.toString()}`;
}

const escapeEmbeddedJson = (value: unknown) =>
	JSON.stringify(value)
		.replaceAll("&", "\\u0026")
		.replaceAll("<", "\\u003c")
		.replaceAll(">", "\\u003e")
		.replaceAll("\u2028", "\\u2028")
		.replaceAll("\u2029", "\\u2029");

/**
 * Give Tedix-owned widgets the same durable result through their existing
 * embedded hydration seam. AppFrame still receives the canonical MCP Apps
 * toolResult, but a slow guest bridge must not leave a reloaded widget on its
 * loading skeleton forever.
 */
export function embedWidgetToolData(html: string, toolResult: unknown): string {
	if (!isRecord(toolResult)) return html;
	// The seam's contract (readEmbeddedData in apps/mcp-ui) is the tool's
	// structuredContent, not the whole MCP result envelope. Embedding the
	// envelope shadows the guest bridge's correct data and every $state path
	// resolves undefined — the gadget-preview path shipped exactly that.
	const dataRecord = Object.hasOwn(toolResult, "structuredContent")
		? toolResult.structuredContent
		: toolResult;
	// ui.create_view returns a transient layoutSpec beside its data. The
	// resources/read fallback is intentionally generic, so native OS must swap
	// its loading placeholder for this bounded runtime spec before hydration.
	if (isRecord(dataRecord) && isRecord(dataRecord.layoutSpec)) {
		const layoutSpec = escapeEmbeddedJson(dataRecord.layoutSpec);
		const withRuntimeSpec = html.replace(
			/(<script\b[^>]*\bid=["']tedix-layout-spec["'][^>]*>)([\s\S]*?)(<\/script>)/i,
			(_full, open: string, _source: string, close: string) =>
				`${open}${layoutSpec}${close}`,
		);
		if (withRuntimeSpec !== html) {
			html = withRuntimeSpec;
		} else {
			const specScript = `<script id="tedix-layout-spec" type="application/json">${layoutSpec}</script>`;
			const head = /<head[^>]*>/i.exec(html);
			html = head
				? `${html.slice(0, head.index + head[0].length)}${specScript}${html.slice(head.index + head[0].length)}`
				: `${specScript}${html}`;
		}
	}
	const collectionKeys = Object.entries(
		Array.isArray(dataRecord)
			? { value: dataRecord }
			: isRecord(dataRecord)
				? dataRecord
				: {},
	)
		.filter(([, value]) => Array.isArray(value))
		.map(([key]) => key);
	if (collectionKeys.length === 1) {
		const statePath = `/${collectionKeys[0]!.replaceAll("~", "~0").replaceAll("/", "~1")}`;
		html = html.replace(
			/(<script\b[^>]*\bid=["']tedix-layout-spec["'][^>]*>)([\s\S]*?)(<\/script>)/i,
			(full, open: string, source: string, close: string) => {
				try {
					const spec = JSON.parse(source) as { elements?: unknown };
					if (!isRecord(spec.elements)) return full;
					let changed = false;
					for (const element of Object.values(spec.elements)) {
						if (!isRecord(element) || element.type !== "DataTable") continue;
						const props = isRecord(element.props) ? element.props : null;
						const data = isRecord(props?.data) ? props.data : null;
						if (data?.$state !== "/") continue;
						data.$state = statePath;
						changed = true;
					}
					return changed ? `${open}${JSON.stringify(spec)}${close}` : full;
				} catch {
					return full;
				}
			},
		);
	}
	const json = escapeEmbeddedJson(dataRecord);
	const data = `<script id="tedix-tool-data" type="application/json">${json}</script>`;
	const head = /<head[^>]*>/i.exec(html);
	if (!head) return `${data}${html}`;
	const insertAt = head.index + head[0].length;
	return `${html.slice(0, insertAt)}${data}${html.slice(insertAt)}`;
}

function WidgetFallback({
	reason,
	resourceUri,
	title,
}: {
	reason: string;
	resourceUri: string;
	title?: string;
}) {
	return (
		<Alert variant="warning" className="min-w-0 max-w-full overflow-hidden">
			<AlertTitle>
				{title ? `${title} is unavailable` : "Widget unavailable"}
			</AlertTitle>
			<AlertDescription>
				<p>{reason}</p>
				<Text as="p" role="label" tone="mono" className="break-all">
					{resourceUri}
				</Text>
			</AlertDescription>
		</Alert>
	);
}

interface BoundaryProps {
	children: ReactNode;
	fallback: ReactNode;
}

/**
 * One broken widget must not take down the page: renderer failures are
 * contained per mount and replaced with the honest fallback
 * (docs/engineering/mcp/apps.md ship checklist, item 10).
 */
class WidgetErrorBoundary extends Component<
	BoundaryProps,
	{ failed: boolean }
> {
	state = { failed: false };

	static getDerivedStateFromError(): { failed: boolean } {
		return { failed: true };
	}

	componentDidCatch(error: Error): void {
		console.error(`Widget renderer crashed: ${error.message}`);
	}

	render(): ReactNode {
		return this.state.failed ? this.props.fallback : this.props.children;
	}
}

function WidgetFrameInner({
	appSlug,
	resourceUri,
	toolInput,
	toolResult,
	title,
	layout,
	onModelContextUpdate,
	onFollowUp,
}: WidgetFrameProps) {
	const [mount, setMount] = useState<MountState>({ status: "loading" });

	// Keep result identity stable when only host context changes.
	const sdkToolResult = useMemo(() => {
		if (!isRecord(toolResult)) return undefined;
		return (Object.hasOwn(toolResult, "structuredContent") ||
		Array.isArray(toolResult.content)
			? toolResult
			: {
					content: [],
					structuredContent: toolResult,
				}) as unknown as WidgetToolResult;
	}, [toolResult]);

	const { preference } = useOsTheme();
	const themeMode = resolveThemeMode(preference);
	const hostContext = useMemo<WidgetHostContext>(
		() => ({ theme: themeMode }),
		[themeMode],
	);

	// MCP passthrough: guest tool calls ride the governed bridge, never a
	// direct MCP connection (docs/engineering/mcp/apps.md, "Host Bridge and Token Handling").
	const handleCallTool = useCallback<WidgetCallTool>(
		async (params, extra) => {
			const response = await fetch("/widgets/mcp", {
				method: "POST",
				signal: extra.mcpReq.signal,
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ app: appSlug, method: "tools/call", params }),
			});
			return await readWidgetProxyResponse<WidgetToolResult>(response);
		},
		[appSlug],
	);

	// Ref-backed so a new listener identity never tears down the bridge (the
	// same pattern as hostContext above).
	const modelContextListener = useRef(onModelContextUpdate);
	modelContextListener.current = onModelContextUpdate;
	const followUpListener = useRef(onFollowUp);
	followUpListener.current = onFollowUp;
	const handleUpdateModelContext = useCallback<WidgetUpdateModelContext>(
		async (params) => {
			modelContextListener.current?.(params);
			return {};
		},
		[],
	);

	const handleMessage = useCallback<NonNullable<AppBridge["onmessage"]>>(
		async ({ role, content }) => {
			if (role !== "user" || content.some((item) => item.type !== "text"))
				return { isError: true };
			const message = content
				.flatMap((item) => (item.type === "text" ? [item.text] : []))
				.join("\n")
				.trim();
			if (!message || message.length > 20_000 || !followUpListener.current)
				return { isError: true };
			followUpListener.current(message);
			return {};
		},
		[],
	);

	// Each frame effect owns a fresh bridge; initial context participates in
	// initialize and later updates wait for the guest initialized notification.
	const permissionsKey =
		mount.status === "ready" ? JSON.stringify(mount.permissions ?? {}) : "";
	const createBridge = useCallback(
		(context: McpUiHostContext) =>
			createWidgetAppBridge(
				handleCallTool,
				handleUpdateModelContext,
				context,
				mount.status === "ready" ? mount.permissions : undefined,
				handleMessage,
			),
		// The bridge must be replaced when its immutable initialize capabilities
		// change. Theme updates continue through setHostContext after initialize.
		[handleCallTool, handleUpdateModelContext, permissionsKey, handleMessage],
	);

	useEffect(() => {
		const controller = new AbortController();
		let alive = true;
		setMount({ status: "loading" });
		(async () => {
			try {
				const response = await fetch(widgetResourceUrl(appSlug, resourceUri), {
					credentials: "include",
					signal: controller.signal,
				});

				const { html, csp, permissions } = extractWidgetResource(
					await readWidgetProxyResponse(response),
				);
				if (!alive) return;
				setMount({ status: "ready", html, csp, permissions });
			} catch (error) {
				if (!alive || controller.signal.aborted) return;
				setMount({
					status: "unavailable",
					reason: error instanceof Error ? error.message : String(error),
				});
			}
		})();
		return () => {
			alive = false;
			controller.abort();
		};
	}, [appSlug, resourceUri]);

	// Re-created only when the extracted CSP changes; AppFrame keys its
	// sandbox iframe on this object, so it must stay referentially stable.
	const sandbox = useMemo(
		() => ({
			url: widgetSandboxUrl(
				mount.status === "ready" ? mount.permissions : undefined,
			),
			permissions: WIDGET_SANDBOX_PERMISSIONS,
			...(mount.status === "ready" && mount.csp ? { csp: mount.csp } : {}),
		}),
		[mount],
	);

	const handleRendererError = useCallback((error: Error) => {
		setMount((current) =>
			current.status === "ready"
				? { status: "unavailable", reason: error.message }
				: current,
		);
	}, []);

	if (mount.status === "loading") {
		return (
			<div aria-busy="true" className="flex flex-col gap-2">
				<Skeleton className="h-4 w-1/3" />
				<Skeleton className="h-40 w-full" />
			</div>
		);
	}

	if (mount.status === "unavailable") {
		return (
			<WidgetFallback
				reason={mount.reason}
				resourceUri={resourceUri}
				title={title}
			/>
		);
	}

	return (
		<div
			data-slot="mcp-widget-frame"
			className="flex min-w-0 max-w-full flex-col gap-1 overflow-hidden"
			style={
				layout === "fill"
					? { flex: "1 1 0px", minHeight: 0, height: "100%" }
					: undefined
			}
		>
			{title ? (
				<Text as="span" role="label" tone="secondary" weight="medium" truncate>
					{title}
				</Text>
			) : null}
			<WidgetAppFrame
				html={embedWidgetToolData(mount.html, toolResult)}
				sandbox={sandbox}
				createBridge={createBridge}
				hostContext={hostContext}
				layout={layout}
				toolInput={isRecord(toolInput) ? toolInput : undefined}
				toolResult={sdkToolResult}
				onError={handleRendererError}
			/>
		</div>
	);
}

/** Governed MCP Apps widget mount with a per-widget failure boundary. */
export function WidgetFrame(props: WidgetFrameProps) {
	return (
		<WidgetErrorBoundary
			fallback={
				<WidgetFallback
					reason="The widget renderer failed."
					resourceUri={props.resourceUri}
					title={props.title}
				/>
			}
		>
			<WidgetFrameInner
				key={`${props.appSlug}:${props.resourceUri}`}
				{...props}
			/>
		</WidgetErrorBoundary>
	);
}
