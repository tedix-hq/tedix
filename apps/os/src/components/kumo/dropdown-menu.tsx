"use client";

import { DropdownMenu as KumoDropdownMenu } from "@cloudflare/kumo/components/dropdown";
import { Menu as MenuPrimitive } from "@cloudflare/kumo/primitives/menu";
import * as React from "react";

import { cn } from "@/lib/utils";

const DropdownMenu = KumoDropdownMenu;
const DropdownMenuTrigger = KumoDropdownMenu.Trigger;
const DropdownMenuGroup = KumoDropdownMenu.Group;
const DropdownMenuLabel = KumoDropdownMenu.Label;
const DropdownMenuSeparator = KumoDropdownMenu.Separator;

// The 44px floor is a pointer-capability question: a touch laptop above `sm`
// still needs it, a narrow desktop window does not.
const COARSE_MENU_ITEM =
	"gap-2 type-tedix-control transition-colors motion-reduce:transition-none max-sm:min-h-11 coarse:min-h-11 [&>svg]:shrink-0";
const REDUCED_MOTION_POPUP =
	"shadow-tedix-floating motion-reduce:animate-none motion-reduce:transition-none";
const MENU_POPUP =
	"min-w-36 max-h-[var(--available-height)] overflow-y-auto rounded-lg bg-kumo-control p-1.5 text-kumo-default ring ring-kumo-line data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95";

const DropdownMenuContent = React.forwardRef<
	React.ComponentRef<typeof KumoDropdownMenu.Content>,
	React.ComponentPropsWithoutRef<typeof KumoDropdownMenu.Content>
>(function DropdownMenuContent({ className, ...props }, ref) {
	const { children, container, sideOffset = 8, ...positionerProps } = props;
	return (
		<MenuPrimitive.Portal container={container}>
			<MenuPrimitive.Positioner
				ref={ref}
				sideOffset={sideOffset}
				className="isolate z-(--tedix-layer-dropdown)"
				{...positionerProps}
			>
				<MenuPrimitive.Popup
					className={cn(MENU_POPUP, REDUCED_MOTION_POPUP, className)}
				>
					{children}
				</MenuPrimitive.Popup>
			</MenuPrimitive.Positioner>
		</MenuPrimitive.Portal>
	);
});

type DropdownMenuItemProps = Omit<
	React.ComponentProps<typeof KumoDropdownMenu.Item>,
	"variant"
> & {
	variant?: "default" | "destructive" | "danger";
};

function DropdownMenuItem({
	className,
	variant = "default",
	...props
}: DropdownMenuItemProps) {
	return (
		<KumoDropdownMenu.Item
			className={cn(COARSE_MENU_ITEM, className)}
			variant={variant === "destructive" ? "danger" : variant}
			{...props}
		/>
	);
}

const DropdownMenuLinkItem = React.forwardRef<
	React.ComponentRef<typeof KumoDropdownMenu.LinkItem>,
	React.ComponentPropsWithoutRef<typeof KumoDropdownMenu.LinkItem>
>(function DropdownMenuLinkItem({ className, ...props }, ref) {
	return (
		<KumoDropdownMenu.LinkItem
			ref={ref}
			className={cn(COARSE_MENU_ITEM, className)}
			{...props}
		/>
	);
});

export {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuLinkItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
};
