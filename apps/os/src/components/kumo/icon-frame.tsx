import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

type IconFrameSize = "sm" | "md" | "lg";
type IconFrameAppearance = "outline" | "fill";

const SIZE_CLASSES: Record<IconFrameSize, string> = {
	sm: "size-8 rounded-lg",
	md: "size-9 rounded-lg",
	lg: "size-11 rounded-xl",
};

const APPEARANCE_CLASSES: Record<IconFrameAppearance, string> = {
	outline: "border border-kumo-hairline bg-kumo-elevated",
	fill: "bg-kumo-fill",
};

function IconFrame({
	appearance = "outline",
	size = "md",
	className,
	...props
}: ComponentProps<"span"> & {
	appearance?: IconFrameAppearance;
	size?: IconFrameSize;
}) {
	return (
		<span
			data-slot="icon-frame"
			data-appearance={appearance}
			data-size={size}
			className={cn(
				"flex shrink-0 items-center justify-center text-kumo-subtle",
				SIZE_CLASSES[size],
				APPEARANCE_CLASSES[appearance],
				className,
			)}
			{...props}
		/>
	);
}

export { IconFrame };
export type { IconFrameAppearance, IconFrameSize };
