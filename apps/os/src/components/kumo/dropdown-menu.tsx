"use client";

import { DropdownMenu as KumoDropdownMenu } from "@cloudflare/kumo/components/dropdown";
import { Menu as MenuPrimitive } from "@cloudflare/kumo/primitives/menu";
import * as React from "react";

import { cn } from "@/lib/utils";

type DropdownMenuProps = React.ComponentProps<typeof KumoDropdownMenu>;
type DropdownMenuActions = NonNullable<
	NonNullable<DropdownMenuProps["actionsRef"]>["current"]
>;

/*
 * The popup has no exit animation, so a close finishes in the same commit.
 * Left to Base UI, the closed popup stays mounted for at least a frame. If
 * focus leaves the trigger in that window, Base UI records "don't return
 * focus"; a reopen before the unmount keeps that flag, so the next Escape
 * left focus on <body> instead of the trigger.
 */
function DropdownMenu({
	actionsRef,
	onOpenChange,
	...props
}: DropdownMenuProps) {
	const ownActions = React.useRef<DropdownMenuActions | null>(null);
	const actions = actionsRef ?? ownActions;
	return (
		<KumoDropdownMenu
			{...props}
			actionsRef={actions}
			onOpenChange={(open, details) => {
				onOpenChange?.(open, details);
				if (!open && !details.isCanceled) actions.current?.unmount();
			}}
		/>
	);
}
const DropdownMenuTrigger = KumoDropdownMenu.Trigger;
const DropdownMenuGroup = KumoDropdownMenu.Group;
const DropdownMenuLabel = KumoDropdownMenu.Label;
const DropdownMenuSeparator = KumoDropdownMenu.Separator;
// Base UI's filterable menu: wrap the root in the provider, then put the items
// in `DropdownMenuList` beside a `DropdownMenuFilterInput`. DOM focus stays in
// the input while the arrow keys move the highlight through the items.
const DropdownMenuFilterProvider = MenuPrimitive.FilterProvider;
const DropdownMenuList = MenuPrimitive.List;
const DropdownMenuEmpty = MenuPrimitive.Empty;

const DropdownMenuFilterInput = React.forwardRef<
	HTMLInputElement,
	React.ComponentPropsWithoutRef<typeof MenuPrimitive.Input>
>(function DropdownMenuFilterInput({ className, ...props }, ref) {
	return (
		<MenuPrimitive.Input
			ref={ref}
			className={cn(
				"h-8 w-full min-w-0 rounded-md bg-kumo-base px-2 type-tedix-control text-kumo-default outline-none ring ring-kumo-line placeholder:text-kumo-subtle focus-visible:ring-kumo-brand max-sm:min-h-11 coarse:min-h-11",
				className,
			)}
			{...props}
		/>
	);
});

const DropdownMenuFilterClear = React.forwardRef<
	HTMLButtonElement,
	React.ComponentPropsWithoutRef<typeof MenuPrimitive.Clear>
>(function DropdownMenuFilterClear({ className, ...props }, ref) {
	return (
		<MenuPrimitive.Clear
			ref={ref}
			className={cn(
				"grid size-5 shrink-0 place-items-center rounded text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default focus-visible:outline-2 focus-visible:outline-kumo-brand",
				className,
			)}
			{...props}
		/>
	);
});

// The 44px floor is a pointer-capability question: a touch laptop above `sm`
// still needs it, a narrow desktop window does not.
const COARSE_MENU_ITEM =
	"gap-2 type-tedix-control transition-colors motion-reduce:transition-none max-sm:min-h-11 coarse:min-h-11 [&>svg]:shrink-0";
const MENU_POPUP =
	"min-w-36 max-h-[var(--available-height)] overflow-y-auto rounded-lg bg-kumo-control p-1.5 text-kumo-default shadow-tedix-floating ring ring-kumo-line";

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
				<MenuPrimitive.Popup className={cn(MENU_POPUP, className)}>
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
	DropdownMenuEmpty,
	DropdownMenuFilterClear,
	DropdownMenuFilterInput,
	DropdownMenuFilterProvider,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuLinkItem,
	DropdownMenuList,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
};
