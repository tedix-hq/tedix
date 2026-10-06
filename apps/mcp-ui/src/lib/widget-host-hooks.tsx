import {
	useCallback,
	useEffect,
	useState,
	useSyncExternalStore,
	type ReactNode,
	type SetStateAction,
} from "react";
import { safeLinkHref } from "@tedix/widget-ui/safe-url";
import { chatGptHost, widgetHost } from "./widget-host";
import { appendUtmParams, type UtmParams } from "./utm";

const report = (error: unknown) =>
	console.error("Widget host action failed:", error);
const useHost = () =>
	useSyncExternalStore(
		widgetHost.subscribe,
		widgetHost.getSnapshot,
		widgetHost.getSnapshot,
	);
export const callHostTool = widgetHost.callTool;
export function useWidgetConnection() {
	useEffect(widgetHost.mount, []);
}
export function useWidgetLayout() {
	const { context } = useHost();
	return {
		theme: context.theme,
		maxHeight:
			context.containerDimensions && "maxHeight" in context.containerDimensions
				? context.containerDimensions.maxHeight
				: undefined,
		safeArea: {
			insets: context.safeAreaInsets ?? {
				top: 0,
				right: 0,
				bottom: 0,
				left: 0,
			},
		},
	};
}
export function useWidgetUser() {
	const { context } = useHost();
	return {
		locale:
			context.locale ??
			(typeof navigator === "undefined" ? "en" : navigator.language),
		userAgent: {
			device: { type: context.platform === "mobile" ? "mobile" : "desktop" },
			capabilities: {
				hover: context.deviceCapabilities?.hover ?? true,
				touch: context.deviceCapabilities?.touch ?? false,
			},
		},
	};
}
export function useWidgetToolInfo() {
	const { input, result, error, connected } = useHost();
	return {
		input,
		output: result?.structuredContent ?? null,
		responseMetadata: result?._meta ?? null,
		error,
		isSuccess: !!result && !result.isError,
		isPending: !result && !error && connected,
		isError: !!error || !!result?.isError,
	};
}
export function useWidgetDisplayMode(): [
	string,
	(mode: string) => Promise<void>,
] {
	const { context } = useHost();
	return [context.displayMode ?? "inline", widgetHost.requestDisplayMode];
}
export function useWidgetOpenExternal(utm?: UtmParams | null) {
	return useCallback(
		(url: string) => {
			const href = safeLinkHref(url);
			if (!href) return;
			const target = utm ? appendUtmParams(href, utm) : href;
			if (widgetHost.getSnapshot().connected) {
				const request = widgetHost.openLink(target);
				void request.catch(report);
				return request;
			} else if (typeof window !== "undefined")
				window.open(target, "_blank", "noopener,noreferrer");
		},
		[utm],
	);
}
export const useWidgetSendFollowUp = () => widgetHost.sendFollowUp;
export function useWidgetSetOpenInAppUrl() {
	return useCallback((href: string) => {
		const safe = safeLinkHref(href);
		const host = chatGptHost();
		if (safe && host?.setOpenInAppUrl)
			void Promise.resolve(host.setOpenInAppUrl({ href: safe })).catch(report);
	}, []);
}
export function useWidgetCallTool(name: string) {
	const [isPending, setPending] = useState(false);
	const callToolAsync = useCallback(
		async (args: Record<string, unknown>) => {
			setPending(true);
			try {
				return await widgetHost.callTool(name, args);
			} finally {
				setPending(false);
			}
		},
		[name],
	);
	return {
		isPending,
		callToolAsync,
		callTool: useCallback(
			(args: Record<string, unknown>) => {
				void callToolAsync(args).catch(report);
			},
			[callToolAsync],
		),
	};
}
export function useWidgetViewState<T extends Record<string, unknown>>(
	defaultState: T | (() => T),
): readonly [T, (state: SetStateAction<T>) => void] {
	const { viewState } = useHost();
	const [fallback] = useState(defaultState);
	const state = Object.keys(viewState).length ? (viewState as T) : fallback;
	const setState = useCallback(
		(value: SetStateAction<T>) => {
			const current = widgetHost.getSnapshot().viewState;
			const next =
				typeof value === "function"
					? value((Object.keys(current).length ? current : fallback) as T)
					: value;
			void widgetHost.setViewState(next).catch(report);
		},
		[fallback],
	);
	return [state, setState];
}
export function useWidgetModal() {
	useHost();
	const host = chatGptHost();
	return {
		isOpen: host?.view?.mode === "modal",
		params: host?.view?.params,
		open: host?.requestModal
			? (options: Record<string, unknown>) => host.requestModal!(options)
			: undefined,
	};
}
export function WidgetModelContext({
	content,
	children,
}: {
	content: string | null;
	children: ReactNode;
}) {
	const { connected } = useHost();
	useEffect(() => {
		if (connected) void widgetHost.setDescription(content).catch(report);
	}, [connected, content]);
	return <>{children}</>;
}
