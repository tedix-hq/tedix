import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function WorkspaceListRow({
	className,
	...props
}: ComponentProps<"li">) {
	return (
		<li
			className={cn(
				"flex min-h-11 min-w-0 items-center gap-3 px-3 py-3",
				className,
			)}
			{...props}
		/>
	);
}
