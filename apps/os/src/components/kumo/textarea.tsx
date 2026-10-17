import {
	Textarea as KumoTextarea,
	type InputAreaProps,
} from "@cloudflare/kumo/components/input";
import { forwardRef } from "react";

import { cn } from "@/lib/utils";

type TextareaProps = InputAreaProps;

const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
	({ className, rows = 3, ...props }, ref) => (
		<KumoTextarea
			ref={ref}
			rows={rows}
			data-kumo-component="Textarea"
			className={cn(
				"min-h-16 field-sizing-content w-full resize-y type-tedix-body",
				className,
			)}
			{...props}
		/>
	),
);
Textarea.displayName = "Textarea";

export { Textarea, type TextareaProps };
