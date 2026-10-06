import { Toggle } from "@cloudflare/kumo/primitives/toggle";
import { ToggleGroup } from "@cloudflare/kumo/primitives/toggle-group";
import type { ReactNode } from "react";

import { Button } from "@/components/kumo/button";
import { cn } from "@/lib/utils";

type SegmentedOption<Value extends string> = {
	value: Value;
	label: ReactNode;
};

type SegmentedControlProps<Value extends string> = {
	value: Value;
	onValueChange: (value: Value) => void;
	options: readonly SegmentedOption<Value>[];
	ariaLabel: string;
	className?: string;
	compact?: boolean;
};

const USAGE_PERIOD_OPTIONS = ["24h", "7d", "30d"].map((value) => ({
	value,
	label: value,
})) as readonly SegmentedOption<"24h" | "7d" | "30d">[];

/*
 * A row of buttons is not a choice control. Base UI's ToggleGroup (re-exported
 * by Kumo as `primitives/toggle-group`) keeps the pressed-button presentation
 * this component already had — `role="group"` on the rail, `aria-pressed` on
 * each segment — and adds what was missing: single-select enforcement and
 * roving arrow-key focus, so the group is one tab stop instead of N.
 *
 * Kumo's `components/radio` was the other candidate and was rejected: it paints
 * a radio control (default) or a bordered choice card, either of which would
 * change this component's visual density.
 */
function SegmentedControl<Value extends string>({
	value,
	onValueChange,
	options,
	ariaLabel,
	className,
	compact = false,
}: SegmentedControlProps<Value>) {
	return (
		<ToggleGroup
			aria-label={ariaLabel}
			data-kumo-component="SegmentedControl"
			data-compact={compact || undefined}
			className={cn(
				"flex w-fit max-w-full min-w-0 items-stretch gap-0.5 overflow-x-auto overscroll-x-contain rounded-lg bg-kumo-recessed p-0.5 ring ring-kumo-hairline/70 [scrollbar-gutter:stable] [scrollbar-width:thin]",
				className,
			)}
			onValueChange={(groupValue) => {
				// A segmented control always has a selection: pressing the active
				// segment must not clear it.
				const next = groupValue[0];
				if (next !== undefined && next !== value) onValueChange(next);
			}}
			value={[value]}
		>
			{options.map((option) => (
				<Toggle
					key={option.value}
					render={
						<Button
							className={cn(
								"shrink-0 rounded-md px-2.5 type-tedix-control shadow-none transition-colors motion-reduce:transition-none max-sm:min-h-11 max-sm:px-3 coarse:min-h-11 coarse:px-3",
								option.value === value
									? "bg-kumo-tint text-kumo-default hover:bg-kumo-tint"
									: "bg-transparent text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default",
							)}
							size="sm"
							type="button"
							variant="ghost"
						/>
					}
					value={option.value}
				>
					{option.label}
				</Toggle>
			))}
		</ToggleGroup>
	);
}

export { SegmentedControl, type SegmentedOption, USAGE_PERIOD_OPTIONS };
