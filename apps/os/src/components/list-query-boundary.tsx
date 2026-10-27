import { LoadError } from "@/components/kumo/alert";

import { ListSkeleton } from "@/components/list-skeleton";

type ListQueryState = {
	isPending: boolean;
	isError: boolean;
	isFetching: boolean;
	error: unknown;
	refetch: () => Promise<unknown>;
};

export function ListQueryBoundary({
	query,
	errorTitle,
	errorDescription,
	rows,
}: {
	query: ListQueryState;
	errorTitle: string;
	errorDescription?: string;
	rows?: number;
}) {
	if (query.isPending) return <ListSkeleton rows={rows} />;
	if (!query.isError) return null;
	return (
		<LoadError
			title={errorTitle}
			retrying={query.isFetching}
			onRetry={() => void query.refetch()}
			error={query.error}
			help={errorDescription}
		/>
	);
}
