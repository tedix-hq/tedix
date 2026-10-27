import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useId,
	useMemo,
	useState,
	type ReactNode,
} from "react";
import { LoadError } from "@/components/kumo/alert";

type Failure = {
	error: unknown;
	retrying: boolean;
	retry: (options?: { cancelRefetch?: boolean }) => unknown;
};
const WorkReadContext = createContext<{
	failures: Map<string, Failure>;
	report: (id: string, failure?: Failure) => void;
} | null>(null);

export function WorkReadRegion({ children }: { children: ReactNode }) {
	const [failures, setFailures] = useState(new Map<string, Failure>());
	const report = useCallback((id: string, failure?: Failure) => {
		setFailures((previous) => {
			if (!failure && !previous.has(id)) return previous;
			const next = new Map(previous);
			if (failure) next.set(id, failure);
			else next.delete(id);
			return next;
		});
	}, []);
	const value = useMemo(() => ({ failures, report }), [failures, report]);
	return (
		<WorkReadContext.Provider value={value}>
			{children}
		</WorkReadContext.Provider>
	);
}

/** A child reports to its region, so list and detail failures share one notice. */
export function useWorkReadFailure(failure?: Failure) {
	const region = useContext(WorkReadContext);
	const report = region?.report;
	const id = useId();
	const error = failure?.error;
	const retrying = failure?.retrying;
	const retry = failure?.retry;
	useEffect(() => {
		report?.(
			id,
			retry ? { error, retrying: Boolean(retrying), retry } : undefined,
		);
		return () => report?.(id);
	}, [report, id, error, retrying, retry]);
	return Boolean(region);
}

export function supportReference(error: unknown): string | undefined {
	const data = error as {
		data?: { traceId?: unknown };
		traceId?: unknown;
	} | null;
	const value = data?.data?.traceId ?? data?.traceId;
	return typeof value === "string" && /^[a-f0-9-]{16,36}$/i.test(value)
		? value
		: undefined;
}

export function WorkReadReporter({
	query,
}: {
	query: {
		isError: boolean;
		failureCount: number;
		error: unknown;
		failureReason: unknown;
		isFetching: boolean;
		refetch: () => unknown;
	};
}) {
	useWorkReadFailure(
		query.isError || query.failureCount > 0
			? {
					error: query.error ?? query.failureReason,
					retrying: query.isFetching,
					retry: query.refetch,
				}
			: undefined,
	);
	return null;
}

export function WorkReadNotice({
	failed = false,
	partial,
	retry,
	errors = [],
	retrying = false,
}: {
	failed?: boolean;
	partial: boolean;
	retry: () => unknown;
	errors?: unknown[];
	retrying?: boolean;
}) {
	const region = useContext(WorkReadContext);
	const children = [...(region?.failures.values() ?? [])];
	if (!failed && children.length === 0) return null;
	const busy = retrying || children.some((failure) => failure.retrying);
	const references = [
		...new Set(
			[...errors, ...children.map((failure) => failure.error)]
				.map(supportReference)
				.filter(Boolean),
		),
	];
	return (
		<LoadError
			className="fd-source-error"
			role={partial ? "status" : "alert"}
			title={
				partial ? "Some items couldn't load" : "Tedix couldn't load this view"
			}
			help={
				partial
					? "Showing the items that loaded. Try again in a moment."
					: "Try again in a moment."
			}
			details={
				references.length > 0
					? references.map((reference) => (
							<p key={reference}>Support reference: {reference}</p>
						))
					: undefined
			}
			retrying={busy}
			onRetry={() => {
				void retry();
				for (const failure of children)
					void failure.retry({ cancelRefetch: false });
			}}
		/>
	);
}
