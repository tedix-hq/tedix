"use client";

import { Dialog as KumoDialog } from "@cloudflare/kumo/components/dialog";
import { XIcon } from "@phosphor-icons/react";
import type * as React from "react";

import { cn } from "@/lib/utils";
import { Button } from "./button";
import { useOverlayPortalContainer } from "./layer-portal";

function Dialog(props: React.ComponentProps<typeof KumoDialog.Root>) {
	return <KumoDialog.Root {...props} />;
}

function DialogTrigger({
	children,
	render,
	...props
}: React.ComponentProps<typeof KumoDialog.Trigger>) {
	return (
		<KumoDialog.Trigger render={render ?? <Button />} {...props}>
			{children}
		</KumoDialog.Trigger>
	);
}

/*
 * The enter/exit belongs to Kumo: its popup sets `transitionProperty: "scale,
 * opacity"` as an INLINE style and pairs it with a `duration-150` class. That
 * is why the reduced-motion hook here is `duration-0` and not
 * `transition-none` — a class can never beat the inline `transition-property`,
 * so the old `motion-reduce:transition-none` was inert. The duration is
 * class-owned, so overriding it under `motion-reduce` actually lands, and Base
 * UI's transition-gated unmount then completes immediately.
 *
 * `os-dialog-sheet` is a default, not an opt-in: on phones and short windows it
 * re-anchors the popup to the keyboard-safe bottom edge with the Sheet's
 * `side="bottom"` geometry (styles.css). Every dialog in the product goes through
 * this one adapter, so the responsive shape belongs here rather than in a class
 * each call site has to remember. The height cap tracks the visual viewport for
 * the same reason: `100dvh` never shrinks for a software keyboard.
 */
function DialogContent({
	className,
	children,
	showCloseButton = true,
	container,
	...props
}: Omit<React.ComponentProps<typeof KumoDialog>, "children"> & {
	children?: React.ReactNode;
	showCloseButton?: boolean;
}) {
	const overlayPortalContainer = useOverlayPortalContainer(container == null);

	return (
		<KumoDialog
			container={container ?? overlayPortalContainer}
			className={cn(
				"os-dialog-sheet grid max-h-[calc(var(--viewport-tedix-height)_-_2rem)] w-[calc(100vw-2rem)] gap-4 overflow-y-auto p-4 shadow-tedix-overlay motion-reduce:duration-0 sm:p-5",
				className,
			)}
			{...props}
		>
			{children}
			{showCloseButton && (
				<KumoDialog.Close
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
				</KumoDialog.Close>
			)}
		</KumoDialog>
	);
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="dialog-header"
			className={cn("flex flex-col gap-1.5 pr-8", className)}
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
				className,
			)}
			{...props}
		>
			{children}
			{showCloseButton && (
				<KumoDialog.Close render={<Button variant="outline" />}>
					Close
				</KumoDialog.Close>
			)}
		</div>
	);
}

function DialogTitle({
	className,
	...props
}: React.ComponentProps<typeof KumoDialog.Title>) {
	return (
		<KumoDialog.Title
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
}: React.ComponentProps<typeof KumoDialog.Description>) {
	return (
		<KumoDialog.Description
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
	DialogTitle,
	DialogTrigger,
};
