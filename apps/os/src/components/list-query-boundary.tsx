import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
import { ListSkeleton } from "@/components/list-skeleton";
import { errorMessage } from "@/lib/orpc-error";

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
		<Alert variant="destructive">
			<AlertTitle>{errorTitle}</AlertTitle>
			<AlertDescription>
				<span>
					{errorDescription ??
						errorMessage(query.error, "The list could not be read.")}
				</span>
				<Button
					variant="outline"
					size="sm"
					className="mt-2 w-fit"
					disabled={query.isFetching}
					onClick={() => void query.refetch()}
				>
					{query.isFetching ? "Trying again…" : "Try again"}
				</Button>
			</AlertDescription>
		</Alert>
	);
}
