import type { CSSProperties } from "react";
import { Loader } from "@/components/kumo/loader";
import { cn } from "@/lib/utils";

/**
 * A centered spinner for an area whose final shape is not known yet.
 * Use a Skeleton only where the loaded layout is known (rows, cards).
 */
export function LoadingArea({
	className = "h-40",
	style,
	label = "Loading",
	size = "lg",
}: {
	className?: string;
	style?: CSSProperties;
	label?: string;
	size?: "sm" | "base" | "lg";
}) {
	return (
		<div
			role="status"
			aria-busy="true"
			aria-label={label}
			className={cn("flex w-full items-center justify-center", className)}
			style={style}
		>
			<Loader size={size} />
		</div>
	);
}
