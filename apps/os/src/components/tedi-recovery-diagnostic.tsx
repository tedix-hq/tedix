import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { TediRuntimeRecoveryDiagnosticResponse } from "@tedix/api-contract/schemas/tedi";
import { Button } from "@/components/kumo/button";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import { Input } from "@/components/kumo/input";
import { osQuery } from "@/lib/os-query-options";
import { useOsOperationalContext } from "@/lib/use-os-preferences";

export function RecoveryDiagnosticResult({
	data,
	error,
	pending,
}: {
	data?: TediRuntimeRecoveryDiagnosticResponse;
	error?: boolean;
	pending?: boolean;
}) {
	if (pending) return <p role="status">Reading recovery state…</p>;
	if (error)
		return (
			<p role="alert">
				Recovery state unavailable. Session state is unknown; try inspecting
				again.
			</p>
		);
	if (!data)
		return (
			<p>Recovery state is unknown until you inspect an existing session.</p>
		);
	return (
		<div className="space-y-2">
			<p>
				Scheduling: {data.scheduling}. Live tasks: {data.taskCount}. Pending
				submissions: {data.submissionCount}.
			</p>
			<p>
				Observed {data.sampledAt}.{" "}
				{data.operation
					? `Operation ${data.operation.operationId}: ${data.operation.status}.`
					: "No individual operation requested."}
			</p>
			{data.tasks.map((task) => (
				<p key={task.id}>
					Task {task.id}: {task.kind}, {task.view}
					{task.blockedReason ? ` (${task.blockedReason})` : ""}
					{task.waitingOn.length
						? `; waiting on ${task.waitingOn.join(", ")}${task.waitingOnTruncated ? "…" : ""}`
						: ""}
					{task.abortRequested ? "; cancellation requested" : ""}.
				</p>
			))}
			{data.submissions.map((row) => (
				<p key={row.id}>
					Submission {row.id}
					{row.operationId ? `, operation ${row.operationId}` : ""}:{" "}
					{row.status}.
				</p>
			))}
			{data.truncated && (
				<p>
					Showing the first 50 tasks and submissions. Counts include all
					matching rows.
				</p>
			)}
			<p>
				This snapshot is a diagnostic read. Normal agent recovery can continue
				when an existing session wakes.
			</p>
		</div>
	);
}

export function TediRecoveryDiagnostic({ tediId }: { tediId: string }) {
	const authority = useOsOperationalContext();
	const allowed =
		authority.data?.authority.permissions.includes("platform:admin") ?? false;
	const [sessionKey, setSessionKey] = useState("");
	const [operationId, setOperationId] = useState("");
	const [request, setRequest] = useState<{
		tediId: string;
		sessionKey: string;
		operationId?: string;
	} | null>(null);
	// A changed target or authority requires another explicit inspection click.
	useEffect(() => {
		setRequest(null);
	}, [tediId, allowed]);
	const requestedTargetMatches = request?.tediId === tediId;
	const diagnostic = useQuery({
		...osQuery.tedis.inspectRuntimeRecovery.queryOptions({
			input: requestedTargetMatches
				? request!
				: { tediId, sessionKey: "not-requested" },
		}),
		enabled: allowed && requestedTargetMatches,
		retry: false,
		staleTime: Infinity,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
	});
	if (!allowed) return null;
	return (
		<Card className="md:col-span-2">
			<CardHeader>
				<CardTitle>Runtime recovery</CardTitle>
			</CardHeader>
			<CardContent className="space-y-3">
				<p>
					Inspect native task metadata for an existing session. No model or tool
					payloads are returned.
				</p>
				<Input
					aria-label="Exact session key"
					placeholder="Exact session key"
					value={sessionKey}
					maxLength={512}
					onChange={(event) => setSessionKey(event.target.value)}
				/>
				<Input
					aria-label="Exact operation id (optional)"
					placeholder="Exact operation id (optional)"
					value={operationId}
					maxLength={512}
					onChange={(event) => setOperationId(event.target.value)}
				/>
				<Button
					disabled={
						!sessionKey ||
						sessionKey !== sessionKey.trim() ||
						operationId !== operationId.trim() ||
						diagnostic.isFetching
					}
					onClick={() => {
						const next = {
							tediId,
							sessionKey,
							...(operationId ? { operationId } : {}),
						};
						if (
							request?.tediId === tediId &&
							request?.sessionKey === sessionKey &&
							request?.operationId === next.operationId
						)
							void diagnostic.refetch();
						else setRequest(next);
					}}
				>
					Inspect recovery
				</Button>
				<RecoveryDiagnosticResult
					data={requestedTargetMatches ? diagnostic.data : undefined}
					error={requestedTargetMatches && diagnostic.isError}
					pending={requestedTargetMatches && diagnostic.isFetching}
				/>
			</CardContent>
		</Card>
	);
}
