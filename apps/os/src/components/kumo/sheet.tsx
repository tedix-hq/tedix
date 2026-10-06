"use client";

import { Dialog as SheetPrimitive } from "@cloudflare/kumo/primitives/dialog";
import { XIcon } from "@phosphor-icons/react";
import type * as React from "react";

import { cn } from "@/lib/utils";
import { Button } from "./button";

type SheetSize = "sm" | "md" | "lg" | "xl" | "2xl";

const sheetSizeClasses: Record<SheetSize, string> = {
	sm: "sm:max-w-sm",
	md: "sm:max-w-md",
	lg: "sm:max-w-lg",
	xl: "sm:max-w-xl",
	"2xl": "sm:max-w-2xl",
};

// Kumo does not currently ship a drawer/sheet primitive. Keep Base UI's Dialog
// behavior and style the drawer with Kumo semantic tokens.
function Sheet(props: SheetPrimitive.Root.Props) {
	return <SheetPrimitive.Root {...props} />;
}

function SheetPortal(props: SheetPrimitive.Portal.Props) {
	return <SheetPrimitive.Portal {...props} />;
}

/*
 * Backdrop and popup share the overlay rung of the stacking ladder in
 * `@tedix/design-tokens`; the popup wins over its own scrim by portal order.
 * Base UI's Dialog has no positioner, so the layer belongs on these elements
 * directly — unlike the anchored Select/Tooltip portals, where it must sit on
 * the positioner instead.
 */
function SheetOverlay({ className, ...props }: SheetPrimitive.Backdrop.Props) {
	return (
		<SheetPrimitive.Backdrop
			className={cn(
				"fixed inset-0 z-(--tedix-layer-overlay) bg-kumo-recessed opacity-80 transition-opacity duration-tedix-standard ease-tedix-standard motion-reduce:transition-none data-ending-style:opacity-0 data-starting-style:opacity-0",
				className,
			)}
			{...props}
		/>
	);
}

function SheetContent({
	className,
	children,
	side = "right",
	size = "sm",
	showCloseButton = true,
	...props
}: SheetPrimitive.Popup.Props & {
	side?: "top" | "right" | "bottom" | "left";
	size?: SheetSize;
	showCloseButton?: boolean;
}) {
	return (
		<SheetPortal>
			<SheetOverlay />
			<SheetPrimitive.Popup
				data-kumo-component="Sheet"
				data-side={side}
				className={cn(
					"fixed z-(--tedix-layer-overlay) flex flex-col bg-kumo-base text-kumo-default outline-none ring ring-kumo-line data-[side=right]:shadow-tedix-drawer data-[side=left]:shadow-tedix-drawer-left data-[side=top]:shadow-tedix-overlay data-[side=bottom]:shadow-tedix-overlay",
					"max-h-dvh transition-[transform,opacity] duration-tedix-structural ease-tedix-standard motion-reduce:transition-none data-ending-style:opacity-0 data-starting-style:opacity-0",
					"data-[side=right]:data-ending-style:translate-x-full data-[side=right]:data-starting-style:translate-x-full data-[side=right]:inset-y-0 data-[side=right]:right-0 data-[side=right]:h-full data-[side=right]:w-full data-[side=right]:sm:w-3/4",
					"data-[side=left]:data-ending-style:-translate-x-full data-[side=left]:data-starting-style:-translate-x-full data-[side=left]:inset-y-0 data-[side=left]:left-0 data-[side=left]:h-full data-[side=left]:w-full data-[side=left]:sm:w-3/4",
					"data-[side=top]:data-ending-style:-translate-y-full data-[side=top]:data-starting-style:-translate-y-full data-[side=top]:inset-x-0 data-[side=top]:top-0",
					"data-[side=bottom]:data-ending-style:translate-y-full data-[side=bottom]:data-starting-style:translate-y-full data-[side=bottom]:inset-x-0 data-[side=bottom]:bottom-0",
					(side === "right" || side === "left") && sheetSizeClasses[size],
					className,
				)}
				{...props}
			>
				{children}
				{showCloseButton && (
					<SheetPrimitive.Close
						render={
							<Button
								aria-label="Close"
								className="absolute top-4 right-4"
								size="icon-sm"
								variant="ghost"
							/>
						}
					>
						<XIcon aria-hidden className="size-4" />
						<span className="sr-only">Close</span>
					</SheetPrimitive.Close>
				)}
			</SheetPrimitive.Popup>
		</SheetPortal>
	);
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="sheet-header"
			className={cn("flex flex-col gap-1.5 p-4 sm:p-6", className)}
			{...props}
		/>
	);
}

function SheetTitle({ className, ...props }: SheetPrimitive.Title.Props) {
	return (
		<SheetPrimitive.Title
			className={cn(
				"font-semibold text-kumo-strong type-tedix-dialog",
				className,
			)}
			{...props}
		/>
	);
}

function SheetDescription({
	className,
	...props
}: SheetPrimitive.Description.Props) {
	return (
		<SheetPrimitive.Description
			className={cn("text-kumo-subtle type-tedix-body", className)}
			{...props}
		/>
	);
}

export {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
	type SheetSize,
};
