import type { ComponentProps, ReactNode } from "react";
import { LoadError } from "@/components/kumo/alert";
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
	fallback = "This could not be loaded. Try again in a moment.",
	onRetry,
	retrying,
}: {
	title: string;
	error?: unknown;
	fallback?: string;
	onRetry?: () => unknown;
	retrying?: boolean;
}) {
	return (
		<LoadError
			title={title}
			error={error}
			help={errorMessage(error, "") ? undefined : fallback}
			onRetry={onRetry}
			retrying={retrying}
		/>
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
