import type { OsOutputKind } from "@tedix/api-contract/schemas/os-workspaces";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

function outputWorkshopKindLabel(kind: OsOutputKind | null | undefined) {
	if (kind === "document") return "Document";
	if (kind === "sheet") return "Sheet";
	if (kind === "presentation") return "Slides";
	if (kind === "video") return "Video";
	return "Workpiece";
}

function OutputWorkshopCommandBar({
	className,
	...props
}: ComponentProps<"header">) {
	return (
		<header
			data-slot="output-workshop-command-bar"
			className={cn("output-workshop-command-bar", className)}
			{...props}
		/>
	);
}

function OutputWorkshopIdentity({
	className,
	...props
}: ComponentProps<"div">) {
	return (
		<div
			data-slot="output-workshop-identity"
			className={cn("output-workshop-identity", className)}
			{...props}
		/>
	);
}

function OutputWorkshopStatus({ className, ...props }: ComponentProps<"div">) {
	return (
		<div
			data-slot="output-workshop-status"
			className={cn("output-workshop-status", className)}
			{...props}
		/>
	);
}

function OutputWorkshopActions({ className, ...props }: ComponentProps<"div">) {
	return (
		<div
			data-slot="output-workshop-actions"
			className={cn("output-workshop-actions", className)}
			{...props}
		/>
	);
}

function OutputWorkshopStage({ className, ...props }: ComponentProps<"div">) {
	return (
		<div
			data-slot="output-workshop-stage"
			className={cn("output-workshop-stage", className)}
			{...props}
		/>
	);
}

function OutputWorkshopFooter({
	className,
	...props
}: ComponentProps<"footer">) {
	return (
		<footer
			data-slot="output-workshop-footer"
			className={cn("output-workshop-footer", className)}
			{...props}
		/>
	);
}

export {
	OutputWorkshopActions,
	OutputWorkshopCommandBar,
	OutputWorkshopFooter,
	OutputWorkshopIdentity,
	outputWorkshopKindLabel,
	OutputWorkshopStage,
	OutputWorkshopStatus,
};
