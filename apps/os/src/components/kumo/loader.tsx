import { Loader as KumoLoader } from "@cloudflare/kumo/components/loader";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

type LoaderProps = ComponentProps<typeof KumoLoader>;

/**
 * Console's indeterminate spinner. Prefer this over a hand-rolled
 * `animate-spin` icon so loading affordances share one size ramp, one motion
 * duration, and one `motion-reduce` behavior.
 */
function Loader({ className, ...props }: LoaderProps) {
	return <KumoLoader data-slot="loader" className={cn(className)} {...props} />;
}

export { Loader, type LoaderProps };
