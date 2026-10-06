import { createElement, type ComponentPropsWithoutRef } from "react";

import { cn } from "../../lib/utils";

type EvidenceRowProps = ComponentPropsWithoutRef<"div"> & {
	as?: "div" | "li";
};

function EvidenceRow({ as = "div", className, ...props }: EvidenceRowProps) {
	return createElement(as, {
		...props,
		"data-slot": "evidence-row",
		className: cn(
			"grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3",
			className,
		),
	});
}

function EvidenceRowSignal({
	className,
	...props
}: ComponentPropsWithoutRef<"div">) {
	return (
		<div
			data-slot="evidence-row-signal"
			className={cn("shrink-0", className)}
			{...props}
		/>
	);
}

function EvidenceRowContent({
	className,
	...props
}: ComponentPropsWithoutRef<"div">) {
	return (
		<div
			data-slot="evidence-row-content"
			className={cn("min-w-0", className)}
			{...props}
		/>
	);
}

function EvidenceRowStatus({
	className,
	...props
}: ComponentPropsWithoutRef<"div">) {
	return (
		<div
			data-slot="evidence-row-status"
			className={cn("min-w-0", className)}
			{...props}
		/>
	);
}

function EvidenceRowDetail({
	className,
	...props
}: ComponentPropsWithoutRef<"div">) {
	return (
		<div
			data-slot="evidence-row-detail"
			className={cn("col-span-2 col-start-2 min-w-0", className)}
			{...props}
		/>
	);
}

export {
	EvidenceRow,
	EvidenceRowContent,
	EvidenceRowDetail,
	EvidenceRowSignal,
	EvidenceRowStatus,
};
