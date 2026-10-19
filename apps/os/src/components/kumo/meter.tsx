import { Meter as KumoMeter } from "@cloudflare/kumo/components/meter";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

type MeterProps = ComponentProps<typeof KumoMeter> & {
	/** Keep the accessible caption when adjacent content already labels a dense row. */
	hideLabel?: boolean;
};

function Meter({
	"aria-label": ariaLabel,
	className,
	hideLabel = false,
	indicatorClassName,
	label,
	showValue = !hideLabel,
	...props
}: MeterProps) {
	return (
		<KumoMeter
			aria-label={ariaLabel ?? label}
			data-slot="meter"
			label={label}
			showValue={showValue}
			className={cn(
				"min-w-0 type-tedix-body",
				hideLabel && "[&>div:first-child]:sr-only",
				className,
			)}
			indicatorClassName={cn(
				"duration-tedix-structural ease-tedix-standard motion-reduce:transition-none",
				indicatorClassName,
			)}
			{...props}
		/>
	);
}

export { Meter };
