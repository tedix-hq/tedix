import { Switch as KumoSwitch } from "@cloudflare/kumo/components/switch";
import type * as React from "react";
import { cn } from "@/lib/utils";

type SwitchProps = Omit<React.ComponentProps<typeof KumoSwitch>, "size"> & {
	size?: "sm" | "default";
};

function Switch({
	className,
	size = "default",
	variant = "default",
	...props
}: SwitchProps) {
	return (
		// The `after:` pseudo-element is a 44px hit area centred on a track that
		// is deliberately smaller than a fingertip. Narrow product layouts get
		// the same predictable target as coarse pointers; the pointer rule still
		// protects touch laptops at wider viewports.
		<KumoSwitch
			className={cn(
				"relative after:absolute after:top-1/2 after:left-1/2 after:hidden after:h-11 after:w-11 after:-translate-x-1/2 after:-translate-y-1/2 after:content-[''] max-sm:after:block coarse:after:block",
				variant === "default" &&
					"data-checked:!bg-kumo-brand data-checked:!ring-kumo-brand data-checked:[&>div]:!bg-kumo-base",
				className,
			)}
			size={size === "default" ? "base" : size}
			variant={variant}
			{...props}
		/>
	);
}

export { Switch, type SwitchProps };
