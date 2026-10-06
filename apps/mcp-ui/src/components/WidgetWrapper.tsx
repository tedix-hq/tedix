/**
 * WidgetWrapper - Shared wrapper for all widget React islands
 *
 * Provides:
 * 1. LayoutProvider - Syncs Apps SDK layout state (theme, maxHeight, safeArea) + device info to DOM
 * 2. Error Boundary - Catches React errors with fallback UI
 *
 * Usage in Astro pages:
 * ```astro
 * <WidgetWrapper client:only="react">
 *   <MyWidget />
 * </WidgetWrapper>
 * ```
 *
 * Or wrap widget exports:
 * ```tsx
 * export default function MyWidget(props) {
 *   return (
 *     <WidgetWrapper>
 *       <MyWidgetInner {...props} />
 *     </WidgetWrapper>
 *   );
 * }
 * ```
 */

import { Component, type ReactNode, useEffect } from "react";
import {
	useWidgetConnection,
	useWidgetLayout,
	useWidgetUser,
} from "../lib/widget-host-hooks";

// =============================================================================
// Layout Provider
// =============================================================================

interface LayoutProviderProps {
	children: ReactNode;
	defaultTheme?: "light" | "dark";
}

export function resolveStandaloneTheme(
	search: string,
	fallback: "light" | "dark",
): "light" | "dark" {
	const requested = new URLSearchParams(search).get("theme");
	return requested === "dark" || requested === "light" ? requested : fallback;
}

function standaloneTheme(fallback: "light" | "dark"): "light" | "dark" {
	return resolveStandaloneTheme(
		typeof window === "undefined" ? "" : window.location.search,
		fallback,
	);
}

function LayoutProvider({
	children,
	defaultTheme = "light",
}: LayoutProviderProps) {
	useWidgetConnection();
	const { theme, maxHeight, safeArea } = useWidgetLayout();
	// The embed host mirrors its current theme into the frame URL. Prefer that
	// explicit value over a bridge fallback because some standalone/partial
	// Use the branded theme until host context is available.
	const resolvedTheme = standaloneTheme(theme ?? defaultTheme);

	const user = useWidgetUser();
	const deviceType = user.userAgent.device.type;
	const { hover, touch } = user.userAgent.capabilities;
	const resolvedHover = hover;
	const resolvedTouch = touch;
	const resolvedMaxHeight = maxHeight;
	const resolvedSafeArea = safeArea?.insets;

	useEffect(() => {
		const root = document.documentElement;
		if (resolvedTheme === "dark") {
			root.classList.add("dark");
		} else {
			root.classList.remove("dark");
		}
		root.setAttribute("data-theme", resolvedTheme);
		root.style.colorScheme = resolvedTheme;
		root.setAttribute("data-device-type", deviceType);
		root.setAttribute("data-hover", String(resolvedHover));
		root.setAttribute("data-touch", String(resolvedTouch));

		// Surface maxHeight as CSS custom property for descendant components
		if (resolvedMaxHeight != null) {
			root.style.setProperty("--widget-max-height", `${resolvedMaxHeight}px`);
		} else {
			root.style.removeProperty("--widget-max-height");
		}

		// Surface safe area insets as CSS custom properties
		if (resolvedSafeArea) {
			root.style.setProperty("--safe-area-top", `${resolvedSafeArea.top}px`);
			root.style.setProperty(
				"--safe-area-right",
				`${resolvedSafeArea.right}px`,
			);
			root.style.setProperty(
				"--safe-area-bottom",
				`${resolvedSafeArea.bottom}px`,
			);
			root.style.setProperty("--safe-area-left", `${resolvedSafeArea.left}px`);
		}
	}, [
		resolvedTheme,
		deviceType,
		resolvedHover,
		resolvedTouch,
		resolvedMaxHeight,
		resolvedSafeArea,
	]);

	return <>{children}</>;
}

// =============================================================================
// Error Boundary
// =============================================================================

interface ErrorBoundaryProps {
	children: ReactNode;
	fallback?: ReactNode;
}

interface ErrorBoundaryState {
	hasError: boolean;
	error: Error | null;
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
	constructor(props: ErrorBoundaryProps) {
		super(props);
		this.state = { hasError: false, error: null };
	}

	static getDerivedStateFromError(error: Error): ErrorBoundaryState {
		return { hasError: true, error };
	}

	componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
		console.error("[WidgetWrapper] Error caught:", {
			error: error.message,
			stack: error.stack,
			componentStack: errorInfo.componentStack,
		});
	}

	render() {
		if (this.state.hasError) {
			return (
				this.props.fallback || (
					<div className="rounded-lg border border-destructive bg-destructive/10 p-4">
						<h3 className="font-semibold text-destructive">Widget Error</h3>
						<p className="mt-1 text-muted-foreground text-sm">
							{this.state.error?.message ||
								"An error occurred loading the widget"}
						</p>
					</div>
				)
			);
		}
		return this.props.children;
	}
}

// =============================================================================
// Widget Wrapper (combines both)
// =============================================================================

interface WidgetWrapperProps {
	children: ReactNode;
	/** Default theme before Apps SDK provides one */
	defaultTheme?: "light" | "dark";
	/** Custom error fallback */
	errorFallback?: ReactNode;
}

export function WidgetWrapper({
	children,
	defaultTheme = "light",
	errorFallback,
}: WidgetWrapperProps) {
	return (
		<LayoutProvider defaultTheme={defaultTheme}>
			<ErrorBoundary fallback={errorFallback}>{children}</ErrorBoundary>
		</LayoutProvider>
	);
}
