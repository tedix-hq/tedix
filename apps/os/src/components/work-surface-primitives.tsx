import type { ComponentProps, ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "@/components/kumo/empty";
import {
	PageActions,
	PageDescription,
	PageHeader,
	PageHeading,
	PageTitle,
} from "@/components/kumo/page";
import { Skeleton } from "@/components/kumo/skeleton";
import { errorMessage } from "@/lib/orpc-error";
import { useDocumentTitle } from "@/lib/use-document-title";

export function WorkPageHeader({
	title,
	description,
	action,
}: {
	title: string;
	description: ReactNode;
	action?: ReactNode;
}) {
	useDocumentTitle(`${title} · Work`);
	return (
		<PageHeader>
			<PageHeading>
				<PageTitle>{title}</PageTitle>
				<PageDescription>{description}</PageDescription>
			</PageHeading>
			{action ? <PageActions>{action}</PageActions> : null}
		</PageHeader>
	);
}

export function WorkListSkeleton({
	rows = 3,
	label = "Loading",
}: {
	rows?: number;
	label?: string;
}) {
	return (
		<div className="grid gap-2" aria-label={label}>
			{Array.from({ length: rows }, (_, index) => (
				<Skeleton key={index} className="h-11 w-full" />
			))}
		</div>
	);
}

export function WorkReadFailure({
	title,
	error,
	fallback = "The canonical read failed.",
}: {
	title: string;
	error?: unknown;
	fallback?: string;
}) {
	return (
		<Alert variant="destructive">
			<AlertTitle>{title}</AlertTitle>
			<AlertDescription>{errorMessage(error, fallback)}</AlertDescription>
		</Alert>
	);
}

export function WorkEmpty({
	title,
	description,
	appearance = "quiet",
}: {
	title: string;
	description: ReactNode;
	appearance?: ComponentProps<typeof Empty>["appearance"];
}) {
	return (
		<Empty appearance={appearance}>
			<EmptyHeader>
				<EmptyTitle>{title}</EmptyTitle>
				<EmptyDescription>{description}</EmptyDescription>
			</EmptyHeader>
		</Empty>
	);
}
