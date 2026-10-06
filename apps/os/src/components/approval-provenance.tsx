import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
	ApprovalProvenance,
	ApprovalRequest,
} from "@tedix/api-contract/contracts/tedi-approvals";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
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
			<summary className="cursor-pointer">Runtime approval history</summary>
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
			<Surface
				className="flex flex-wrap gap-2"
				role="group"
				aria-label="History status"
			>
				{(["approved", "rejected", "cancelled", "expired"] as const).map(
					(status) => (
						<Button
							key={status}
							variant="outline"
							aria-label={`Show ${status} requests`}
							aria-pressed={page.status === status}
							onClick={() => setPage({ status, offset: 0 })}
						>
							{status.charAt(0).toUpperCase() + status.slice(1)}
						</Button>
					),
				)}
			</Surface>
			{query.isError ? (
				<Alert variant="destructive">
					<AlertTitle>Approval history unavailable</AlertTitle>
					<AlertDescription>
						Past requests could not be loaded.
					</AlertDescription>
					<Button variant="outline" onClick={() => void query.refetch()}>
						Retry approval history
					</Button>
				</Alert>
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
							<Text as="span" role="label" tone="mono-secondary">
								{approval.id}
							</Text>
							<ApprovalProvenanceDisclosure approvalRequestId={approval.id} />
						</Surface>
					))}
				</ol>
			)}
			<Surface
				className="flex gap-2"
				role="group"
				aria-label="Approval history pages"
			>
				<Button
					variant="outline"
					disabled={query.isFetching || page.offset === 0}
					onClick={() =>
						setPage((previous) => ({
							...previous,
							offset: Math.max(0, previous.offset - 10),
						}))
					}
				>
					Previous requests
				</Button>
				<Button
					variant="outline"
					disabled={
						query.isFetching || query.isError || !query.data?.pagination.hasMore
					}
					onClick={() =>
						setPage((previous) => ({
							...previous,
							offset: previous.offset + 10,
						}))
					}
				>
					Next requests
				</Button>
			</Surface>
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
			<Alert variant="destructive" className="mt-2">
				<AlertTitle>Provenance unavailable</AlertTitle>
				<AlertDescription>
					Predictions and execution history could not be loaded.
				</AlertDescription>
				<Button variant="outline" onClick={() => void query.refetch()}>
					Retry provenance
				</Button>
			</Alert>
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
			<Surface
				className="flex gap-2"
				role="group"
				aria-label="Prediction history pages"
			>
				<Button
					variant="outline"
					disabled={query.isFetching || simulationCursors.length === 1}
					onClick={() =>
						setSimulationCursors((previous) => previous.slice(0, -1))
					}
				>
					Previous predictions
				</Button>
				<Button
					variant="outline"
					disabled={query.isFetching || !simulations.nextCursor}
					onClick={() => {
						if (simulations.nextCursor)
							setSimulationCursors((previous) => [
								...previous,
								simulations.nextCursor!,
							]);
					}}
				>
					Next predictions
				</Button>
			</Surface>
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
			<Surface
				className="flex gap-2"
				role="group"
				aria-label="Execution history pages"
			>
				<Button
					variant="outline"
					disabled={query.isFetching || receiptCursors.length === 1}
					onClick={() => setReceiptCursors((previous) => previous.slice(0, -1))}
				>
					Previous receipts
				</Button>
				<Button
					variant="outline"
					disabled={query.isFetching || !executionReceipts.nextCursor}
					onClick={() => {
						if (executionReceipts.nextCursor)
							setReceiptCursors((previous) => [
								...previous,
								executionReceipts.nextCursor!,
							]);
					}}
				>
					Next receipts
				</Button>
			</Surface>
		</Surface>
	);
}
