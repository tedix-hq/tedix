import { useRouterState } from "@tanstack/react-router";
import {
	createPortableRouteAdapter,
	createSameOriginPortableToolCaller,
	type PortableRouteContext,
	type PortableToolCaller,
} from "@tedix/webmcp-core/portable-profile";
import { useEffect, useRef } from "react";
import { osApi } from "@/lib/api";
import { reportOsIssue } from "@/lib/error-reporting/install";
import {
	resolveTediWidgetConfig,
	type TediWidgetConfig,
} from "@/lib/tedi-widget-config";
import { useOsIdentity } from "@/lib/use-os-identity";
import { resolveOsTenant } from "@/shared/os-tenant";

declare const __LOCAL_DEMO_ENABLED__: boolean;

const WIDGET_ORIGIN = "https://widget.tedix.dev";
// Pin the host contract so a five-minute CDN/browser cache cannot strand an OS
// release on an older loader that ignores route-tool preloading.
const WIDGET_LOADER_URL = `${WIDGET_ORIGIN}/v1/loader.js?host-sdk=3`;

type EmbeddedSessionInput = {
	selectedTediId?: string;
	conversationId: string;
	hostConversationContext?: {
		kind: string;
		reference: string;
		label?: string;
	};
	pathname: string;
};

type TedixWidgetApi = {
	context(value: PortableRouteContext): void;
	on(
		event:
			| "error"
			| "performance"
			| "ready"
			| "opened"
			| "closed"
			| "message-submitted"
			| "first-token"
			| "answer-completed"
			| "answer-cancelled"
			| "answer-failed",
		callback: (detail: WidgetLifecycleDetail) => void,
	): () => void;
	shutdown(): void;
	init(options: {
		consent: { analytics: boolean; functional: true; personalization: true };
		accent?: string;
		accentDark?: string;
		assistantLogoUrl?: string;
		assistantLogoUrlDark?: string;
		launcherIconUrl?: string;
		launcherIconUrlDark?: string;
		themeMode?: "host" | "system" | "light" | "dark";
		launcherPosition?: "bottom-left" | "bottom-right";
		horizontalOffset?: number;
		bottomOffset?: number;
		zIndex?: number;
		launcherMode?: "default" | "hidden" | "host";
		startMode?: "home" | "conversation";
		homeModules?: Array<"welcome" | "attention" | "recent">;
		translations?: TediWidgetConfig["translations"];
		locale: string;
		product: string;
		prompts: string[];
		portableTool: PortableToolCaller;
		requireSignedPortableRoute?: boolean;
		conversationStarters: string[];
		script: HTMLScriptElement;
		session(input: EmbeddedSessionInput): Promise<unknown>;
		subtitle: string;
		tenant: string;
		title: string;
	}): void;
};

const portableTool = createSameOriginPortableToolCaller({
	endpoint: "/_tedix/webmcp/portable-call",
	routeScoped: true,
});

type OsPortableRouteAdapter = ReturnType<
	typeof createPortableRouteAdapter<Record<string, Record<string, unknown>>>
>;

export function createOsPortableRouteAdapter(
	getTarget: () => Pick<TedixWidgetApi, "context"> | undefined,
): OsPortableRouteAdapter {
	return createPortableRouteAdapter({
		// The loader is replaced by the runtime after its queue drains. Resolve
		// the current API on every navigation, never retain the loader stub.
		target: { context: (context) => getTarget()?.context(context) },
		routes: {},
	});
}

function publishOsPortableRouteContext(
	adapter: OsPortableRouteAdapter,
	pathname: string,
): PortableRouteContext {
	const { pathname: normalizedPathname, ...context } =
		osPortableRouteContext(pathname);
	return adapter.setPathname(normalizedPathname, context);
}

function decoded(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

// Page identity, not a snapshot of its data. These SDK fields reach the runtime
// even when the portable profile's routeKey is used only for tool selection.
const routeDescriptions: Record<
	string,
	{ title: string; description: string }
> = {
	"workspace-detail": {
		title: "Workspace",
		description: "A workspace's chat and workpiece canvas.",
	},
	"work-item-detail": {
		title: "Work item",
		description:
			"A selected work item's outcome, attempts, evidence, and lifecycle.",
	},
	"run-detail": {
		title: "Run",
		description: "Details of the selected execution run.",
	},
	"output-detail": {
		title: "Output",
		description: "The selected output and its content.",
	},
	"skill-detail": {
		title: "Skill",
		description:
			"The selected skill's definition, versions, runs, or schedule.",
	},
	workspaces: {
		title: "Workspaces",
		description: "Find, create, and reopen workspaces.",
	},
	blueprints: {
		title: "Blueprints",
		description: "Reusable workspace templates.",
	},
	chat: { title: "Chat", description: "The native OS conversation workbench." },
	outputs: {
		title: "Outputs",
		description: "Documents and other outputs available in this organization.",
	},
	skills: {
		title: "Skills",
		description: "Instruction and executable skills, flows, and schedules.",
	},
	"api-keys": {
		title: "API keys",
		description: "Organization API key management.",
	},
	connections: {
		title: "Connections",
		description: "Organization connections to external services.",
	},
};

/** Stable host routing contract shared by the widget profile and browser tests. */
export function osPortableRouteContext(pathname: string): PortableRouteContext {
	const path = pathname.split("?", 1)[0] || "/";
	const patterns: Array<readonly [RegExp, string, string, string]> = [
		[
			/^\/workspace\/([^/]+)\/?$/,
			"workspace-detail",
			"workspaceId",
			"workspace",
		],
		[
			/^\/work\/items\/([^/]+)\/?$/,
			"work-item-detail",
			"workItemId",
			"work-item",
		],
		[/^\/work\/runs\/([^/]+)\/?$/, "run-detail", "runId", "run"],
		[/^\/outputs\/([^/]+)\/?$/, "output-detail", "outputId", "output"],
		[/^\/skills\/([^/]+)(?:\/.*)?$/, "skill-detail", "skillId", "skill"],
	];
	for (const [pattern, routeKey, paramName, entityType] of patterns) {
		const match = pattern.exec(path);
		if (!match) continue;
		const id = decoded(match[1] ?? "");
		return {
			pathname: path,
			routeKey,
			...routeDescriptions[routeKey],
			params: { [paramName]: id },
			entity: { type: entityType, id },
		};
	}
	const routeKey =
		path === "/workspaces"
			? "workspaces"
			: path === "/blueprints"
				? "blueprints"
				: path === "/chat"
					? "chat"
					: path === "/outputs"
						? "outputs"
						: path === "/skills"
							? "skills"
							: path === "/admin/api-keys"
								? "api-keys"
								: path === "/admin/connections"
									? "connections"
									: path === "/work" || path.startsWith("/work/")
										? "work"
										: "unmapped";
	return {
		pathname: path,
		routeKey,
		...routeDescriptions[routeKey],
		...(path === "/work" || path === "/work/"
			? {
					title: "Admission queue",
					description:
						"Accepted work evaluated against dependencies, capabilities, authority, budget, resources, and active attempts. Rows distinguish completed gate evaluation from pending or unavailable checks.",
				}
			: {}),
	};
}

type WidgetLifecycleDetail = {
	code?: string;
	conversationId?: string;
	eventId?: string;
	durationMs?: number;
	outcome?: "succeeded" | "failed" | "cancelled";
	phase?: "ready" | "session" | "turn";
};

declare global {
	interface Window {
		Tedix?: TedixWidgetApi;
	}
}

/**
 * Routes whose native composer sits bottom-right: the quick-chat launcher
 * would cover the send button and model picker, so it is suppressed there.
 * `/chat` is the durable conversation workbench; `/workspace/:id` mounts the
 * canvas chat pane.
 */
export function shouldSuppressQuickChatLauncher(pathname: string): boolean {
	return (
		pathname === "/chat" ||
		pathname.startsWith("/chat/") ||
		pathname.startsWith("/workspace/")
	);
}

/**
 * The widget mounts its Shadow DOM host as `div[data-tedix-widget]` on
 * `document.body`; toggling `hidden` on that host hides launcher and panel
 * without tearing the widget (and its threads) down on every route change.
 */
function applyLauncherSuppression(pathname: string): void {
	const host = document.querySelector<HTMLElement>("[data-tedix-widget]");
	if (!host) return;
	host.hidden = shouldSuppressQuickChatLauncher(pathname);
}

/**
 * Dogfoods the production white-label widget as an additive OS quick-chat
 * surface. The full `/chat` route remains the durable conversation workbench;
 * the widget receives an OS-minted embedded capability instead of inventing a
 * second browser authentication scheme.
 */
export function OsQuickChat() {
	const identity = useOsIdentity();
	const portableRouteAdapterRef = useRef<OsPortableRouteAdapter | null>(null);
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});

	useEffect(() => {
		if (portableRouteAdapterRef.current)
			publishOsPortableRouteContext(portableRouteAdapterRef.current, pathname);
		applyLauncherSuppression(pathname);
	}, [pathname]);

	useEffect(() => {
		if (import.meta.env.MODE === "test") return;
		// Local Workers AI powers Home, not the embedded tedi runtime.
		if (
			__LOCAL_DEMO_ENABLED__ &&
			resolveOsTenant(window.location.hostname).kind === "local"
		)
			return;
		let disposed = false;
		let lifecycleAnalyticsEnabled = false;
		const disposers: Array<() => void> = [];
		const recordLifecycle = (event: {
			event:
				| "ready"
				| "opened"
				| "closed"
				| "error"
				| "performance"
				| "message_submitted"
				| "first_token"
				| "answer_completed"
				| "answer_cancelled"
				| "answer_failed";
			phase?: "ready" | "session" | "turn";
			outcome?: "succeeded" | "failed" | "cancelled";
			code?: string;
			durationMs?: number;
		}) => {
			if (!lifecycleAnalyticsEnabled) return;
			void osApi.analytics
				.trackWidgetLifecycle({
					events: [{ ...event, surface: "native_os" }],
				})
				.catch((error) => console.error("[OS quick chat telemetry]", error));
		};
		const script = document.createElement("script");
		script.src = WIDGET_LOADER_URL;
		script.async = true;
		script.dataset.tedixOsQuickChat = "true";
		script.dataset.tedixPreload = "open";
		script.addEventListener("load", () => {
			void (async () => {
				if (disposed || !window.Tedix) return;
				portableRouteAdapterRef.current = createOsPortableRouteAdapter(
					() => window.Tedix,
				);
				const getSelectedTedi = async (selectedTediId?: string) => {
					const current = await osApi.userSettings.getContext({});
					const organization = await osApi.organizations.get({
						organizationId: current.organization.id,
					});
					const selection = organization.metadata?.tediWidget?.tediSelection;
					const id = selectedTediId ?? selection?.defaultTediId;
					if (!id || !selection?.allowedTediIds.includes(id))
						throw new Error(
							"Configure selectable tedis in Tedi widget settings first.",
						);
					return { id };
				};
				disposers.push(
					window.Tedix.on("error", ({ code = "unknown" }) => {
						recordLifecycle({ event: "error", code });
						reportOsIssue(
							"widget.lifecycle",
							new Error(`Tedix widget ${code}`),
							{ severity: "warning" },
						);
					}),
					window.Tedix.on("performance", (detail) => {
						if (!detail.phase) return;
						performance.mark(`tedix:widget:${detail.phase}`, { detail });
						if (!["ready", "session", "turn"].includes(detail.phase)) return;
						recordLifecycle({
							event: "performance",
							phase: detail.phase,
							...(detail.outcome === "succeeded" ||
							detail.outcome === "failed" ||
							detail.outcome === "cancelled"
								? { outcome: detail.outcome }
								: {}),
							...(typeof detail.durationMs === "number"
								? { durationMs: Math.round(detail.durationMs) }
								: {}),
						});
					}),
					window.Tedix.on("ready", () => {
						recordLifecycle({ event: "ready" });
						applyLauncherSuppression(window.location.pathname);
					}),
					window.Tedix.on("opened", () => {
						recordLifecycle({ event: "opened" });
						void getSelectedTedi().catch((error) =>
							console.error("[OS quick chat tedi prefetch]", error),
						);
					}),
					window.Tedix.on("closed", () => recordLifecycle({ event: "closed" })),
					...(
						[
							["message-submitted", "message_submitted"],
							["first-token", "first_token"],
							["answer-completed", "answer_completed"],
							["answer-cancelled", "answer_cancelled"],
							["answer-failed", "answer_failed"],
						] as const
					).map(([sdkEvent, event]) =>
						window.Tedix!.on(sdkEvent, (detail) =>
							recordLifecycle({
								event,
								...(typeof detail.durationMs === "number"
									? { durationMs: Math.round(detail.durationMs) }
									: {}),
								...(event === "answer_failed" && detail.code
									? { code: detail.code }
									: {}),
								...(event === "answer_failed" && detail.conversationId
									? { conversationId: detail.conversationId }
									: {}),
								...(event === "answer_failed" && detail.eventId
									? { eventId: detail.eventId }
									: {}),
							}),
						),
					),
				);
				const context = await osApi.userSettings.getContext({});
				const organization = await osApi.organizations.get({
					organizationId: context.organization.id,
				});
				if (disposed || !window.Tedix) return;
				const config = resolveTediWidgetConfig(organization);
				lifecycleAnalyticsEnabled = config.analyticsEnabled === true;
				window.Tedix.init({
					script,
					consent: {
						functional: true,
						personalization: true,
						analytics: lifecycleAnalyticsEnabled,
					},
					tenant: context.organization.slug,
					title: config.title,
					subtitle: config.subtitle,
					product: config.product,
					prompts: config.conversationStarters,
					portableTool,
					requireSignedPortableRoute: true,
					conversationStarters: config.conversationStarters,
					locale: config.locale ?? "en-US",
					accent: config.accentColor,
					accentDark: config.accentColorDark,
					assistantLogoUrl: config.assistantLogoUrl,
					assistantLogoUrlDark: config.assistantLogoUrlDark,
					launcherIconUrl: config.launcherIconUrl,
					launcherIconUrlDark: config.launcherIconUrlDark,
					themeMode: config.themeMode,
					launcherPosition: config.launcherPosition,
					horizontalOffset: config.horizontalOffset,
					bottomOffset: config.bottomOffset,
					zIndex: config.zIndex,
					launcherMode: config.launcherMode,
					startMode: config.startMode,
					homeModules: config.homeModules,
					translations: config.translations,
					// Use the same embedded turn and local-history path as external hosts.
					// Native OS conversations remain in Chat; asking here creates no workspace.
					session: async ({
						conversationId,
						hostConversationContext,
						selectedTediId,
						pathname,
					}) => {
						const tedi = await getSelectedTedi(selectedTediId);
						const routeContext = osPortableRouteContext(pathname);
						const route =
							routeContext.routeKey === "workspaces" &&
							pathname === "/workspaces"
								? config.webMcpProfile?.routes.find(
										(candidate) => candidate.match.routeKey === "workspaces",
									)
								: undefined;
						return osApi.tedis.createEmbeddedSession({
							tediId: tedi.id,
							// Quick chat is a utility surface, not the tedi's full
							// workstation; the runtime reads this instead of the hostname.
							surface: "os",
							allowedOrigin: window.location.origin,
							conversationId,
							hostOrganizationId: context.organization.id,
							hostOrganizationLabel: context.organization.name,
							hostUserId: identity.email || identity.name,
							hostUserLabel: identity.name,
							...(route
								? {
										portableRouteAssertion: {
											routeId: route.id,
											pathname: "/workspaces",
											routeKey: "workspaces",
										},
									}
								: {}),
							...(hostConversationContext ? { hostConversationContext } : {}),
						});
					},
				});
				publishOsPortableRouteContext(
					portableRouteAdapterRef.current,
					window.location.pathname,
				);
				applyLauncherSuppression(window.location.pathname);
			})().catch((error) => console.error("[OS quick chat]", error));
		});
		document.body.append(script);
		return () => {
			disposed = true;
			portableRouteAdapterRef.current = null;
			disposers.forEach((dispose) => dispose());
			window.Tedix?.shutdown();
			script.remove();
		};
	}, [identity.email, identity.name]);

	return null;
}
