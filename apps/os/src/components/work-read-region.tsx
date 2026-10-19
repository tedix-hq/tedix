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
import { Alert } from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/kumo/collapsible";

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
	const content = (
		<>
			<span>
				{partial
					? busy
						? "Some items couldn't load — retrying…"
						: "Some items couldn't load. Try again when you're ready."
					: busy
						? "Tedix is slow right now. Your decisions are safe — retrying…"
						: "Tedix couldn't load this view. Your decisions are safe. Try again when you're ready."}
			</span>
			{!busy && (
				<Button
					variant="outline"
					onClick={() => {
						void retry();
						for (const failure of children)
							void failure.retry({ cancelRefetch: false });
					}}
				>
					Try again
				</Button>
			)}
			{references.length > 0 && (
				<Collapsible aria-label="Read error details">
					<CollapsibleTrigger>Details</CollapsibleTrigger>
					<CollapsibleContent>
						{references.map((reference) => (
							<p key={reference}>Support reference: {reference}</p>
						))}
					</CollapsibleContent>
				</Collapsible>
			)}
		</>
	);
	return partial ? (
		<div
			className="fd-source-error flex flex-wrap items-center gap-2"
			role="status"
		>
			{content}
		</div>
	) : (
		<Alert variant="warning" className="fd-source-error" role="alert">
			{content}
		</Alert>
	);
}
