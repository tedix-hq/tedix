"use client";

import { Select as KumoSelect } from "@cloudflare/kumo/components/select";
import { Select as SelectPrimitive } from "@cloudflare/kumo/primitives/select";
import {
	CaretDownIcon,
	CaretUpDownIcon,
	CaretUpIcon,
	CheckIcon,
} from "@phosphor-icons/react";
import type * as React from "react";

import { cn } from "@/lib/utils";

// Kumo's Select is intentionally a batteries-included component. OS call sites
// use the shadcn-style compound API, so this adapter keeps Base UI's
// behavior while applying Kumo's semantic tokens and visual language.
const Select = SelectPrimitive.Root;

function SelectValue({
	className,
	placeholder,
	...props
}: SelectPrimitive.Value.Props & { placeholder?: React.ReactNode }) {
	return (
		<SelectPrimitive.Value
			className={cn(
				"min-w-0 flex-1 truncate text-left data-[placeholder]:text-kumo-placeholder",
				className,
			)}
			placeholder={placeholder}
			{...props}
		/>
	);
}

function SelectTrigger({
	className,
	size = "default",
	children,
	...props
}: SelectPrimitive.Trigger.Props & { size?: "sm" | "default" }) {
	return (
		<SelectPrimitive.Trigger
			data-kumo-component="Select"
			data-kumo-part="trigger"
			data-size={size}
			className={cn(
				"inline-flex items-center justify-between gap-1.5 rounded-lg bg-kumo-base px-3 font-normal text-kumo-default shadow-none ring ring-kumo-line transition-colors motion-reduce:transition-none max-sm:min-h-11 max-sm:min-w-11 coarse:min-h-11 coarse:min-w-11",
				"focus:outline-none focus-visible:ring-2 focus-visible:ring-kumo-focus disabled:cursor-not-allowed disabled:opacity-50",
				"data-[size=default]:h-9 data-[size=sm]:h-7 data-[size=sm]:rounded-md data-[size=sm]:px-2",
				size === "default" ? "type-tedix-body" : "type-tedix-control",
				className,
			)}
			{...props}
		>
			{children}
			<SelectPrimitive.Icon className="flex shrink-0 items-center text-kumo-subtle">
				<CaretUpDownIcon aria-hidden className="size-4 fill-current" />
			</SelectPrimitive.Icon>
		</SelectPrimitive.Trigger>
	);
}

function SelectContent({
	className,
	children,
	side = "bottom",
	sideOffset = 8,
	align = "center",
	alignOffset = 0,
	alignItemWithTrigger = true,
	...props
}: SelectPrimitive.Popup.Props &
	Pick<
		SelectPrimitive.Positioner.Props,
		"align" | "alignOffset" | "side" | "sideOffset" | "alignItemWithTrigger"
	>) {
	return (
		<SelectPrimitive.Portal>
			<SelectPrimitive.Positioner
				side={side}
				sideOffset={sideOffset}
				align={align}
				alignOffset={alignOffset}
				alignItemWithTrigger={alignItemWithTrigger}
				/*
				 * The stacking layer belongs on the positioner, not the popup: Base
				 * UI's other positioning modes set `transform: translate(...)` here,
				 * which is a stacking context a popup-level z-index could never escape.
				 * `isolate` is load-bearing rather than redundant — with
				 * `alignItemWithTrigger` active (the default) Base UI swaps those
				 * styles for a bare `position: fixed` with NO transform, so this is the
				 * only thing that keeps the popup's internal sticky scroll buttons and
				 * `focus-visible:z-50` items from competing at page level.
				 */
				className="isolate z-(--tedix-layer-dropdown)"
			>
				<SelectPrimitive.Popup
					data-kumo-component="Select"
					data-kumo-part="popup"
					className={cn(
						"flex max-h-[var(--available-height)] min-w-[calc(var(--anchor-width)+3px)] origin-[var(--transform-origin)] flex-col overflow-hidden rounded-lg bg-kumo-base py-1.5 text-kumo-default shadow-tedix-floating ring ring-kumo-line",
						"transition-[transform,scale,opacity] duration-tedix-standard ease-tedix-standard motion-reduce:transition-none data-ending-style:scale-95 data-starting-style:scale-95 data-ending-style:opacity-0 data-starting-style:opacity-0",
						className,
					)}
					{...props}
				>
					<SelectScrollUpButton />
					<SelectPrimitive.List className="min-h-0 flex-1 scroll-py-2 overflow-y-auto overscroll-none">
						{children}
					</SelectPrimitive.List>
					<SelectScrollDownButton />
				</SelectPrimitive.Popup>
			</SelectPrimitive.Positioner>
		</SelectPrimitive.Portal>
	);
}

function SelectItem({
	className,
	children,
	...props
}: SelectPrimitive.Item.Props) {
	return (
		<SelectPrimitive.Item
			data-kumo-component="Select"
			data-kumo-part="option"
			className={cn(
				"group mx-1.5 flex cursor-pointer items-center justify-between gap-2 rounded px-2 py-1.5 type-tedix-control outline-none transition-colors motion-reduce:transition-none max-sm:min-h-11 coarse:min-h-11",
				"focus-visible:z-50 focus-visible:ring-2 focus-visible:ring-kumo-focus focus-visible:ring-inset data-highlighted:bg-kumo-tint",
				"data-[disabled]:pointer-events-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
				className,
			)}
			{...props}
		>
			<SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
			<SelectPrimitive.ItemIndicator className="ml-auto flex size-4 items-center justify-center">
				<CheckIcon aria-hidden className="size-4" weight="bold" />
			</SelectPrimitive.ItemIndicator>
		</SelectPrimitive.Item>
	);
}

function SelectScrollUpButton({
	className,
	...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpArrow>) {
	return (
		<SelectPrimitive.ScrollUpArrow
			className={cn(
				"sticky top-0 z-10 flex w-full items-center justify-center bg-kumo-base py-1 text-kumo-subtle max-sm:min-h-11 coarse:min-h-11",
				className,
			)}
			{...props}
		>
			<CaretUpIcon aria-hidden className="size-4" />
		</SelectPrimitive.ScrollUpArrow>
	);
}

function SelectScrollDownButton({
	className,
	...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownArrow>) {
	return (
		<SelectPrimitive.ScrollDownArrow
			className={cn(
				"sticky bottom-0 z-10 flex w-full items-center justify-center bg-kumo-base py-1 text-kumo-subtle max-sm:min-h-11 coarse:min-h-11",
				className,
			)}
			{...props}
		>
			<CaretDownIcon aria-hidden className="size-4" />
		</SelectPrimitive.ScrollDownArrow>
	);
}

export {
	KumoSelect,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
};
