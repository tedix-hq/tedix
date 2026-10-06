import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { CodeBlock } from "@/components/kumo/code";
import { Surface } from "@/components/kumo/surface";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import { osQuery, osQueryKeys } from "@/lib/os-query-options";
import { ApprovalProvenanceDisclosure } from "./approval-provenance";

type Manifest = Awaited<
	ReturnType<typeof osApi.tediApprovals.getReviewManifest>
>;
type Decision = "approve" | "veto";
type Resolution = Awaited<
	ReturnType<typeof osApi.tediApprovals.resolveReviewManifest>
>;

export function ApprovalManifestActions({
	manifest,
	decisions,
	disabled,
	onDecision,
}: {
	manifest: Manifest;
	decisions: Record<string, Decision>;
	disabled: boolean;
	onDecision: (id: string, decision: Decision | undefined) => void;
}) {
	return (
		<ol
			className="m-0 grid list-none gap-2 p-0"
			aria-label="Ordered exact requests"
		>
			{manifest.actions.map((action) => {
				const request = action.approval;
				const blocked = action.dependencies.some(
					(edge) => edge.kind === "hard",
				);
				const pending =
					request.status === "pending" &&
					!request.review.timeout.expired &&
					Date.parse(request.expiresAt) > Date.now();
				return (
					<Surface
						key={request.id}
						render={<li />}
						className="grid gap-3 px-3 py-3"
					>
						<Text as="strong" role="body" tone="strong">
							{action.order + 1}. {request.description}
						</Text>
						<Text as="p" role="body" className="m-0">
							{request.review.operatorQuestion}
						</Text>
						<div className="flex flex-wrap gap-2">
							<Badge variant="outline">
								{action.inclusion === "requested"
									? "Selected"
									: "Included by hard dependency graph"}
							</Badge>
							<Badge variant="outline">{request.status}</Badge>
							<Badge variant="outline">
								Execution: {action.execution.state}
							</Badge>
							<Text as="span" role="label" tone="secondary">
								Expires {new Date(request.expiresAt).toLocaleString()}
							</Text>
						</div>
						{action.dependencies.length > 0 ? (
							<ul
								aria-label="Recorded dependencies"
								className="m-0 grid gap-1 pl-5"
							>
								{action.dependencies.map((edge) => (
									<li key={edge.declarationEventId}>
										{edge.kind === "hard"
											? "Blocked: baseline verification unavailable"
											: "Informational only"}{" "}
										· {edge.prerequisiteApprovalRequestId}
									</li>
								))}
							</ul>
						) : null}
						{action.vetoCascadeApprovalRequestIds.length > 0 ? (
							<details>
								<summary>
									Veto also cancels{" "}
									{action.vetoCascadeApprovalRequestIds.length} pending
									dependent requests
								</summary>
								<ul>
									{action.vetoCascadeApprovalRequestIds.map((id) => (
										<li key={id}>{id}</li>
									))}
								</ul>
							</details>
						) : null}
						<details>
							<summary className="cursor-pointer">
								Exact input, evidence and identity
							</summary>
							<CodeBlock
								lang="json"
								showCopyButton
								className="mt-2 max-h-80 overflow-auto"
								code={JSON.stringify(
									{
										approvalRequestId: request.id,
										tediId: request.tediId,
										organizationId: request.orgId,
										workflowId: request.workflowId,
										actionType: request.actionType,
										canonicalInputHash: action.canonicalInputHash,
										expiresAt: request.expiresAt,
										payload: request.payload,
										evidenceRefs: request.review.evidenceRefs,
										timeout: request.review.timeout,
										interaction: request.review.interaction,
										execution: action.execution,
									},
									null,
									2,
								)}
							/>
						</details>
						<ApprovalProvenanceDisclosure approvalRequestId={request.id} />
						<div
							className="flex flex-wrap gap-2"
							role="group"
							aria-label={`Decision for ${request.description}`}
						>
							<Button
								variant="outline"
								aria-pressed={!decisions[request.id]}
								disabled={disabled}
								onClick={() => onDecision(request.id, undefined)}
							>
								Keep pending
							</Button>
							<Button
								aria-pressed={decisions[request.id] === "approve"}
								disabled={
									disabled ||
									!pending ||
									blocked ||
									request.review.decisionMode !== "approve_or_reject"
								}
								onClick={() => onDecision(request.id, "approve")}
							>
								Choose approval
							</Button>
							<Button
								variant="destructive"
								aria-pressed={decisions[request.id] === "veto"}
								disabled={
									disabled ||
									!pending ||
									request.review.decisionMode !== "approve_or_reject"
								}
								onClick={() => onDecision(request.id, "veto")}
							>
								Choose veto
							</Button>
						</div>
					</Surface>
				);
			})}
		</ol>
	);
}

export function ApprovalManifestReview({
	approvalRequestIds,
	onClose,
}: {
	approvalRequestIds: string[];
	onClose: () => void;
}) {
	const client = useQueryClient();
	const [decisions, setDecisions] = useState<Record<string, Decision>>({});
	const [submitted, setSubmitted] = useState(false);
	const [result, setResult] = useState<Resolution>();
	const manifestHash = useRef<string | undefined>(undefined);
	const query = useQuery({
		...osQuery.tediApprovals.getReviewManifest.queryOptions({
			input: { approvalRequestIds },
		}),
		staleTime: 0,
		refetchOnWindowFocus: true,
		refetchOnReconnect: true,
	});
	useEffect(() => {
		const nextHash = query.data?.manifestHash;
		if (!nextHash) return;
		if (manifestHash.current && manifestHash.current !== nextHash) {
			setDecisions({});
			// A background refresh can observe our own in-flight decision. It
			// must not clear its uncertain outcome or unlock another submission.
			if (!submitted) {
				setResult(undefined);
				resolve.reset();
			}
		}
		manifestHash.current = nextHash;
	}, [query.data?.manifestHash]);
	const resolve = useMutation({
		retry: false,
		mutationFn: async () => {
			if (!query.data)
				throw new Error("Load the exact requests before deciding.");
			return osApi.tediApprovals.resolveReviewManifest({
				approvalRequestIds,
				expectedManifestHash: query.data.manifestHash,
				decisions: query.data.actions.flatMap((action) => {
					const decision = decisions[action.approval.id];
					return decision
						? [
								{
									approvalRequestId: action.approval.id,
									expectedCanonicalInputHash: action.canonicalInputHash,
									decision,
								},
							]
						: [];
				}),
			});
		},
		onSuccess: (value) => setResult(value),
		onSettled: async () => {
			await client.invalidateQueries({ queryKey: osQueryKeys.approvals() });
		},
	});
	const refresh = async () => {
		setDecisions({});
		setResult(undefined);
		resolve.reset();
		setSubmitted(true);
		const next = await query.refetch();
		if (!next.isError) setSubmitted(false);
	};
	return (
		<section aria-label="Review selected exact requests" className="grid gap-3">
			<Text as="h3" role="section">
				Review selected requests
			</Text>
			<Text as="p" role="body" className="m-0">
				The server includes every action in each selected request's hard
				dependency graph. Each request keeps its own authority, and every
				decision is explicit. Vetoes and their dependent cancellations happen
				first; independent approvals follow the displayed order. Actions without
				a choice stay pending.
			</Text>
			{query.isPending ? (
				<Text as="p" role="body">
					Loading exact requests…
				</Text>
			) : null}
			{query.error || resolve.error ? (
				<Alert variant="destructive">
					<AlertTitle>Review needs refreshing</AlertTitle>
					<AlertDescription>
						{(query.error ?? resolve.error)?.message} A response failure does
						not prove that no action ran. Refresh to read current state;
						decisions are never retried automatically.
					</AlertDescription>
				</Alert>
			) : null}
			{query.data ? (
				<ApprovalManifestActions
					manifest={query.data}
					decisions={decisions}
					disabled={
						submitted || resolve.isPending || query.isFetching || query.isError
					}
					onDecision={(id, decision) =>
						setDecisions((current) => {
							const next = { ...current };
							if (decision) next[id] = decision;
							else delete next[id];
							return next;
						})
					}
				/>
			) : null}
			{result ? (
				<section aria-label="Per-request outcomes" aria-live="polite">
					<Text as="h4" role="section">
						Observed outcomes
					</Text>
					<ul>
						{result.results.map((row) => (
							<li key={row.approvalRequestId}>
								<Badge
									variant={row.outcome === "unknown" ? "warning" : "outline"}
								>
									{row.outcome}
								</Badge>{" "}
								·{" "}
								{query.data?.actions.find(
									(action) => action.approval.id === row.approvalRequestId,
								)?.approval.description ?? row.approvalRequestId}
								: {row.reason}
							</li>
						))}
					</ul>
					{result.results.some((row) => row.outcome === "unknown") ? (
						<Alert variant="warning">
							<AlertTitle>Reconciliation required</AlertTitle>
							<AlertDescription>
								At least one exact request has an unknown outcome. Refresh and
								review current state before making another decision.
							</AlertDescription>
						</Alert>
					) : null}
					<Text as="p" role="body">
						Approved is a decision, not a claim of provider completion. Unknown
						outcomes must be reconciled before any new action.
					</Text>
				</section>
			) : null}
			<div className="flex flex-wrap gap-2">
				<Button
					disabled={
						!query.data ||
						query.isError ||
						query.isFetching ||
						resolve.isPending ||
						submitted ||
						Object.keys(decisions).length === 0
					}
					onClick={() => {
						setSubmitted(true);
						resolve.mutate();
					}}
				>
					Submit explicit decisions
				</Button>
				<Button
					variant="outline"
					disabled={resolve.isPending || query.isFetching}
					onClick={() => void refresh()}
				>
					Refresh review
				</Button>
				<Button
					variant="outline"
					disabled={resolve.isPending}
					onClick={onClose}
				>
					Close review
				</Button>
			</div>
		</section>
	);
}
