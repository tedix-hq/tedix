/**
 * PreviewRenderer — Standalone renderer for screenshot/validation previews.
 * No MCP Apps, no WidgetWrapper. Renders a spec with injected data directly.
 * Sets data-render-complete on the root element after mount for puppeteer.
 *
 */

import { isNonEmptySpec } from "@json-render/core";
import { JsonRenderDevtools } from "@json-render/devtools-react";
import { createStateStore, JSONUIProvider, Renderer } from "@json-render/react";
import {
	Component,
	type ReactNode,
	type RefObject,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { buildTedixActionHandlers } from "../json-render/handler-utils";
import { tedixDirectives, tedixRegistry } from "../json-render/registry";
import { readEmbeddedSpec } from "../lib/read-embedded-spec";
import { isRecord } from "@tedix/api-contract/utils/is-record";

interface PreviewRendererProps {
	spec?: Record<string, unknown>;
	data?: Record<string, unknown>;
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
	identity: string,
) {
	useEffect(() => {
		const root = rootRef.current;
		if (!root) return;

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
					detail: { identity, preview: true },
				}),
			);
		};

		void markComplete();
		return () => {
			cancelled = true;
		};
	}, [identity, rootRef]);
}

class ErrorBoundary extends Component<
	{ children: ReactNode },
	{ hasError: boolean; error: Error | null }
> {
	constructor(props: { children: ReactNode }) {
		super(props);
		this.state = { hasError: false, error: null };
	}
	static getDerivedStateFromError(error: Error) {
		return { hasError: true, error };
	}
	render() {
		if (this.state.hasError) {
			return (
				<div className="rounded-lg border border-destructive bg-destructive/10 p-4">
					<h3 className="font-semibold text-destructive">Render Error</h3>
					<p className="mt-1 text-muted-foreground text-sm">
						{this.state.error?.message ?? "Unknown error"}
					</p>
				</div>
			);
		}
		return this.props.children;
	}
}

export function PreviewRenderer({
	spec: propSpec,
	data,
}: PreviewRendererProps) {
	const rootRef = useRef<HTMLDivElement>(null);

	const [spec] = useState<Record<string, unknown> | null>(
		() => readEmbeddedSpec() ?? propSpec ?? null,
	);
	const hasSpec = isNonEmptySpec(spec);

	const specState = (spec as any)?.state as Record<string, unknown> | undefined;
	const initialState = useMemo(
		() => ({ ...specState, ...data }),
		[specState, data],
	);
	const renderIdentity = useMemo(
		() =>
			hashString(
				stableSerialize({
					data,
					route:
						typeof window !== "undefined"
							? `${window.location.pathname}${window.location.search}`
							: "ssr",
					spec,
				}),
			),
		[data, spec],
	);

	const storeRef = useRef<ReturnType<typeof createStateStore> | null>(null);
	const prevStateRef = useRef<Record<string, unknown> | null>(null);
	if (!storeRef.current) {
		storeRef.current = createStateStore(initialState);
		prevStateRef.current = initialState;
	}
	const stateStore = storeRef.current;

	useEffect(() => {
		const prev = prevStateRef.current ?? {};
		const updates: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(initialState)) {
			updates[`/${key}`] = value;
		}
		for (const key of Object.keys(prev)) {
			if (!(key in initialState)) {
				updates[`/${key}`] = undefined;
			}
		}
		stateStore.update(updates);
		prevStateRef.current = initialState;
	}, [initialState, stateStore]);

	// Expose store on window for Puppeteer-based widget tests (page.evaluate injection)
	useEffect(() => {
		(window as any).__TEDIX_STORE__ = stateStore;
		return () => {
			delete (window as any).__TEDIX_STORE__;
		};
	}, [stateStore]);

	const actionHandlers = useMemo(
		() => buildTedixActionHandlers(stateStore),
		[stateStore],
	);

	useRenderCompleteSignal(rootRef, renderIdentity);

	if (!hasSpec) {
		return (
			<div
				ref={rootRef}
				data-widget-container="true"
				className="widget-container p-4 text-center text-muted-foreground"
			>
				<p>No layout configured</p>
			</div>
		);
	}

	return (
		<div
			ref={rootRef}
			data-widget-container="true"
			className="widget-container mx-auto max-w-4xl bg-background p-4 font-sans text-foreground"
		>
			<ErrorBoundary>
				<JSONUIProvider
					registry={tedixRegistry}
					store={stateStore}
					handlers={actionHandlers}
					directives={tedixDirectives}
				>
					<Renderer spec={spec as any} registry={tedixRegistry} />
					{import.meta.env.DEV && <JsonRenderDevtools />}
				</JSONUIProvider>
			</ErrorBoundary>
		</div>
	);
}
