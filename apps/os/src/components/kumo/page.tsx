import { ArrowLeft } from "@phosphor-icons/react";
import type { ComponentProps, ReactNode } from "react";

import { Button } from "@/components/kumo/button";
import { Surface } from "@/components/kumo/surface";
import { cn } from "@/lib/utils";

type PageWidth = "md" | "lg" | "xl" | "full" | "bleed";

const pageWidths: Record<PageWidth, string> = {
	md: "max-w-4xl",
	lg: "max-w-5xl",
	xl: "max-w-6xl",
	full: "max-w-7xl",
	bleed: "max-w-none",
};

function Page({
	className,
	width = "md",
	fullHeight = false,
	...props
}: ComponentProps<"section"> & {
	width?: PageWidth;
	fullHeight?: boolean;
}) {
	return (
		<section
			data-slot="page"
			data-full-height={fullHeight || undefined}
			className={cn(
				"mx-auto flex w-full min-w-0 flex-1 flex-col gap-5 px-4 py-5 sm:px-6 sm:py-6 lg:px-10",
				fullHeight
					? "min-h-0 overflow-hidden"
					: "overflow-y-auto [&>*]:shrink-0",
				pageWidths[width],
				className,
			)}
			{...props}
		/>
	);
}

function PageHeader({
	className,
	divided = false,
	...props
}: ComponentProps<"header"> & { divided?: boolean }) {
	return (
		<header
			data-slot="page-header"
			data-divided={divided || undefined}
			className={cn(
				"flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between",
				divided && "border-kumo-line border-b pb-5",
				"[&_.eyebrow]:!hidden",
				className,
			)}
			{...props}
		/>
	);
}

function PageHeading({ className, ...props }: ComponentProps<"div">) {
	return (
		<div
			data-slot="page-heading"
			className={cn("min-w-0 space-y-1.5", className)}
			{...props}
		/>
	);
}

function PageTitle({ className, ...props }: ComponentProps<"h1">) {
	return (
		<h1
			data-slot="page-title"
			className={cn(
				"text-balance font-semibold text-kumo-strong leading-tight type-tedix-title",
				className,
			)}
			{...props}
		/>
	);
}

function PageDescription({ className, ...props }: ComponentProps<"p">) {
	return (
		<p
			data-slot="page-description"
			className={cn(
				"max-w-3xl text-pretty text-kumo-subtle type-tedix-body",
				className,
			)}
			{...props}
		/>
	);
}

function PageActions({ className, ...props }: ComponentProps<"div">) {
	return (
		<div
			data-slot="page-actions"
			className={cn(
				"flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto sm:shrink-0 sm:justify-end",
				"[&>[data-slot=button]:not([data-icon-only])]:max-sm:flex-1",
				className,
			)}
			{...props}
		/>
	);
}

function PageBack({
	className,
	children,
	...props
}: Omit<ComponentProps<typeof Button>, "size" | "variant" | "icon">) {
	return (
		<Button
			data-page-back=""
			size="sm"
			variant="ghost"
			icon={<ArrowLeft size={15} />}
			className={cn("w-fit text-kumo-subtle", className)}
			{...props}
		>
			{children}
		</Button>
	);
}

function PageMeta({ className, ...props }: ComponentProps<"ul">) {
	return (
		<ul
			data-slot="page-meta"
			className={cn(
				"m-0 mt-2 flex list-none flex-wrap items-center gap-x-4 gap-y-1.5 p-0 text-kumo-subtle type-tedix-label tabular-nums [&_strong]:font-medium [&_strong]:text-kumo-default",
				className,
			)}
			{...props}
		/>
	);
}

function PageToolbar({
	appearance = "bounded",
	className,
	...props
}: ComponentProps<"div"> & { appearance?: "bounded" | "inline" }) {
	const classes = cn(
		"flex min-w-0 flex-col gap-3 lg:flex-row lg:flex-nowrap lg:items-center lg:justify-between",
		"[&>*]:min-w-0 [&>*]:max-w-full",
		appearance === "bounded" && "p-2",
		className,
	);

	if (appearance === "inline") {
		return (
			<div
				data-slot="page-toolbar"
				data-appearance="inline"
				className={classes}
				{...props}
			/>
		);
	}

	return (
		<Surface
			as="div"
			tier="well"
			data-slot="page-toolbar"
			data-appearance="bounded"
			className={classes}
			{...props}
		/>
	);
}

function PageGrid({ className, ...props }: ComponentProps<"div">) {
	return (
		<div
			data-slot="page-grid"
			className={cn(
				"grid min-w-0 grid-cols-1 gap-3 sm:gap-4 lg:grid-cols-2",
				className,
			)}
			{...props}
		/>
	);
}

function PageSection({ className, ...props }: ComponentProps<"section">) {
	return (
		<section
			data-slot="page-section"
			className={cn("min-w-0 space-y-3", className)}
			{...props}
		/>
	);
}

function SectionHeader({ className, ...props }: ComponentProps<"header">) {
	return (
		<header
			data-slot="section-header"
			className={cn(
				"flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between",
				className,
			)}
			{...props}
		/>
	);
}

function SectionHeading({ className, ...props }: ComponentProps<"div">) {
	return (
		<div
			data-slot="section-heading"
			className={cn("min-w-0 space-y-0.5", className)}
			{...props}
		/>
	);
}

function SectionTitle({ className, ...props }: ComponentProps<"h2">) {
	return (
		<h2
			data-slot="section-title"
			className={cn(
				"font-semibold text-kumo-strong type-tedix-section",
				className,
			)}
			{...props}
		/>
	);
}

function SectionDescription({ className, ...props }: ComponentProps<"p">) {
	return (
		<p
			data-slot="section-description"
			className={cn("text-kumo-subtle type-tedix-body", className)}
			{...props}
		/>
	);
}

function SectionActions({ className, ...props }: ComponentProps<"div">) {
	return (
		<div
			data-slot="section-actions"
			className={cn("flex min-w-0 flex-wrap items-center gap-2", className)}
			{...props}
		/>
	);
}

function Collection({
	appearance = "bounded",
	className,
	...props
}: ComponentProps<"ul"> & { appearance?: "bounded" | "inline" }) {
	return (
		<ul
			data-slot="collection"
			data-appearance={appearance}
			className={cn(
				"m-0 grid list-none divide-y divide-kumo-hairline p-0 [&>li]:min-w-0",
				appearance === "bounded" &&
					"overflow-hidden rounded-lg border border-kumo-line",
				className,
			)}
			{...props}
		/>
	);
}

function SectionCollection({
	title,
	description,
	empty,
	children,
	footer,
	className,
}: {
	title: string;
	description: string;
	empty: string;
	children?: ReactNode;
	footer?: ReactNode;
	className?: string;
}) {
	return (
		<PageSection className={className}>
			<SectionHeader>
				<SectionHeading>
					<SectionTitle>{title}</SectionTitle>
					<SectionDescription>{description}</SectionDescription>
				</SectionHeading>
			</SectionHeader>
			{children ? (
				<Collection
					aria-label={title}
					data-slot="section-collection"
					className="[&>li]:px-3 [&>li]:py-2.5"
				>
					{children}
				</Collection>
			) : (
				<p className="m-0 border-kumo-hairline border-t py-3 text-kumo-subtle type-tedix-body">
					{empty}
				</p>
			)}
			{footer}
		</PageSection>
	);
}

function SettingsSection({ className, ...props }: ComponentProps<"section">) {
	return (
		<section
			data-slot="settings-section"
			className={cn(
				"min-w-0 space-y-4 border-kumo-line border-b pb-6 last:border-b-0 last:pb-1",
				className,
			)}
			{...props}
		/>
	);
}

function SettingsSectionContent({
	className,
	...props
}: ComponentProps<"div">) {
	return (
		<div
			data-slot="settings-section-content"
			className={cn("min-w-0", className)}
			{...props}
		/>
	);
}

export {
	Collection,
	Page,
	PageActions,
	PageBack,
	PageDescription,
	PageGrid,
	PageHeader,
	PageHeading,
	PageMeta,
	PageSection,
	PageToolbar,
	PageTitle,
	SectionActions,
	SectionCollection,
	SectionDescription,
	SectionHeader,
	SectionHeading,
	SectionTitle,
	SettingsSection,
	SettingsSectionContent,
};
