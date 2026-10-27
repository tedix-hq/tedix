import { Toggle } from "@cloudflare/kumo/primitives/toggle";
import { ToggleGroup } from "@cloudflare/kumo/primitives/toggle-group";
import { type ReactNode, useEffect, useRef } from "react";

import { Button } from "@/components/kumo/button";
import { cn } from "@/lib/utils";

type SegmentedOption<Value extends string> = {
	value: Value;
	label: ReactNode;
	/** Drawn before the label. */
	icon?: ReactNode;
};

/** An icon segment: the label is its accessible name and tooltip. */
type IconSegmentedOption<Value extends string> = {
	value: Value;
	label: string;
	icon: ReactNode;
};

type SegmentedControlProps<Value extends string> = {
	value: Value;
	onValueChange: (value: Value) => void;
	ariaLabel: string;
	className?: string;
	compact?: boolean;
	/** Stretch to the container width with equal-width segments. */
	fill?: boolean;
} & (
	| { iconOnly?: false; options: readonly SegmentedOption<Value>[] }
	/**
	 * Square segments on the Button adapter's icon size, so the glyph stays
	 * centred at 32px and at the 44px touch target.
	 */
	| { iconOnly: true; options: readonly IconSegmentedOption<Value>[] }
);

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
	fill = false,
	iconOnly = false,
}: SegmentedControlProps<Value>) {
	const groupRef = useRef<HTMLDivElement>(null);
	// A narrow row scrolls the segments; keep the selected one in sight when the
	// value changes or the row is resized (for example when chat opens).
	useEffect(() => {
		const group = groupRef.current;
		if (!group) return;
		const reveal = () => {
			const active = group.querySelector<HTMLElement>('[aria-pressed="true"]');
			if (!active) return;
			const box = active.getBoundingClientRect();
			const view = group.getBoundingClientRect();
			if (box.right > view.right) group.scrollLeft += box.right - view.right;
			else if (box.left < view.left) group.scrollLeft -= view.left - box.left;
		};
		reveal();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(reveal);
		observer.observe(group);
		return () => observer.disconnect();
	}, [value]);
	return (
		<ToggleGroup
			ref={groupRef}
			aria-label={ariaLabel}
			data-kumo-component="SegmentedControl"
			data-focus-ring="inset"
			data-compact={compact || undefined}
			className={cn(
				"flex max-w-full min-w-0 items-stretch gap-0.5 overflow-x-auto overscroll-x-contain rounded-lg bg-kumo-recessed p-0.5 ring ring-kumo-hairline/70 [scrollbar-gutter:stable] [scrollbar-width:thin]",
				fill ? "w-full" : "w-fit",
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
			{options.map((option) => {
				const tone =
					option.value === value
						? "bg-kumo-tint text-kumo-default hover:bg-kumo-tint"
						: "bg-transparent text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default";
				return (
					<Toggle
						key={option.value}
						render={
							iconOnly ? (
								<Button
									aria-label={option.label as string}
									className={cn(
										"shrink-0 !rounded-md shadow-none transition-colors",
										tone,
									)}
									size="icon-sm"
									title={option.label as string}
									type="button"
									variant="ghost"
								/>
							) : (
								<Button
									className={cn(
										fill ? "flex-1 justify-center" : "shrink-0",
										"rounded-md px-2.5 type-tedix-control shadow-none transition-colors max-sm:px-3 coarse:px-3",
										tone,
									)}
									icon={option.icon}
									size="sm"
									type="button"
									variant="ghost"
								/>
							)
						}
						value={option.value}
					>
						{iconOnly ? option.icon : option.label}
					</Toggle>
				);
			})}
		</ToggleGroup>
	);
}

export { SegmentedControl, type SegmentedOption, USAGE_PERIOD_OPTIONS };
