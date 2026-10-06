"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { cva, type VariantProps } from "class-variance-authority";
import { XIcon } from "lucide-react";
import type * as React from "react";
import { cn } from "../lib/utils";
import { Button } from "./button";

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
	return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
	return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
	return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
	return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
	className,
	...props
}: DialogPrimitive.Backdrop.Props) {
	return (
		<DialogPrimitive.Backdrop
			data-slot="dialog-overlay"
			className={cn(
				"data-closed:fade-out-0 data-open:fade-in-0 fixed inset-0 isolate z-[120] bg-black/80 duration-100 data-closed:animate-out data-open:animate-in supports-backdrop-filter:backdrop-blur-xs",
				className,
			)}
			{...props}
		/>
	);
}

const dialogContentVariants = cva(
	"data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 fixed top-1/2 left-1/2 z-[120] grid max-h-[90vh] w-full -translate-x-1/2 -translate-y-1/2 gap-6 overflow-auto rounded-4xl bg-background p-6 text-sm outline-none ring-1 ring-foreground/5 duration-100 data-closed:animate-out data-open:animate-in",
	{
		variants: {
			size: {
				sm: "max-w-[calc(100%-2rem)] sm:max-w-sm",
				default: "max-w-[calc(100%-2rem)] sm:max-w-md",
				lg: "max-w-[calc(100%-2rem)] sm:max-w-lg md:max-w-2xl",
				xl: "max-w-[calc(100%-2rem)] sm:max-w-xl md:max-w-3xl lg:max-w-5xl",
				full: "max-w-[calc(100%-2rem)] sm:max-w-[calc(100%-4rem)] md:max-w-[calc(100%-6rem)]",
			},
		},
		defaultVariants: {
			size: "default",
		},
	},
);

export interface DialogContentProps
	extends
		DialogPrimitive.Popup.Props,
		VariantProps<typeof dialogContentVariants> {
	showClose?: boolean;
	/** Render as bottom sheet on mobile screens */
	mobileBottomSheet?: boolean;
	/** Enable swipe to dismiss on mobile */
	swipeToDismiss?: boolean;
}

function DialogContent({
	className,
	children,
	size = "default",
	showClose = true,
	mobileBottomSheet = false,
	swipeToDismiss = false,
	...props
}: DialogContentProps) {
	return (
		<DialogPortal>
			<DialogOverlay />
			<DialogPrimitive.Popup
				data-slot="dialog-content"
				className={cn(
					dialogContentVariants({ size }),
					mobileBottomSheet && [
						// Mobile: bottom sheet styling
						"max-sm:top-auto max-sm:right-0 max-sm:bottom-0 max-sm:left-0",
						"max-sm:translate-x-0 max-sm:translate-y-0",
						"max-sm:rounded-t-3xl max-sm:rounded-b-none",
						"max-sm:w-full max-sm:max-w-full",
						"max-sm:data-[state=open]:slide-in-from-bottom",
						"max-sm:data-[state=closed]:slide-out-to-bottom",
					],
					className,
				)}
				{...props}
			>
				{mobileBottomSheet && (
					<div className="mx-auto mt-2 h-1.5 w-12 rounded-full bg-muted-foreground/30 sm:hidden" />
				)}
				{children}
				{showClose && (
					<DialogPrimitive.Close
						data-slot="dialog-close-button"
						render={
							<Button
								variant="ghost"
								className="absolute top-4 right-4"
								size="icon-sm"
							/>
						}
					>
						<XIcon />
						<span className="sr-only">Close</span>
					</DialogPrimitive.Close>
				)}
			</DialogPrimitive.Popup>
		</DialogPortal>
	);
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="dialog-header"
			className={cn("flex flex-col gap-2", className)}
			{...props}
		/>
	);
}

function DialogFooter({
	className,
	showClose = false,
	children,
	...props
}: React.ComponentProps<"div"> & {
	showClose?: boolean;
}) {
	return (
		<div
			data-slot="dialog-footer"
			className={cn(
				"flex flex-col-reverse gap-2 gap-2 sm:flex-row sm:justify-end",
				className,
			)}
			{...props}
		>
			{children}
			{showClose && (
				<DialogPrimitive.Close render={<Button variant="outline" />}>
					Close
				</DialogPrimitive.Close>
			)}
		</div>
	);
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
	return (
		<DialogPrimitive.Title
			data-slot="dialog-title"
			className={cn("font-medium text-base leading-none", className)}
			{...props}
		/>
	);
}

function DialogDescription({
	className,
	...props
}: DialogPrimitive.Description.Props) {
	return (
		<DialogPrimitive.Description
			data-slot="dialog-description"
			className={cn(
				"text-muted-foreground text-sm *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
				className,
			)}
			{...props}
		/>
	);
}

export {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogOverlay,
	DialogPortal,
	DialogTitle,
	DialogTrigger,
	dialogContentVariants,
};
