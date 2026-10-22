import { ClipboardText as KumoClipboardText } from "@cloudflare/kumo/components/clipboard-text";
import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/utils";

/**
 * Console's copyable value. Prefer this over a hand-rolled
 * `navigator.clipboard.writeText` button so copy affordances share one
 * confirmation animation, one tooltip contract, and one accessible label set.
 *
 * Kumo's small copy button is 26px; on phones and touch screens it grows to
 * the same 44px target every OS button has, and the field grows with it so
 * its clipped frame never cuts the button's focus ring.
 */
const ClipboardText = forwardRef<
	HTMLDivElement,
	ComponentPropsWithoutRef<typeof KumoClipboardText>
>(({ className, ...props }, ref) => (
	<KumoClipboardText
		ref={ref}
		className={cn(
			"max-sm:h-auto coarse:h-auto max-sm:[&_button]:min-h-11 max-sm:[&_button]:min-w-11 coarse:[&_button]:min-h-11 coarse:[&_button]:min-w-11",
			className,
		)}
		{...props}
	/>
));
ClipboardText.displayName = "ClipboardText";

export { ClipboardText };
