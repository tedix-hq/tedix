"use client";

import { DropdownMenu as KumoDropdownMenu } from "@cloudflare/kumo/components/dropdown";
import { InputGroup as KumoInputGroup } from "@cloudflare/kumo/components/input-group";
import { Menu as MenuPrimitive } from "@cloudflare/kumo/primitives/menu";
import { MagnifyingGlass, X } from "@phosphor-icons/react";
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

// `InputGroup.Addon` hands each child the icon size of the field.
function DropdownMenuFilterClear({
	label,
	size,
}: {
	label: string;
	size?: number;
}) {
	return (
		<MenuPrimitive.Clear
			render={<KumoInputGroup.Button aria-label={label} shape="square" />}
		>
			<X aria-hidden="true" size={size} />
		</MenuPrimitive.Clear>
	);
}

// The clear button exists only while there is text; its addon keeps its width
// so the field does not move when the button appears.
const DropdownMenuFilterInput = React.forwardRef<
	HTMLInputElement,
	React.ComponentPropsWithoutRef<typeof MenuPrimitive.Input> & {
		clearLabel?: string;
	}
>(function DropdownMenuFilterInput(
	{ className, clearLabel = "Clear search", ...props },
	ref,
) {
	return (
		<KumoInputGroup className="shrink-0 shadow-none max-sm:h-auto max-sm:min-h-11 coarse:h-auto coarse:min-h-11">
			<KumoInputGroup.Addon>
				<MagnifyingGlass aria-hidden="true" />
			</KumoInputGroup.Addon>
			<MenuPrimitive.Input
				ref={ref}
				render={<KumoInputGroup.Input />}
				className={cn(
					"type-tedix-control max-sm:min-h-11 coarse:min-h-11",
					className,
				)}
				{...props}
			/>
			<KumoInputGroup.Addon align="end" className="w-8 justify-center pr-1">
				<DropdownMenuFilterClear label={clearLabel} />
			</KumoInputGroup.Addon>
		</KumoInputGroup>
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

/** One choice among several; the checked row shows its indicator. */
const DropdownMenuRadioGroup = KumoDropdownMenu.RadioGroup;
const DropdownMenuRadioItemIndicator = KumoDropdownMenu.RadioItemIndicator;

function DropdownMenuRadioItem({
	className,
	...props
}: React.ComponentProps<typeof KumoDropdownMenu.RadioItem>) {
	return (
		<KumoDropdownMenu.RadioItem
			className={cn(COARSE_MENU_ITEM, className)}
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
	DropdownMenuFilterInput,
	DropdownMenuFilterProvider,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuLinkItem,
	DropdownMenuList,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuRadioItemIndicator,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
};
