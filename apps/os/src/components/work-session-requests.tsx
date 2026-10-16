import type { AgentSessionRequestSchema } from "@tedix/api-contract/schemas/agent-session-requests";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type * as z from "zod";
import { Badge, type BadgeVariant } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	Collection,
	PageSection,
	SectionActions,
	SectionDescription,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";
import { SegmentedControl } from "@/components/kumo/segmented-control";
import { Text } from "@/components/kumo/text";
import { isRequestWaitingOnYou } from "@/components/work-needs-you-count";
import { osApi } from "@/lib/api";
import { osQueryKeys } from "@/lib/os-query-options";
import { absoluteTime, relativeTime } from "@/lib/time";

/*
 * Your requests: the private request ledger of what you asked your own local
 * Claude Code and Codex sessions. The plugin's observer records each request,
 * the reflector moves it as the agent works, and a row closes only with
 * evidence. Rows waiting on you are also Needs you rows.
 */

export type SessionRequest = z.infer<typeof AgentSessionRequestSchema>;

type Filter = "active" | "waiting" | "closed" | "all";

const ACTIVE = new Set([
	"open",
	"in_progress",
	"waiting_on_user",
	"dropped_risk",
]);

const STATUS: Record<
	SessionRequest["status"],
	{ label: string; variant: BadgeVariant }
> = {
	waiting_on_user: { label: "Waiting on you", variant: "warning" },
	dropped_risk: { label: "At risk", variant: "destructive" },
	open: { label: "Open", variant: "info" },
	in_progress: { label: "In progress", variant: "secondary" },
	done: { label: "Done", variant: "success" },
	cancelled: { label: "Withdrawn", variant: "outline" },
};

const HARNESS: Record<SessionRequest["harness"], string> = {
	"claude-code": "Claude Code",
	codex: "Codex",
};

export function filterSessionRequests(
	rows: readonly SessionRequest[],
	filter: Filter,
): SessionRequest[] {
	const kept = rows.filter((row) =>
		filter === "all"
			? true
			: filter === "waiting"
				? isRequestWaitingOnYou(row)
				: filter === "closed"
					? !ACTIVE.has(row.status)
					: ACTIVE.has(row.status),
	);
	// Newest message first: the ledger reads oldest first.
	return kept.reverse();
}

export function sessionRequestSource(row: SessionRequest): string {
	return [HARNESS[row.harness], row.repository].filter(Boolean).join(" · ");
}

export function SessionRequestsSection({
	rows,
}: {
	rows: readonly SessionRequest[];
}) {
	const client = useQueryClient();
	const [filter, setFilter] = useState<Filter>("active");
	const update = useMutation({
		mutationFn: (input: {
			id: string;
			status: SessionRequest["status"];
			evidence?: string;
		}) => osApi.workAgentSessions.updateRequest(input),
		onSuccess: () =>
			client.invalidateQueries({
				queryKey: osQueryKeys.agentSessionRequests(),
			}),
	});
	const shown = filterSessionRequests(rows, filter);
	const active = rows.filter((row) => ACTIVE.has(row.status)).length;
	return (
		<PageSection id="your-requests" aria-labelledby="your-requests-title">
			<SectionHeader>
				<SectionHeading>
					<SectionTitle id="your-requests-title">Your requests</SectionTitle>
					<SectionDescription>
						What you asked your Claude Code and Codex sessions, so nothing gets
						lost. {active} still open. Only you see these.
					</SectionDescription>
				</SectionHeading>
				<SectionActions>
					<SegmentedControl<Filter>
						ariaLabel="Show requests"
						compact
						value={filter}
						onValueChange={setFilter}
						options={[
							{ value: "active", label: "Open" },
							{ value: "waiting", label: "Waiting on you" },
							{ value: "closed", label: "Closed" },
							{ value: "all", label: "All" },
						]}
					/>
				</SectionActions>
			</SectionHeader>
			{update.error ? (
				<Text as="p" role="label" tone="error">
					The change was not saved:{" "}
					{update.error instanceof Error
						? update.error.message
						: "Unknown error"}
				</Text>
			) : null}
			{shown.length ? (
				<Collection aria-label="Your requests">
					{shown.map((row) => {
						const status = STATUS[row.status];
						const open = ACTIVE.has(row.status);
						return (
							<li
								key={row.id}
								data-request-status={row.status}
								className="flex min-w-0 flex-wrap items-start gap-3 px-4 py-3 sm:flex-nowrap"
							>
								<div className="grid min-w-0 flex-1 gap-1">
									<Text
										as="p"
										role="body"
										className="m-0 flex min-w-0 flex-wrap items-center gap-2"
									>
										<Badge variant={status.variant}>{status.label}</Badge>
										<span className="min-w-0 break-words">{row.text}</span>
									</Text>
									<Text as="p" role="label" tone="secondary" className="m-0">
										{sessionRequestSource(row)} ·{" "}
										<time
											dateTime={row.sourceAt}
											title={absoluteTime(row.sourceAt)}
										>
											{relativeTime(row.sourceAt)}
										</time>
										{row.evidence ? ` · ${row.evidence}` : null}
									</Text>
								</div>
								<div className="flex shrink-0 gap-2">
									{open ? (
										<>
											<Button
												size="sm"
												variant="secondary"
												disabled={update.isPending}
												onClick={() =>
													update.mutate({
														id: row.id,
														status: "done",
														evidence: "Marked done by you in Tedix OS.",
													})
												}
											>
												Done
											</Button>
											<Button
												size="sm"
												variant="outline"
												disabled={update.isPending}
												onClick={() =>
													update.mutate({ id: row.id, status: "cancelled" })
												}
											>
												Withdraw
											</Button>
										</>
									) : (
										<Button
											size="sm"
											variant="outline"
											disabled={update.isPending}
											onClick={() =>
												update.mutate({ id: row.id, status: "open" })
											}
										>
											Reopen
										</Button>
									)}
								</div>
							</li>
						);
					})}
				</Collection>
			) : (
				<Text as="p" role="body" tone="secondary">
					{rows.length
						? "No requests match this filter."
						: "No requests yet. They appear here once the Tedix plugin records your messages (decision capture on)."}
				</Text>
			)}
		</PageSection>
	);
}
