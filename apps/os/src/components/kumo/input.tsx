import { Input as KumoInput } from "@cloudflare/kumo/components/input";
import { type ComponentPropsWithoutRef, forwardRef } from "react";
import { cn } from "../../lib/utils";

type InputProps = ComponentPropsWithoutRef<typeof KumoInput>;
type InputSize = NonNullable<InputProps["size"]>;

const PRODUCT_SIZE_CLASS: Partial<Record<InputSize, string>> = {
	xs: "!h-6",
	sm: "!h-7",
};

const TYPOGRAPHY_CLASS: Record<InputSize, string> = {
	xs: "type-tedix-caption",
	sm: "type-tedix-caption",
	base: "type-tedix-body",
	lg: "type-tedix-body",
};

const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
	{ className, size = "base", type, ...props },
	ref,
) {
	return (
		<KumoInput
			ref={ref}
			size={size}
			type={type}
			data-slot="input"
			className={cn(
				"w-full min-w-0 max-sm:min-h-11 coarse:min-h-11 file:mr-3 file:border-0 file:bg-transparent file:font-medium file:text-[length:var(--text-tedix-control)] file:leading-[var(--text-tedix-control--line-height)] file:text-kumo-default",
				PRODUCT_SIZE_CLASS[size],
				TYPOGRAPHY_CLASS[size],
				className,
			)}
			{...props}
		/>
	);
});

export { Input, type InputProps };
