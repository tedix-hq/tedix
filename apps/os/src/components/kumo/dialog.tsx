"use client";

import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import {
	LayerDialog,
	type LayerDialogRootProps,
} from "@cloudflare/kumo/components/layer-dialog";
import { Drawer } from "@cloudflare/kumo/primitives/drawer";
import { XIcon } from "@phosphor-icons/react";
import type * as React from "react";
import { useSyncExternalStore } from "react";

import { cn } from "@/lib/utils";
import { Button } from "./button";

/*
 * Every Tedix dialog runs on Kumo's LayerDialog: `LayerDialog.Root` /
 * `LayerDialog.Alert` own the open state, focus trap, Escape, initial and
 * final focus, scroll lock, pointer-dismissal rules and nesting (Base UI
 * Drawer). On phones (< 640px, Kumo's breakpoint) the popup is a bottom drawer
 * with a grab handle and swipe-to-dismiss; on desktop it is a centred card.
 *
 * `LayerDialog.Content` itself is strict-slot (exactly one direct Title and
 * Body, one Action). The product's dialogs are free-form — forms wrap their
 * footers, confirm footers carry several controls — so the surface below
 * composes the same Kumo drawer parts and LayerCard shell with LayerDialog's
 * geometry, and keeps the slot-free adapter API callers already use.
 *
 * Backdrop and viewport share the overlay rung of the stacking ladder, so a
 * dialog opened from a Sheet (the same rung, earlier in the DOM) sits above it.
 */

const DESKTOP_QUERY = "(min-width: 640px)";

function subscribeDesktop(notify: () => void) {
	const query = window.matchMedia?.(DESKTOP_QUERY);
	query?.addEventListener("change", notify);
	return () => query?.removeEventListener("change", notify);
}

function useIsDesktop() {
	return useSyncExternalStore(
		subscribeDesktop,
		() => window.matchMedia?.(DESKTOP_QUERY).matches ?? true,
		() => true,
	);
}

type DialogSize = "sm" | "base" | "lg" | "xl";

const dialogSizeClasses: Record<DialogSize, string> = {
	sm: "sm:max-w-md",
	base: "sm:max-w-xl",
	lg: "sm:max-w-2xl",
	xl: "sm:max-w-3xl",
};

type DialogSurfaceProps = Omit<
	React.ComponentProps<typeof Drawer.Popup>,
	"children" | "className" | "render"
> & {
	children?: React.ReactNode;
	className?: string;
	container?: React.ComponentProps<typeof Drawer.Portal>["container"];
	size?: DialogSize;
	alert?: boolean;
	closeButton?: boolean;
};

function DialogSurface({
	alert = false,
	children,
	className,
	closeButton = false,
	container,
	size = "base",
	...props
}: DialogSurfaceProps) {
	const isDesktop = useIsDesktop();
	return (
		<Drawer.Portal container={container}>
			<Drawer.Backdrop
				forceRender
				data-slot="dialog-backdrop"
				className="fixed inset-0 z-(--tedix-layer-overlay) bg-kumo-recessed opacity-80 transition-opacity duration-[450ms] ease-[cubic-bezier(0.32,0.72,0,1)] data-[ending-style]:opacity-0 data-[ending-style]:duration-[calc(var(--drawer-swipe-strength)*400ms)] data-[starting-style]:opacity-0 data-[swiping]:duration-0 motion-reduce:transition-none sm:duration-200 sm:data-[ending-style]:duration-200"
			/>
			<Drawer.Viewport
				data-base-ui-swipe-ignore={isDesktop || alert ? "" : undefined}
				className="fixed inset-0 z-(--tedix-layer-overlay) flex items-end justify-center sm:items-center sm:px-4 sm:py-6"
			>
				<Drawer.Popup
					data-slot="dialog-popup"
					render={alert ? <div role="alertdialog" /> : <div />}
					className={cn(
						// Phone: a bottom drawer above the software keyboard and home indicator.
						"fixed inset-x-0 bottom-(--viewport-tedix-bottom) flex max-h-[min(85dvh,calc(var(--viewport-tedix-height)-1rem))] min-h-0 w-full max-w-none transform-gpu outline-none will-change-transform",
						"[transform:translate3d(0,var(--drawer-swipe-movement-y,0px),0)] transition-[transform,opacity] duration-[450ms] ease-[cubic-bezier(0.32,0.72,0,1)] data-[ending-style]:[transform:translate3d(0,100%,0)] data-[ending-style]:duration-[calc(var(--drawer-swipe-strength)*400ms)] data-[starting-style]:[transform:translate3d(0,100%,0)] data-[swiping]:duration-0 data-[swiping]:select-none motion-reduce:transition-none",
						// Desktop: a centred card that fades and lifts in.
						"sm:static sm:max-h-[min(90dvh,calc(var(--viewport-tedix-height)-3rem))] sm:[transform:translate3d(0,0,0)] sm:duration-200 sm:data-[ending-style]:[transform:translate3d(0,8px,0)] sm:data-[ending-style]:opacity-0 sm:data-[ending-style]:duration-200 sm:data-[starting-style]:[transform:translate3d(0,8px,0)] sm:data-[starting-style]:opacity-0",
						dialogSizeClasses[size],
						className,
					)}
					{...props}
				>
					<LayerCard className="flex min-h-0 w-full flex-col overflow-hidden rounded-none rounded-t-xl bg-kumo-elevated p-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))] shadow-tedix-overlay max-sm:border-t max-sm:border-kumo-hairline sm:rounded-xl sm:pb-1.5">
						{!isDesktop && !alert && (
							<div aria-hidden className="flex justify-center pt-1.5 pb-3">
								<div className="h-1 w-10 rounded-full bg-kumo-fill" />
							</div>
						)}
						<LayerCard.Primary className="min-h-0 flex-1 gap-0 p-0">
							<Drawer.Content
								data-slot="dialog-body"
								className="grid min-h-0 flex-1 gap-4 overflow-y-auto overscroll-contain p-4 [scrollbar-gutter:stable] [scroll-padding-block:8rem] sm:p-5"
							>
								{children}
							</Drawer.Content>
							{closeButton && (
								<Drawer.Close
									render={
										<Button
											aria-label="Close"
											className="absolute top-3 right-3 z-20 sm:top-4 sm:right-4"
											size="icon-sm"
											variant="ghost"
										/>
									}
								>
									<XIcon aria-hidden className="size-4" />
								</Drawer.Close>
							)}
						</LayerCard.Primary>
					</LayerCard>
				</Drawer.Popup>
			</Drawer.Viewport>
		</Drawer.Portal>
	);
}

function Dialog(props: LayerDialogRootProps) {
	return <LayerDialog.Root {...props} />;
}

function DialogTrigger({
	children,
	render,
	...props
}: React.ComponentProps<typeof LayerDialog.Trigger>) {
	return (
		<LayerDialog.Trigger render={render ?? <Button />} {...props}>
			{children}
		</LayerDialog.Trigger>
	);
}

function DialogContent({
	showCloseButton = true,
	...props
}: Omit<DialogSurfaceProps, "alert" | "closeButton"> & {
	showCloseButton?: boolean;
}) {
	return <DialogSurface closeButton={showCloseButton} {...props} />;
}

/* Header and footer stay pinned while the body scrolls (phones and long forms). */
const stickyHeaderClasses =
	"sticky -top-4 z-10 -mx-4 -mt-4 bg-kumo-base p-4 pr-12 sm:-top-5 sm:-mx-5 sm:-mt-5 sm:p-5 sm:pr-14";
const stickyFooterClasses =
	"sticky -bottom-4 z-10 -mx-4 -mb-4 border-t border-kumo-hairline bg-kumo-base p-4 sm:-bottom-5 sm:-mx-5 sm:-mb-5 sm:px-5";

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="dialog-header"
			className={cn("flex flex-col gap-1.5", stickyHeaderClasses, className)}
			{...props}
		/>
	);
}

function DialogFooter({
	className,
	showCloseButton = false,
	children,
	...props
}: React.ComponentProps<"div"> & { showCloseButton?: boolean }) {
	return (
		<div
			data-slot="dialog-footer"
			className={cn(
				"flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
				stickyFooterClasses,
				className,
			)}
			{...props}
		>
			{children}
			{showCloseButton && (
				<Drawer.Close render={<Button variant="outline" />}>Close</Drawer.Close>
			)}
		</div>
	);
}

function DialogTitle({
	className,
	...props
}: React.ComponentProps<typeof Drawer.Title>) {
	return (
		<Drawer.Title
			className={cn(
				"font-semibold text-kumo-strong type-tedix-dialog",
				className,
			)}
			{...props}
		/>
	);
}

function DialogDescription({
	className,
	...props
}: React.ComponentProps<typeof Drawer.Description>) {
	return (
		<Drawer.Description
			className={cn("text-kumo-subtle type-tedix-body", className)}
			{...props}
		/>
	);
}

export {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogSurface,
	DialogTitle,
	DialogTrigger,
	stickyFooterClasses,
	stickyHeaderClasses,
};
