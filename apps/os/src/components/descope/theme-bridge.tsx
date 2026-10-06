import {
	syncDescopeThemeBridge,
	TEDIX_DESCOPE_THEME_CSS,
} from "@tedix/auth/descope-theme-bridge";
import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { useDescopeTheme } from "@/hooks/use-descope-theme";
import { installDescopeConsoleWarningFilter } from "@/lib/descope-config";

interface DescopeWidgetSurfaceProps {
	children?: ReactNode;
	className?: string;
	minHeightClassName?: string;
}

export function DescopeWidgetSurface({
	children,
	className = "",
	minHeightClassName = "min-h-[400px]",
}: DescopeWidgetSurfaceProps) {
	const theme = useDescopeTheme();
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => installDescopeConsoleWarningFilter(), []);

	useEffect(() => {
		if (!ref.current) return;
		return syncDescopeThemeBridge(ref.current, {
			cssText: TEDIX_DESCOPE_THEME_CSS,
			getTheme: () => theme,
		});
	}, [theme]);

	return (
		<div
			className={["descope-widget-container", minHeightClassName, className]
				.filter(Boolean)
				.join(" ")}
			ref={ref}
		>
			{children}
		</div>
	);
}
