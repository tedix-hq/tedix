import type { CSSProperties } from "react";
import { LoadingArea } from "@/components/loading-area";

/** What an app shows while it starts: a centered spinner, not a grey block. */
export function AppLoading({
	className,
	style,
	label = "Loading app",
}: {
	className?: string;
	style?: CSSProperties;
	label?: string;
}) {
	return <LoadingArea className={className} style={style} label={label} />;
}
