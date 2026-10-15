"use client";

import { ContextMenu as ContextMenuPrimitive } from "@cloudflare/kumo/primitives/context-menu";
import type * as React from "react";

import { cn } from "@/lib/utils";

/*
 * Right-click menu on Base UI's context-menu primitive, styled to match the
 * dropdown adapter so both menus read as one family.
 */
const ContextMenu = ContextMenuPrimitive.Root;
const ContextMenuTrigger = ContextMenuPrimitive.Trigger;

function ContextMenuContent({
	className,
	children,
}: {
	className?: string;
	children: React.ReactNode;
}) {
	return (
		<ContextMenuPrimitive.Portal>
			<ContextMenuPrimitive.Positioner className="isolate z-(--tedix-layer-dropdown)">
				<ContextMenuPrimitive.Popup
					data-kumo-component="ContextMenu"
					className={cn(
						"min-w-44 max-h-[var(--available-height)] overflow-y-auto rounded-lg bg-kumo-control p-1.5 text-kumo-default shadow-tedix-floating ring ring-kumo-line outline-hidden",
						className,
					)}
				>
					{children}
				</ContextMenuPrimitive.Popup>
			</ContextMenuPrimitive.Positioner>
		</ContextMenuPrimitive.Portal>
	);
}

function ContextMenuItem({
	className,
	variant = "default",
	shortcut,
	children,
	...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Item> & {
	variant?: "default" | "danger";
	shortcut?: string;
}) {
	return (
		<ContextMenuPrimitive.Item
			className={cn(
				"relative flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 type-tedix-control outline-hidden select-none max-sm:min-h-11 coarse:min-h-11 data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-kumo-overlay [&>svg]:shrink-0",
				variant === "danger" && "text-kumo-danger",
				className,
			)}
			{...props}
		>
			{children}
			{shortcut ? (
				<span className="ml-auto pl-4 text-kumo-subtle type-tedix-label">
					{shortcut}
				</span>
			) : null}
		</ContextMenuPrimitive.Item>
	);
}

function ContextMenuSeparator() {
	return (
		<ContextMenuPrimitive.Separator className="-mx-1 my-1 h-px bg-kumo-hairline" />
	);
}

export {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
};
