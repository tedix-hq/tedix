import { appendUtmParams, type UtmParams } from "../lib/utm";
/**
 * TedixRenderer — Universal config-driven widget renderer
 *
 * Takes a json-render spec (from D1 tool config) and renders it using the tedix
 * component registry. Integrates with MCP Apps for runtime tool output data.
 *
 * Spec source priority:
 * 1. Embedded <script id="tedix-layout-spec"> (SSR'd by Astro from MCP header)
 * 2. Props (passed by Astro)
 *
 * Data source:
 * - MCP Apps useToolInfo().output (tool structuredContent from MCP)
 * - Merged into spec state at runtime
 *
 * @example
 * ```astro
 * <TedixRenderer spec={specJson} client:only="react" />
 * ```
 */

import { isNonEmptySpec, registerActionObserver } from "@json-render/core";
import { createStateStore, JSONUIProvider, Renderer } from "@json-render/react";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@tedix/widget-ui/dialog";
import {
	type CSSProperties,
	type ReactNode,
	type RefObject,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { Alert } from "@tedix/widget-ui/alert";
import { WidgetWrapper } from "../components/WidgetWrapper";
import {
	readEmbeddedData,
	readEmbeddedSpec,
	widgetRenderData,
} from "../lib/read-embedded-spec";
import {
	WidgetModelContext,
	callHostTool,
	useWidgetCallTool,
	useWidgetDisplayMode,
	useWidgetOpenExternal,
	useWidgetModal,
	useWidgetSendFollowUp,
	useWidgetToolInfo,
	useWidgetUser,
	useWidgetViewState,
} from "../lib/widget-host-hooks";
import { ItemDetailContent } from "./components/ItemDetailContent";
import { buildTedixActionHandlers } from "./handler-utils";
import { tedixDirectives, tedixRegistry } from "./registry";
import { isRecord } from "@tedix/api-contract/utils/is-record";

interface TedixRendererProps {
	/** json-render spec (flat format: { root, elements, state? }) */
	spec?: Record<string, unknown>;
	/** Optional state data to hydrate the spec (from tool output) */
	data?: Record<string, unknown>;
	/** React children (used for Astro slot="fallback") */
	children?: ReactNode;
}

type PersistedWidgetState = {
	__tedixWidgetState: {
		identity: string;
		interactionState: Record<string, unknown>;
		version: 1;
	};
};

function readNestedString(
	value: Record<string, unknown> | null | undefined,
	path: string[],
): string | null {
	let current: unknown = value;
	for (const key of path) {
		if (!isRecord(current)) return null;
		current = current[key];
	}
	return typeof current === "string" && current.length > 0 ? current : null;
}

function stableSerialize(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
	}
	if (isRecord(value)) {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "undefined";
}

function hashString(value: string): string {
	let hash = 5381;
	for (let index = 0; index < value.length; index += 1) {
		hash = (hash * 33) ^ value.charCodeAt(index);
	}
	return (hash >>> 0).toString(36);
}

function buildWidgetStateIdentity(options: {
	data: Record<string, unknown> | null | undefined;
	input: unknown;
	responseMeta: Record<string, unknown> | null;
	spec: Record<string, unknown> | null;
}): string {
	const resourceUri = readNestedString(options.responseMeta, [
		"ui",
		"resourceUri",
	]);
	const toolCallId =
		readNestedString(options.responseMeta, ["viewUUID"]) ??
		readNestedString(options.responseMeta, ["toolCallId"]) ??
		readNestedString(options.responseMeta, ["tool_call_id"]) ??
		readNestedString(options.responseMeta, ["callId"]);
	const route =
		typeof window !== "undefined"
			? `${window.location.pathname}${window.location.search}`
			: "ssr";

	return hashString(
		stableSerialize({
			data: options.data,
			input: options.input,
			resourceUri,
			route,
			spec: options.spec,
			toolCallId,
		}),
	);
}

function readPersistedInteractionState(
	widgetState: Record<string, unknown>,
	identity: string,
): Record<string, unknown> {
	const envelope = widgetState.__tedixWidgetState;
	if (!isRecord(envelope)) return {};
	if (envelope.version !== 1 || envelope.identity !== identity) return {};
	return isRecord(envelope.interactionState) ? envelope.interactionState : {};
}

function createPersistedWidgetState(
	identity: string,
	interactionState: Record<string, unknown>,
): PersistedWidgetState {
	return {
		__tedixWidgetState: {
			identity,
			interactionState,
			version: 1,
		},
	};
}

function diffInteractionState(
	snapshot: Record<string, unknown>,
	baseState: Record<string, unknown>,
): Record<string, unknown> {
	const interactionState: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(snapshot)) {
		if (key === "_host" || key.startsWith("__")) continue;
		if (stableSerialize(value) !== stableSerialize(baseState[key])) {
			interactionState[key] = value;
		}
	}
	return interactionState;
}

function decodeImages(root: HTMLElement): Promise<void> {
	const images = Array.from(root.querySelectorAll("img"));
	return Promise.all(
		images.map((image) => {
			if (image.complete) return Promise.resolve();
			if (typeof image.decode === "function") {
				return image.decode().catch(() => undefined);
			}
			return new Promise<void>((resolve) => {
				image.addEventListener("load", () => resolve(), { once: true });
				image.addEventListener("error", () => resolve(), { once: true });
			});
		}),
	).then(() => undefined);
}

function useRenderCompleteSignal(
	rootRef: RefObject<HTMLElement | null>,
	ready: boolean,
	identity: string,
) {
	useEffect(() => {
		const root = rootRef.current;
		if (!ready || !root) {
			root?.removeAttribute("data-render-complete");
			document.body?.removeAttribute("data-render-complete");
			return;
		}

		let cancelled = false;
		root.removeAttribute("data-render-complete");
		document.body?.removeAttribute("data-render-complete");

		const waitForFrame = () =>
			new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

		const markComplete = async () => {
			await waitForFrame();
			await waitForFrame();
			await document.fonts?.ready?.catch(() => undefined);
			await decodeImages(root);
			if (cancelled) return;
			root.setAttribute("data-render-complete", "true");
			document.body?.setAttribute("data-render-complete", "true");
			window.dispatchEvent(
				new CustomEvent("tedix:widget-render-complete", {
					detail: { identity },
				}),
			);
		};

		void markComplete();
		return () => {
			cancelled = true;
		};
	}, [identity, ready, rootRef]);
}

/**
 * Inner renderer with JSONUIProvider (State + Visibility + Validation + Actions + Functions + ConfirmationDialog)
 */
function TedixRendererInner({
	spec: propSpec,
	data: propData,
}: TedixRendererProps) {
	// Resolve spec: embedded script tag > props
	const [spec] = useState<Record<string, unknown> | null>(
		() => readEmbeddedSpec() ?? propSpec ?? null,
	);

	// Get runtime data from MCP Apps (tool structuredContent + _meta)
	const toolInfo = useWidgetToolInfo();
	const [embeddedData] = useState<Record<string, unknown> | null>(() =>
		widgetRenderData(readEmbeddedData()),
	);
	const hostData = widgetRenderData(toolInfo.output);
	const responseMeta = toolInfo.responseMetadata as Record<
		string,
		unknown
	> | null;

	// Merge: propData > Tedix OS embedded data > responseMetadata + structuredContent output
	const data = useMemo(
		() =>
			propData ??
			embeddedData ??
			(responseMeta ? { ...hostData, ...responseMeta } : hostData),
		[propData, embeddedData, responseMeta, hostData],
	);

	const stateIdentity = useMemo(
		() =>
			buildWidgetStateIdentity({
				data,
				input: toolInfo.input,
				responseMeta,
				spec,
			}),
		[data, responseMeta, spec, toolInfo.input],
	);

	// Persist user interaction state across host re-renders.
	const [widgetState, setWidgetState] = useWidgetViewState<
		Record<string, unknown>
	>({});
	const interactionState = useMemo(
		() => readPersistedInteractionState(widgetState, stateIdentity),
		[widgetState, stateIdentity],
	);
	const effectiveData = useMemo(
		() => ({ ...data, ...interactionState }),
		[data, interactionState],
	);

	useEffect(() => {
		const envelope = widgetState.__tedixWidgetState;
		if (isRecord(envelope) && envelope.identity === stateIdentity) return;
		if (Object.keys(widgetState).length === 0) return;
		setWidgetState(createPersistedWidgetState(stateIdentity, {}));
	}, [setWidgetState, stateIdentity, widgetState]);

	// Get user locale, device info, display mode from MCP Apps
	const user = useWidgetUser();
	const locale = user.locale;
	const deviceType = user.userAgent.device.type;
	const [displayMode, requestDisplayMode] = useWidgetDisplayMode();
	const openExternal = useWidgetOpenExternal();
	const sendFollowUp = useWidgetSendFollowUp();
	const { callTool: callSearchTool, isPending: isSearchRefining } =
		useWidgetCallTool("search_listings");
	const { callTool: trackAnalytics } = useWidgetCallTool(
		"__track_widget_analytics",
	);

	const modal = useWidgetModal();
	const [actionError, setActionError] = useState<string | null>(null);
	const [detailItem, setDetailItem] = useState<Record<string, unknown> | null>(
		null,
	);
	const rootRef = useRef<HTMLDivElement>(null);

	if (!isNonEmptySpec(spec)) {
		return (
			<div
				data-render-complete="true"
				data-widget-container="true"
				className="widget-container p-4 text-center text-muted-foreground"
			>
				<p>No layout configured</p>
			</div>
		);
	}

	// A layout carrying its own state is an interactive static view (for example,
	// an intake form). It is complete before a tool produces a result, so waiting
	// for MCP Apps output would leave it on the loading skeleton forever.
	// Result-driven layouts still wait unless the host has supplied data.
	const hasInlineState = isRecord((spec as { state?: unknown }).state);
	const isLoading =
		!hasInlineState && !propData && !embeddedData && !toolInfo.isSuccess;

	// Merge inline spec state with runtime data from tool output.
	// Tool output data is available as state paths (e.g., /items, /query).
	const specState = (spec as any).state as Record<string, unknown> | undefined;
	const mergedState = useMemo(
		() => ({ ...specState, ...effectiveData }),
		[specState, effectiveData],
	);
	const baseState = useMemo(
		() => ({ ...specState, ...data }),
		[specState, data],
	);

	// Create store once; sync new/changed keys when mergedState updates.
	//
	// Persist on successful action settlement, not every store update: hydration
	// from tool output must not echo back to the host as interaction state.
	const storeRef = useRef<ReturnType<typeof createStateStore> | null>(null);
	const prevDataRef = useRef<Record<string, unknown> | null>(null);
	if (!storeRef.current) {
		storeRef.current = createStateStore(mergedState);
		prevDataRef.current = mergedState;
	}
	const stateStore = storeRef.current;

	useEffect(() => {
		const prev = prevDataRef.current ?? {};
		// Build a single update record: changed/new keys + undefined for removed keys.
		// stateStore.update() batches all writes into one subscriber notification.
		const updates: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(mergedState)) {
			updates[`/${key}`] = value;
		}
		for (const key of Object.keys(prev)) {
			if (!(key in mergedState)) {
				updates[`/${key}`] = undefined;
			}
		}
		stateStore.update(updates);
		prevDataRef.current = mergedState;
	}, [mergedState, stateStore]);

	// Inject host environment state under /_host namespace.
	// Components and actions can read these via { $state: "/_host/displayMode" } etc.
	useEffect(() => {
		stateStore.set("/_host", {
			displayMode,
			locale,
			deviceType,
			isSearchRefining,
		});
	}, [displayMode, locale, deviceType, isSearchRefining, stateStore]);

	// Persist state changes to widget state after user-initiated actions settle.
	// Using registerActionObserver instead of stateStore.subscribe ensures we
	// only call setWidgetState when an action (setState, pushState, filter, sort,
	// etc.) has resolved — not on every inbound data hydration write.
	useEffect(() => {
		const unsub = registerActionObserver({
			onSettle: (evt) => {
				if (!evt.ok) return; // don't persist if action threw
				const snapshot = stateStore.getSnapshot() as Record<string, unknown>;
				setWidgetState(
					createPersistedWidgetState(
						stateIdentity,
						diffInteractionState(snapshot, baseState),
					),
				);
			},
		});
		return unsub;
	}, [baseState, stateIdentity, stateStore, setWidgetState]);

	// Build action handlers: base from registry + MCP Apps-bridged overrides.
	// The overrides close over hook references so actions can use proper host integration.
	const actionHandlers = useMemo(() => {
		const base = buildTedixActionHandlers(stateStore);
		const openLink = async (params: Record<string, unknown>) => {
			setActionError(null);
			try {
				if (typeof params.url === "string")
					await openExternal(
						appendUtmParams(
							params.url,
							stateStore.getSnapshot()._utmParams as UtmParams | undefined,
						),
					);
			} catch (error) {
				setActionError(
					error instanceof Error
						? error.message
						: "The link could not be opened.",
				);
				throw error;
			}
		};
		return {
			...base,
			// selectItem: wrap base handler with analytics
			selectItem: async (params: Record<string, unknown>) => {
				await base.selectItem?.(params);
				void trackAnalytics({
					eventType: "select_item",
					itemId:
						(params.item as any)?.id ?? (params.itemId as string) ?? undefined,
					itemPosition:
						typeof params.index === "number" ? params.index : undefined,
					widgetKey: (stateStore.getSnapshot() as any)?._widgetKey as
						| string
						| undefined,
					displayMode: displayMode ?? undefined,
				});
			},
			// filter: wrap base handler with analytics
			filter: async (params: Record<string, unknown>) => {
				await base.filter?.(params);
				void trackAnalytics({
					eventType: "filter",
					metadata: JSON.stringify({
						field: params.field,
						value: params.value,
					}),
					widgetKey: (stateStore.getSnapshot() as any)?._widgetKey as
						| string
						| undefined,
					displayMode: displayMode ?? undefined,
				});
			},
			// sort: wrap base handler with analytics
			sort: async (params: Record<string, unknown>) => {
				await base.sort?.(params);
				void trackAnalytics({
					eventType: "sort",
					metadata: JSON.stringify({
						field: params.field ?? params.sortBy,
						order: params.order,
					}),
					widgetKey: (stateStore.getSnapshot() as any)?._widgetKey as
						| string
						| undefined,
					displayMode: displayMode ?? undefined,
				});
			},
			open_url: openLink,
			// Override open_external with proper MCP Apps hook + UTM + analytics
			open_external: async (params: Record<string, unknown>) => {
				await openLink(params);
				void trackAnalytics({
					eventType: "external_cta_click",
					metadata: JSON.stringify({ url: params.url }),
					widgetKey: (stateStore.getSnapshot() as any)?._widgetKey as
						| string
						| undefined,
					displayMode: displayMode ?? undefined,
				});
			},
			// Override follow_up with direct MCP Apps hook (no CustomEvent hack)
			follow_up: async (params: Record<string, unknown>) => {
				const query = params?.query;
				if (query && typeof query === "string") {
					await sendFollowUp(query);
				}
			},
			request_modal: async (params: Record<string, unknown>) => {
				if (params?.item && typeof params.item === "object") {
					const snapshot = stateStore.getSnapshot();
					const detailTpl = snapshot?._detailTemplate as string | undefined;
					if (detailTpl && modal.open) {
						try {
							await modal.open({
								template: detailTpl,
								params: { _detailItem: params.item },
								title:
									(params.item as Record<string, unknown>)?.title ?? "Details",
							});
						} catch {
							setDetailItem(params.item as Record<string, unknown>);
						}
					} else {
						setDetailItem(params.item as Record<string, unknown>);
					}
				}
			},
			// Display mode change via MCP Apps
			request_display_mode: async (params: Record<string, unknown>) => {
				const mode = params?.mode;
				if (mode && typeof mode === "string") {
					await requestDisplayMode(mode);
				}
			},
			// Generic host-mediated tool dispatch for layout action buttons.
			// Routed through the MCP Apps host adaptor, not `window.openai`:
			// MCP Apps hosts (the Tedix OS widget host and its gadget preview)
			// never define that global, so reading it would make this action a
			// silent no-op there. The host owns authorization.
			call_tool: async (params: Record<string, unknown>) => {
				setActionError(null);
				try {
					const name = params?.tool;
					if (typeof name !== "string" || !name.trim())
						throw new Error("This action has no tool configured.");
					await callHostTool(
						name,
						isRecord(params?.arguments) ? params.arguments : {},
					);
				} catch (error) {
					setActionError(
						error instanceof Error
							? error.message
							: "The action could not be completed.",
					);
					throw error;
				}
			},
			refine_search: async (params: Record<string, unknown>) => {
				const query = params?.query;
				if (query && typeof query === "string") {
					callSearchTool({ query });
				}
			},
		};
	}, [
		stateStore,
		openExternal,
		sendFollowUp,
		setDetailItem,
		modal,
		requestDisplayMode,
		callSearchTool,
		trackAnalytics,
		displayMode,
	]);

	// Build a model-context description from the current state
	const modelContext = effectiveData
		? `Showing ${(effectiveData as any).items?.length ?? 0} results${(effectiveData as any).query ? ` for "${(effectiveData as any).query}"` : ""} (locale: ${locale})`
		: null;

	useRenderCompleteSignal(rootRef, !isLoading, stateIdentity);

	if (isLoading) {
		return (
			<div
				data-widget-container="true"
				className="widget-container mx-auto max-w-4xl space-y-4 p-4"
			>
				<div className="h-8 w-1/3 animate-pulse rounded-lg bg-muted" />
				<div className="grid grid-cols-3 gap-4">
					<div className="h-48 animate-pulse rounded-lg bg-muted" />
					<div className="h-48 animate-pulse rounded-lg bg-muted" />
					<div className="h-48 animate-pulse rounded-lg bg-muted" />
				</div>
			</div>
		);
	}

	// Apply maxHeight constraint in inline mode (set by WidgetWrapper as CSS custom property)
	const containerStyle: CSSProperties =
		displayMode === "inline"
			? { maxHeight: "var(--widget-max-height, none)", overflow: "auto" }
			: {};

	const renderedWidget = (
		<JSONUIProvider
			registry={tedixRegistry}
			store={stateStore}
			handlers={actionHandlers}
			directives={tedixDirectives}
		>
			<Renderer spec={spec as any} registry={tedixRegistry} />
		</JSONUIProvider>
	);

	return (
		<div
			ref={rootRef}
			data-widget-container="true"
			className="widget-container mx-auto max-w-4xl bg-background p-4 font-sans text-foreground"
			style={containerStyle}
			data-device={deviceType}
		>
			{actionError && (
				<Alert
					color="danger"
					title="Action failed"
					description={actionError}
					onDismiss={() => setActionError(null)}
				/>
			)}
			<WidgetModelContext content={modelContext}>
				{renderedWidget}
			</WidgetModelContext>

			<Dialog
				open={!!detailItem}
				onOpenChange={(open) => {
					if (!open) setDetailItem(null);
				}}
			>
				<DialogContent size="lg" mobileBottomSheet>
					<DialogHeader>
						<DialogTitle>
							{(detailItem?.title as string) ?? "Details"}
						</DialogTitle>
					</DialogHeader>
					{detailItem && <ItemDetailContent item={detailItem} />}
				</DialogContent>
			</Dialog>
		</div>
	);
}

export function TedixRenderer(props: TedixRendererProps) {
	return (
		<WidgetWrapper>
			<TedixRendererInner {...props} />
		</WidgetWrapper>
	);
}
