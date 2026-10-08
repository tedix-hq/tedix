import { SensitiveInput as KumoSensitiveInput } from "@cloudflare/kumo/components/sensitive-input";
import { type ComponentPropsWithoutRef, forwardRef } from "react";
import { cn } from "../../lib/utils";

/**
 * Why this adapter exists
 * -----------------------
 * OS collects API keys, tokens, and connection secrets in eight places, and
 * every one of them was a raw `<input type="password">`: no reveal affordance,
 * no copy affordance, and no way for an operator to confirm what they pasted.
 * Kumo's `SensitiveInput` already solves all three — masked by default, click
 * (or Enter/Space) to reveal, blur re-masks, and a built-in copy button with a
 * `document.execCommand` fallback for non-secure contexts.
 *
 * The adapter exists for the same reason `input.tsx` does: to hold the OS
 * density and typography contract. Kumo's own size classes put `text-xs` on
 * the compact tiers and give heights of 20/26/36/40px; OS pins the compact
 * tiers to the 24px/28px desktop rows from `docs/engineering/product/design.md`, pins type
 * to the Tedix roles, and keeps the 44px pointer-coarse touch floor. Kumo's
 * `className` lands on the *container* (which carries the size and focus
 * treatment), which is why these overrides work here exactly as they do in
 * `input.tsx`.
 *
 * When to use it
 * --------------
 * Any secret an operator enters or reads back: API keys, client secrets,
 * tokens, webhook signing keys. Use plain `Input` for a login password field,
 * where reveal/copy is the wrong affordance.
 */

type SensitiveInputProps = ComponentPropsWithoutRef<typeof KumoSensitiveInput>;
type SensitiveInputSize = NonNullable<SensitiveInputProps["size"]>;

const PRODUCT_SIZE_CLASS: Partial<Record<SensitiveInputSize, string>> = {
	xs: "!h-6",
	sm: "!h-7",
};

const TYPOGRAPHY_CLASS: Record<SensitiveInputSize, string> = {
	xs: "type-tedix-caption",
	sm: "type-tedix-caption",
	base: "type-tedix-body",
	lg: "type-tedix-body",
};

const SensitiveInput = forwardRef<HTMLInputElement, SensitiveInputProps>(
	function SensitiveInput({ className, size = "base", ...props }, ref) {
		return (
			<KumoSensitiveInput
				ref={ref}
				size={size}
				data-slot="sensitive-input"
				className={cn(
					"w-full min-w-0 max-sm:min-h-11 coarse:min-h-11",
					PRODUCT_SIZE_CLASS[size],
					TYPOGRAPHY_CLASS[size],
					className,
				)}
				{...props}
			/>
		);
	},
);

export { SensitiveInput, type SensitiveInputProps, type SensitiveInputSize };
