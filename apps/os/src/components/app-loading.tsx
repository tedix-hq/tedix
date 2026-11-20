import type { CSSProperties } from "react";
import { Loader } from "@/components/kumo/loader";
import { cn } from "@/lib/utils";

/** What an app shows while it starts: a centered spinner, not a grey block. */
export function AppLoading({
	className = "h-40",
	style,
	label = "Loading app",
}: {
	className?: string;
	style?: CSSProperties;
	label?: string;
}) {
	return (
		<div
			role="status"
			aria-busy="true"
			aria-label={label}
			className={cn("flex w-full items-center justify-center", className)}
			style={style}
		>
			<Loader size="lg" />
		</div>
	);
}
