import { useRouterState } from "@tanstack/react-router";
import {
	createPortableRouteAdapter,
	createSameOriginPortableToolCaller,
	type PortableRouteContext,
	type PortableToolCaller,
} from "@tedix/webmcp-core/portable-profile";
import { useEffect, useRef } from "react";
import { osApi, osChatMutationApi, osChatReadApi } from "@/lib/api";
import { getPageFocus, subscribePageFocus } from "@/lib/page-focus";
import {
	listPageChatTools,
	type PageChatTool,
	subscribePageChatTools,
} from "@/lib/page-chat-tools";
import {
	abortableSleep,
	QUICK_CHAT_HOME_LABEL,
	type QuickChatPageToolCall,
	type QuickChatPageToolResult,
	readQuickChatHomeTranscript,
	runQuickChatHomeTurn,
	type QuickChatHomeDeps,
} from "@/lib/quick-chat-home";
import type { HomePageToolDescriptor } from "@tedix/api-contract/schemas/kernel-runtime";
import { reportOsIssue } from "@/lib/error-reporting/install";
import {
	defaultTediWidgetConfig,
	resolveTediWidgetConfig,
	type TediWidgetConfig,
} from "@/lib/tedi-widget-config";
import { useOsIdentity } from "@/lib/use-os-identity";
import { resolveOsTenant } from "@/shared/os-tenant";
import launcherStyles from "./os-quick-chat.css?inline";

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
		/** The page's own tools the chat may run for the person, per turn. */
		pageTools?: { list(): readonly PageChatTool[] };
		/** Home as the first, default target; its turns use the Home path. */
		home?: {
			label: string;
			turn(input: {
				conversationId: string;
				text: string;
				pageContext?: unknown;
				signal?: AbortSignal;
				pageTools?: HomePageToolDescriptor[];
				runPageTool?: (
					call: QuickChatPageToolCall,
				) => Promise<QuickChatPageToolResult | null>;
				onDelta?: (text: string) => void;
			}): Promise<{ text: string }>;
			transcript(input: {
				conversationId: string;
			}): Promise<Array<{ role: "user" | "assistant"; content: string }>>;
		};
		conversationStarters: string[];
		script: HTMLScriptElement;
		session(input: EmbeddedSessionInput): Promise<unknown>;
		/** Opaque per-person key; the widget remembers the last choice under it. */
		preferenceKey?: string;
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
	const { pathname: normalizedPathname, ...context } = withPageFocus(
		osPortableRouteContext(pathname),
	);
	return adapter.setPathname(normalizedPathname, context);
}

/**
 * The item on screen, such as the Decision Deck card, replaces the route's
 * entity so the chat can resolve "this card". Identity only, never content.
 */
export function withPageFocus(
	context: PortableRouteContext,
	focus = getPageFocus(),
): PortableRouteContext {
	return focus
		? {
				...context,
				entity: {
					type: focus.type,
					id: focus.id,
					...(focus.label ? { label: focus.label } : {}),
				},
			}
		: context;
}

const quickChatHomeDeps: QuickChatHomeDeps = {
	enqueueMessage: (input, options) =>
		osChatMutationApi.kernelRuntime.enqueueMessage(input, options),
	readRun: (input) => osChatReadApi.kernelRuntime.readRun(input),
	readMessages: (input) => osApi.kernelRuntime.readMessages(input),
	readRunEvents: (input) => osChatReadApi.kernelRuntime.readRunEvents(input),
	resolvePageTool: (input) =>
		osChatMutationApi.kernelRuntime.resolvePageTool(input),
	randomUuid: () => crypto.randomUUID(),
	sleep: abortableSleep,
	now: () => Date.now(),
};

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
		title: "Document",
		description: "The selected document and its content.",
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
		title: "Templates",
		description: "Reusable workspace templates.",
	},
	chat: { title: "Chat", description: "The native OS conversation workbench." },
	outputs: {
		title: "Documents",
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
					title: "Work",
					description: "Your tasks, decisions and recent activity.",
				}
			: {}),
	};
}

/** The widget reads this code as "no tedi for this person", never Offline. */
export class QuickChatTediUnavailableError extends Error {
	readonly code = "tedi_unavailable";
	constructor() {
		super("No tedi is available to you here.");
	}
}

/**
 * The tedis to try, in order: the requested one when it is allowed, then the
 * organization default, then the other allowed tedis. A remembered or default
 * tedi that is no longer allowed is skipped rather than refused.
 */
export function quickChatTediCandidates(
	selection:
		| { defaultTediId?: string; allowedTediIds?: readonly string[] }
		| null
		| undefined,
	requestedTediId?: string,
): string[] {
	const allowed = selection?.allowedTediIds ?? [];
	return [
		...new Set(
			[requestedTediId, selection?.defaultTediId, ...allowed].filter(
				(id): id is string => typeof id === "string" && allowed.includes(id),
			),
		),
	];
}

/** A refusal about this tedi, not about the connection or the page. */
function isTediRefusal(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const { code, data, message } = error as {
		code?: unknown;
		data?: { reason?: unknown };
		message?: unknown;
	};
	if (typeof message === "string" && /first-party route/i.test(message))
		return false;
	return (
		code === "FORBIDDEN" ||
		code === "NOT_FOUND" ||
		(code === "SERVICE_UNAVAILABLE" && data?.reason === "worker_unavailable")
	);
}

/**
 * Mints a session with the first candidate the API accepts. Only refusals of
 * a particular tedi move on to the next; a network or server failure stays a
 * failure so the widget can say it is offline.
 */
export async function createSessionWithFallback<T>(
	candidates: readonly string[],
	create: (tediId: string) => Promise<T>,
): Promise<T> {
	for (const tediId of candidates) {
		try {
			return await create(tediId);
		} catch (error) {
			if (!isTediRefusal(error)) throw error;
		}
	}
	throw new QuickChatTediUnavailableError();
}

export function canUseQuickChatHome(
	authority: { permissions?: readonly string[] } | undefined,
): boolean {
	return authority?.permissions?.includes("os:run") === true;
}

/**
 * An opaque per-organization, per-person key under which the widget remembers
 * the last chosen tedi or Home. Hashed so no email lands in browser storage.
 */
export async function quickChatPreferenceKey(
	organizationId: string,
	person: string,
): Promise<string | undefined> {
	if (!person) return undefined;
	try {
		const digest = await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(`${organizationId}\n${person}`),
		);
		return [...new Uint8Array(digest).slice(0, 16)]
			.map((byte) => byte.toString(16).padStart(2, "0"))
			.join("");
	} catch {
		return undefined;
	}
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
	const shadow = host.shadowRoot;
	if (shadow && !shadow.querySelector("[data-os-launcher-style]")) {
		// The external widget's open shadow root isolates its defaults from OS CSS.
		const style = document.createElement("style");
		style.dataset.osLauncherStyle = "";
		style.textContent = launcherStyles;
		shadow.append(style);
	}
	const launcher = shadow?.querySelector<HTMLButtonElement>(".tedix-launcher");
	document.documentElement.toggleAttribute(
		"data-quick-chat-launcher",
		!host.hidden && Boolean(launcher && !launcher.hidden),
	);
}

/**
 * Dogfoods the production white-label widget as an additive OS quick-chat
 * surface. The full `/chat` route remains the durable conversation workbench;
 * the widget receives an OS-minted embedded capability instead of inventing a
 * second browser authentication scheme.
 */
export function OsQuickChat() {
	const identity = useOsIdentity();
	// Read at session time: re-running the effect when identity resolves tore
	// the widget down mid-load and stranded its launcher in "loading".
	const identityRef = useRef(identity);
	identityRef.current = identity;
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
		// The card on screen and the page's tools both change what the chat can
		// see and do; republishing the context refreshes the chat's status.
		const republish = () => {
			if (portableRouteAdapterRef.current)
				publishOsPortableRouteContext(
					portableRouteAdapterRef.current,
					window.location.pathname,
				);
		};
		const disposeFocus = subscribePageFocus(republish);
		const disposeTools = subscribePageChatTools(republish);
		return () => {
			disposeFocus();
			disposeTools();
		};
	}, []);

	useEffect(() => {
		// Keep the shadow host mounted so dialog focus isolation never discards
		// the widget's in-memory thread. Base UI keeps data-open through nesting.
		let suppressedHost: HTMLElement | null = null;
		const applyModalSuppression = () => {
			const host = document.querySelector<HTMLElement>("[data-tedix-widget]");
			if (!host) return;
			const modalOpen = Boolean(
				document.querySelector(
					'[role="dialog"][data-open], [role="alertdialog"][data-open]',
				),
			);
			if (!modalOpen && suppressedHost !== host) return;
			suppressedHost = modalOpen ? host : null;
			host.toggleAttribute("inert", modalOpen);
			if (modalOpen) host.setAttribute("aria-hidden", "true");
			else host.removeAttribute("aria-hidden");
		};
		const observer = new MutationObserver(applyModalSuppression);
		observer.observe(document.body, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["data-open"],
		});
		applyModalSuppression();
		return () => observer.disconnect();
	}, []);

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
				const getTediCandidates = async (selectedTediId?: string) => {
					const current = await osApi.userSettings.getContext({});
					const organization = await osApi.organizations.get({
						organizationId: current.organization.id,
					});
					return quickChatTediCandidates(
						organization.metadata?.tediWidget?.tediSelection,
						selectedTediId,
					);
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
						void getTediCandidates().catch((error) =>
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
				const preferenceKey = await quickChatPreferenceKey(
					context.organization.id,
					identityRef.current.email,
				);
				if (disposed || !window.Tedix) return;
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
					pageTools: { list: listPageChatTools },
					...(preferenceKey ? { preferenceKey } : {}),
					// Home runs under os:run; without it the chat opens on a tedi.
					...(canUseQuickChatHome(context.authority)
						? {
								home: {
									label: QUICK_CHAT_HOME_LABEL,
									turn: (input) =>
										runQuickChatHomeTurn(quickChatHomeDeps, input),
									transcript: ({ conversationId }) =>
										readQuickChatHomeTranscript(
											quickChatHomeDeps,
											conversationId,
										),
								},
							}
						: {}),
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
					// Published widget settings also serve external hosts; OS owns its layers.
					zIndex: defaultTediWidgetConfig(organization).zIndex,
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
						const candidates = await getTediCandidates(selectedTediId);
						const routeContext = osPortableRouteContext(pathname);
						const route =
							routeContext.routeKey === "workspaces" &&
							pathname === "/workspaces"
								? config.webMcpProfile?.routes.find(
										(candidate) => candidate.match.routeKey === "workspaces",
									)
								: undefined;
						return createSessionWithFallback(candidates, (tediId) =>
							osApi.tedis.createEmbeddedSession({
								tediId,
								// Quick chat is a utility surface, not the tedi's full
								// workstation; the runtime reads this instead of the hostname.
								surface: "os",
								allowedOrigin: window.location.origin,
								conversationId,
								hostOrganizationId: context.organization.id,
								hostOrganizationLabel: context.organization.name,
								hostUserId:
									identityRef.current.email || identityRef.current.name,
								hostUserLabel: identityRef.current.name,
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
							}),
						);
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
			document.documentElement.removeAttribute("data-quick-chat-launcher");
		};
	}, []);

	return null;
}
