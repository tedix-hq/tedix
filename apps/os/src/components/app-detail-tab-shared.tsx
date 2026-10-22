import type { ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/kumo/empty";
import {
	PageActions,
	PageSection,
	SectionDescription,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";
import {
	Table,
	TableBody,
	TableHeader,
	TableRow,
} from "@/components/kumo/table";
import { Skeleton } from "@/components/kumo/skeleton";
import { useOsFormattingPreferences } from "@/lib/format";
import { absoluteTime, relativeTime } from "@/lib/time";

export function AppTabHeader({
	id,
	title,
	description,
	actions,
}: {
	id?: string;
	title: ReactNode;
	description?: ReactNode;
	actions?: ReactNode;
}) {
	return (
		<SectionHeader>
			<SectionHeading>
				<SectionTitle id={id}>{title}</SectionTitle>
				{description && <SectionDescription>{description}</SectionDescription>}
			</SectionHeading>
			{actions && <PageActions>{actions}</PageActions>}
		</SectionHeader>
	);
}

export function AppTabSection({
	title,
	children,
}: {
	title: string;
	children: ReactNode;
}) {
	return (
		<PageSection>
			<AppTabHeader title={title} />
			{children}
		</PageSection>
	);
}

export function AppTabLoading({ label }: { label: string }) {
	return (
		<div
			aria-busy="true"
			aria-label={label}
			role="status"
			className="grid gap-4"
		>
			<Skeleton className="h-24 w-full" />
			<Skeleton className="h-24 w-full" />
			<Skeleton className="h-24 w-full" />
		</div>
	);
}

export function AppTabEmpty({
	title,
	description,
	icon,
	children,
}: {
	title: string;
	description: string;
	icon: ReactNode;
	children?: ReactNode;
}) {
	return (
		<Empty appearance="quiet">
			<EmptyHeader>
				<EmptyMedia variant="icon">{icon}</EmptyMedia>
				<EmptyTitle>{title}</EmptyTitle>
				<EmptyDescription>{description}</EmptyDescription>
			</EmptyHeader>
			{children && <EmptyContent>{children}</EmptyContent>}
		</Empty>
	);
}

type ReadQuery = { isFetching: boolean; refetch: () => Promise<unknown> };

export function AppTabReadRetry({ query }: { query: ReadQuery }) {
	return (
		<Button
			variant="outline"
			size="sm"
			className="mt-2 w-fit"
			disabled={query.isFetching}
			onClick={() => void query.refetch()}
		>
			{query.isFetching ? "Trying again…" : "Try again"}
		</Button>
	);
}

export function AppTabError({
	title,
	children,
	query,
}: {
	title: string;
	children: ReactNode;
	query: ReadQuery;
}) {
	return (
		<Alert variant="destructive">
			<AlertTitle>{title}</AlertTitle>
			<AlertDescription>
				<span>{children}</span>
				<AppTabReadRetry query={query} />
			</AlertDescription>
		</Alert>
	);
}

export function AppTabDate({ value }: { value: string }) {
	useOsFormattingPreferences();
	return (
		<time dateTime={value} title={absoluteTime(value)}>
			{relativeTime(value)}
		</time>
	);
}

export function AppTabTable({
	label,
	headings,
	className,
	children,
}: {
	label: string;
	headings: ReactNode;
	className?: string;
	children: ReactNode;
}) {
	return (
		<Table scrollLabel={label} aria-label={label} className={className}>
			<TableHeader>
				<TableRow>{headings}</TableRow>
			</TableHeader>
			<TableBody>{children}</TableBody>
		</Table>
	);
}
