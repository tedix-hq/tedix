import type { ReactNode } from "react";
import { Text } from "@/components/kumo/text";
import { formatCount } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The Workshop-brief section divider: a caption-role uppercase tracked label, a
 * hairline rule stretching to fill the row, and an optional right-aligned
 * count in faint grey.
 *
 * This is a shared primitive, so it must not hardcode a font size: every
 * consumer inherits whatever it declares. The eyebrow variant sits on the
 * Tedix `caption` role (11/16) and the console variant on `body` (14/20).
 */
export function SectionEyebrow({
	title,
	count,
	actions,
	className,
	variant = "eyebrow",
}: {
	title: string;
	count?: number;
	actions?: ReactNode;
	className?: string;
	variant?: "eyebrow" | "console";
}) {
	const consoleStyle = variant === "console";
	return (
		<div
			className={cn(
				"flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:gap-3",
				className,
			)}
		>
			<div className="flex min-w-0 w-full items-center gap-3">
				<Text
					as="h2"
					role={consoleStyle ? "body" : "caption"}
					weight="semibold"
					className={cn(
						"shrink-0",
						consoleStyle
							? "text-kumo-strong"
							: "text-kumo-subtle uppercase tracking-[0.9px]",
					)}
				>
					{title}
				</Text>
				<span
					aria-hidden
					className={cn(
						"min-w-4 flex-1",
						consoleStyle ? "h-0" : "h-px bg-kumo-hairline",
					)}
				/>
				{count !== undefined && (
					<Text
						as="span"
						role={consoleStyle ? "label" : "caption"}
						className={cn(
							"shrink-0 text-kumo-subtle tabular-nums",
							consoleStyle && "rounded-full bg-kumo-fill px-2 py-0.5",
						)}
					>
						{formatCount(count)}
					</Text>
				)}
			</div>
			{actions ? (
				<div className="min-w-0 w-full sm:w-auto sm:shrink-0">{actions}</div>
			) : null}
		</div>
	);
}
