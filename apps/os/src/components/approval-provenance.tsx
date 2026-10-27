import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
	ApprovalProvenance,
	ApprovalRequest,
} from "@tedix/api-contract/contracts/tedi-approvals";
import { LoadError } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Pagination } from "@/components/kumo/pagination";
import { SegmentedControl } from "@/components/kumo/segmented-control";
import { CodeBlock } from "@/components/kumo/code";
import { Surface } from "@/components/kumo/surface";
import { Text } from "@/components/kumo/text";
import { osQuery } from "@/lib/os-query-options";

type Cursor = NonNullable<ApprovalProvenance["simulations"]["nextCursor"]>;
type TerminalStatus = Exclude<ApprovalRequest["status"], "pending">;

/** Completed requests remain inspectable when the pending queue is empty. */
export function ApprovalProvenanceHistory() {
	const [open, setOpen] = useState(false);
	return (
		<details onToggle={(event) => setOpen(event.currentTarget.open)}>
			<summary className="tap-target-y cursor-pointer">
				Receipts for past decisions
			</summary>
			{open ? <ApprovalHistoryRequests /> : null}
		</details>
	);
}

function ApprovalHistoryRequests() {
	const [page, setPage] = useState<{ status: TerminalStatus; offset: number }>({
		status: "approved",
		offset: 0,
	});
	const query = useQuery(
		osQuery.tediApprovals.list.queryOptions({ input: { ...page, limit: 10 } }),
	);
	return (
		<Surface className="mt-2 grid gap-3 p-3">
			<Text as="p" role="body">
				Inspect past requests and their recorded predictions or execution
				receipts. History is read-only; approval alone does not prove execution.
			</Text>
			<SegmentedControl
				ariaLabel="History status"
				value={page.status}
				options={(
					["approved", "rejected", "cancelled", "expired"] as const
				).map((status) => ({
					value: status,
					label: (
						<span aria-label={`Show ${status} requests`}>
							{status.charAt(0).toUpperCase() + status.slice(1)}
						</span>
					),
				}))}
				onValueChange={(status) => setPage({ status, offset: 0 })}
			/>
			{query.isError ? (
				<LoadError
					title="Approval history unavailable"
					error={query.error}
					onRetry={() => void query.refetch()}
					retrying={query.isFetching}
					help="Past requests could not be loaded."
				/>
			) : !query.data ? (
				<Text as="p" role="body">
					Loading approval history…
				</Text>
			) : query.data.data.length === 0 ? (
				<Text as="p" role="body">
					No {page.status} requests in this page.
				</Text>
			) : (
				<ol
					className="m-0 grid list-none gap-2 p-0"
					aria-label="Past runtime approval requests"
				>
					{query.data.data.map((approval) => (
						<Surface
							key={approval.id}
							render={<li />}
							className="grid gap-2 p-2"
						>
							<Text as="strong" role="body">
								{approval.description}
							</Text>
							<Badge variant="outline">{approval.status}</Badge>
							<ApprovalProvenanceDisclosure approvalRequestId={approval.id} />
						</Surface>
					))}
				</ol>
			)}
			<Pagination
				labels={{
					navigation: "Approval history pages",
					previousPage: "Previous requests",
					nextPage: "Next requests",
				}}
				page={page.offset / 10 + 1}
				perPage={10}
				totalCount={query.data?.pagination.total}
				hasNextPage={query.data?.pagination.hasMore}
				setPage={(next) =>
					setPage((previous) => ({ ...previous, offset: (next - 1) * 10 }))
				}
			>
				<Pagination.Controls controls="simple" />
			</Pagination>
		</Surface>
	);
}

/** Opening the disclosure mounts the read; an untouched manifest fetches no history. */
export function ApprovalProvenanceDisclosure({
	approvalRequestId,
}: {
	approvalRequestId: string;
}) {
	const [open, setOpen] = useState(false);
	return (
		<details onToggle={(event) => setOpen(event.currentTarget.open)}>
			<summary className="cursor-pointer">
				Predictions and observed execution
			</summary>
			{open ? (
				<ApprovalProvenanceDetails approvalRequestId={approvalRequestId} />
			) : null}
		</details>
	);
}

function ApprovalProvenanceDetails({
	approvalRequestId,
}: {
	approvalRequestId: string;
}) {
	const [simulationCursors, setSimulationCursors] = useState<
		(Cursor | undefined)[]
	>([undefined]);
	const [receiptCursors, setReceiptCursors] = useState<(Cursor | undefined)[]>([
		undefined,
	]);
	const query = useQuery(
		osQuery.tediApprovals.getProvenance.queryOptions({
			input: {
				approvalRequestId,
				simulations: { limit: 10, cursor: simulationCursors.at(-1) },
				executionReceipts: { limit: 10, cursor: receiptCursors.at(-1) },
			},
		}),
	);
	if (query.isError)
		return (
			<LoadError
				title="Provenance unavailable"
				error={query.error}
				onRetry={() => void query.refetch()}
				retrying={query.isFetching}
				help="Predictions and execution history could not be loaded."
				className="mt-2"
			/>
		);
	if (!query.data)
		return (
			<Text as="p" role="body">
				Loading provenance…
			</Text>
		);
	const { simulations, executionReceipts } = query.data;
	return (
		<Surface className="mt-2 grid gap-3 p-3">
			<Text as="strong" role="body">
				Counterfactual predictions
			</Text>
			{simulations.records.length === 0 ? (
				<Text as="p" role="body">
					No recorded simulations.
				</Text>
			) : (
				simulations.records.map((record) => (
					<Surface key={record.id} className="grid gap-2 p-2">
						<Badge variant="outline">Simulated — not executed</Badge>
						<Text as="p" role="body">
							{record.simulatorId} · {record.simulatorVersion} · Confidence{" "}
							{record.confidence}
						</Text>
						<Text as="p" role="body">
							This prediction is counterfactual and is not proof of an effect.
						</Text>
						<CodeBlock
							lang="json"
							showCopyButton
							code={JSON.stringify(record, null, 2)}
							className="max-h-80 overflow-auto"
						/>
					</Surface>
				))
			)}
			<Pagination
				labels={{
					navigation: "Prediction history pages",
					previousPage: "Previous predictions",
					nextPage: "Next predictions",
				}}
				page={simulationCursors.length}
				hasNextPage={Boolean(simulations.nextCursor)}
				setPage={(next) =>
					setSimulationCursors((previous) =>
						next > previous.length && simulations.nextCursor
							? [...previous, simulations.nextCursor]
							: previous.slice(0, next),
					)
				}
			>
				<Pagination.Controls controls="simple" />
			</Pagination>
			<Text as="strong" role="body">
				Observed execution
			</Text>
			{executionReceipts.records.length === 0 ? (
				<Text as="p" role="body">
					No recorded execution receipts. Approval alone does not prove
					execution.
				</Text>
			) : (
				executionReceipts.records.map((record) => (
					<Surface key={record.id} className="grid gap-2 p-2">
						<Badge variant="outline">
							Observed execution: {record.outcome}
						</Badge>
						<Text as="p" role="body">
							Executed {new Date(record.executedAt).toLocaleString()} · Baseline
							fence: {record.baselineFenceOutcome}
						</Text>
						<CodeBlock
							lang="json"
							showCopyButton
							code={JSON.stringify(record, null, 2)}
							className="max-h-80 overflow-auto"
						/>
					</Surface>
				))
			)}
			<Pagination
				labels={{
					navigation: "Execution history pages",
					previousPage: "Previous receipts",
					nextPage: "Next receipts",
				}}
				page={receiptCursors.length}
				hasNextPage={Boolean(executionReceipts.nextCursor)}
				setPage={(next) =>
					setReceiptCursors((previous) =>
						next > previous.length && executionReceipts.nextCursor
							? [...previous, executionReceipts.nextCursor]
							: previous.slice(0, next),
					)
				}
			>
				<Pagination.Controls controls="simple" />
			</Pagination>
		</Surface>
	);
}
