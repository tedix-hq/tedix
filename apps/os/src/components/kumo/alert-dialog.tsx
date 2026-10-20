"use client";

import {
	LayerDialog,
	type LayerDialogRootProps,
} from "@cloudflare/kumo/components/layer-dialog";
import { Drawer } from "@cloudflare/kumo/primitives/drawer";
import type * as React from "react";

import { cn } from "@/lib/utils";
import { Button } from "./button";
import {
	DialogSurface,
	stickyFooterClasses,
	stickyHeaderClasses,
} from "./dialog";

/*
 * `LayerDialog.Alert` makes the dialog modal and blocks outside-press
 * dismissal; the surface adds `role="alertdialog"` and drops the phone grab
 * handle and swipe, so a confirmation always needs an explicit choice.
 */
function AlertDialog(props: LayerDialogRootProps) {
	return <LayerDialog.Alert {...props} />;
}

function AlertDialogTrigger({
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

function AlertDialogContent({
	size = "default",
	...props
}: Omit<React.ComponentProps<typeof DialogSurface>, "alert" | "size"> & {
	size?: "default" | "sm";
}) {
	return (
		<DialogSurface alert size={size === "sm" ? "sm" : "base"} {...props} />
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
				stickyHeaderClasses,
				"pr-4 sm:pr-5",
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
				stickyFooterClasses,
				className,
			)}
			{...props}
		/>
	);
}

function AlertDialogTitle({
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

function AlertDialogDescription({
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

function AlertDialogAction({
	className,
	variant = "default",
	size = "default",
	...props
}: React.ComponentProps<typeof Drawer.Close> &
	Pick<React.ComponentProps<typeof Button>, "variant"> & {
		size?: "default" | "xs" | "sm" | "lg";
	}) {
	return (
		<Drawer.Close
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
}: React.ComponentProps<typeof Drawer.Close> &
	Pick<React.ComponentProps<typeof Button>, "variant"> & {
		size?: "default" | "xs" | "sm" | "lg";
	}) {
	return (
		<Drawer.Close
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
