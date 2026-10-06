"use client";

import { Dialog as KumoDialog } from "@cloudflare/kumo/components/dialog";
import { AlertDialog as AlertDialogPrimitive } from "@cloudflare/kumo/primitives/alert-dialog";
import type * as React from "react";

import { cn } from "@/lib/utils";
import { Button } from "./button";

function AlertDialog(props: AlertDialogPrimitive.Root.Props) {
	return <KumoDialog.Root role="alertdialog" {...props} />;
}

function AlertDialogTrigger({
	children,
	render,
	...props
}: AlertDialogPrimitive.Trigger.Props) {
	return (
		<KumoDialog.Trigger render={render ?? <Button />} {...props}>
			{children}
		</KumoDialog.Trigger>
	);
}

// Kumo owns the scale/opacity enter-exit and applies its transition-property
// inline, so the reduced-motion hook has to be the class-owned duration. See
// the longer note in `dialog.tsx`.
function AlertDialogContent({
	className,
	size = "default",
	...props
}: Omit<React.ComponentProps<typeof KumoDialog>, "size"> & {
	size?: "default" | "sm";
}) {
	return (
		<KumoDialog
			size={size === "sm" ? "sm" : "base"}
			className={cn(
				"group/alert-dialog-content grid max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] gap-6 overflow-y-auto p-4 shadow-tedix-overlay motion-reduce:duration-0 sm:p-6",
				className,
			)}
			{...props}
		/>
	);
}

function AlertDialogHeader({
	className,
	...props
}: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="alert-dialog-header"
			className={cn(
				"grid place-items-center gap-1.5 text-center sm:place-items-start sm:text-left",
				className,
			)}
			{...props}
		/>
	);
}

function AlertDialogFooter({
	className,
	...props
}: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="alert-dialog-footer"
			className={cn(
				"flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
				className,
			)}
			{...props}
		/>
	);
}

function AlertDialogTitle({
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

function AlertDialogDescription({
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

function AlertDialogAction({
	className,
	variant = "default",
	size = "default",
	...props
}: React.ComponentProps<typeof KumoDialog.Close> &
	Pick<React.ComponentProps<typeof Button>, "variant"> & {
		size?: "default" | "xs" | "sm" | "lg";
	}) {
	return (
		<KumoDialog.Close
			className={className}
			render={<Button variant={variant} size={size} />}
			{...props}
		/>
	);
}

function AlertDialogCancel({
	className,
	variant = "outline",
	size = "default",
	...props
}: AlertDialogPrimitive.Close.Props &
	Pick<React.ComponentProps<typeof Button>, "variant"> & {
		size?: "default" | "xs" | "sm" | "lg";
	}) {
	return (
		<KumoDialog.Close
			className={className}
			render={<Button variant={variant} size={size} />}
			{...props}
		/>
	);
}

export {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
};
