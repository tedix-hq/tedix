import { Input as KumoInput } from "@cloudflare/kumo/components/input";
import { type ComponentPropsWithoutRef, forwardRef } from "react";
import { cn } from "@/lib/utils";
type InputProps = ComponentPropsWithoutRef<typeof KumoInput>;
const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
	{ className, size = "base", ...props },
	ref,
) {
	return (
		<KumoInput
			ref={ref}
			size={size}
			data-slot="input"
			className={cn(
				"w-full min-w-0 max-sm:min-h-11 coarse:min-h-11",
				className,
			)}
			{...props}
		/>
	);
});
export { Input, type InputProps };
