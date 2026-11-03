import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type {
	OfficeActivityRow,
	OfficeCanonicalRow,
} from "@tedix/api-contract/schemas/office-activity";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { Link } from "@/components/kumo/link";
import {
	PageSection,
	SectionHeader,
	SectionHeading,
	SectionTitle,
	SectionDescription,
	Collection,
} from "@/components/kumo/page";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import { Skeleton } from "@/components/kumo/skeleton";
import { Text } from "@/components/kumo/text";
import { OfficeReadError } from "@/components/office-read-error";
import { officeOperationsQueryOptions } from "@/lib/os-query-options";
import { normalizeD1Timestamp } from "@/lib/time";

const REASONS = {
	reported: "Status hook observed; Work completion is separate",
	working: "Deferred to the running session's hooks",
	session_unavailable: "Session unavailable or still open; left undelivered",
	host_mismatch: "Originating host does not match",
	receipt_unconfirmed:
		"Previous delivery is unconfirmed; retained for inspection",
	delivery_failed: "Delivery failed",
	delivery_confirmed: "Exact-session delivery confirmed",
	queue_unconfirmed: "Queued or unconfirmed; pickup is unknown",
	resume_running: "A resume is still running",
} as const;

export function canonicalOfficeLine(row: OfficeCanonicalRow): {
	title: string;
	outcome: string;
} {
	switch (row.stage) {
		case "saved":
			return {
				title: "Reply saved; delivery is unconfirmed",
				outcome: "unknown",
			};
		case "queued":
			return {
				title: "Reply queued/unconfirmed; awaiting session acknowledgement",
				outcome: "unknown",
			};
		case "delivered":
			return {
				title: "Reply delivered to the originating session",
				outcome: "success",
			};
		case "acknowledged":
			return {
				title: "Reply acknowledged by the originating session",
				outcome: "success",
			};
		case "handed_off":
			return {
				title: "Reply handed off; originating session delivery is unconfirmed",
				outcome: "deferred",
			};
		case "work_closed":
			return {
				title: row.resultRecorded
					? "Work closed; successful Attempt and result note recorded"
					: "Work closed in its canonical history; result evidence needs review",
				outcome: "observed",
			};
		case "attempt_succeeded":
			return {
				title: row.resultRecorded
					? "Attempt succeeded; result note recorded"
					: "Attempt succeeded; result is unknown",
				outcome: row.resultRecorded ? "success" : "unknown",
			};
		case "attempt_failed":
			return { title: "Attempt failed", outcome: "failed" };
		case "unknown":
			return { title: "Delivery or outcome is unknown", outcome: "unknown" };
	}
}

export function officeTimelineRows(
	operations: OfficeActivityRow[],
	canonical: OfficeCanonicalRow[],
) {
	return [
		...operations.map((row) => ({
			...row,
			title: `${row.trigger === "reply_drain" ? "Reply fallback" : row.trigger} · ${REASONS[row.reason]}${row.reportedState ? ` · Session reported ${row.reportedState}` : ""}`,
			attemptId: null,
			evidence: `Reported by CLI ${row.reporterVersion}${row.occurrences > 1 ? ` · ${row.occurrences} coalesced status observations` : ""}`,
		})),
		...canonical.map((row) => ({
			...row,
			...canonicalOfficeLine(row),
			evidence:
				row.source === "work"
					? "Canonical Work event. Tests, publication, release and live acceptance require their own evidence."
					: "Canonical reply receipt",
		})),
	].sort(
		(a, b) =>
			Date.parse(normalizeD1Timestamp(b.at)) -
				Date.parse(normalizeD1Timestamp(a.at)) || b.id.localeCompare(a.id),
	);
}

function Filter({
	label,
	value,
	options,
	onChange,
}: {
	label: string;
	value: string;
	options: string[];
	onChange: (value: string) => void;
}) {
	return (
		<Select value={value} onValueChange={(value) => onChange(value ?? "all")}>
			<SelectTrigger aria-label={label}>
				<SelectValue placeholder={label} />
			</SelectTrigger>
			<SelectContent>
				{["all", ...options].map((option) => (
					<SelectItem key={option} value={option}>
						{option === "all" ? `All ${label.toLowerCase()}` : option}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

export function OfficeActivityTimeline() {
	const [limit, setLimit] = useState(50);
	const [source, setSource] = useState("all");
	const [host, setHost] = useState("all");
	const [outcome, setOutcome] = useState("all");
	const query = useQuery(officeOperationsQueryOptions(limit));
	const rows = officeTimelineRows(
		query.data?.rows ?? [],
		query.data?.canonical ?? [],
	);
	const stale = (at: string) =>
		Date.now() - Date.parse(normalizeD1Timestamp(at)) > 15 * 60_000;
	const filtered = rows.filter(
		(row) =>
			(source === "all" || row.source === source) &&
			(host === "all" || row.host === host) &&
			(outcome === "all" ||
				(outcome === "stale report"
					? stale(row.at) &&
						(row.source === "hook" || row.source === "supervisor")
					: row.outcome === outcome)),
	);
	return (
		<PageSection aria-labelledby="office-timeline-title">
			<SectionHeader>
				<SectionHeading>
					<SectionTitle id="office-timeline-title">What happened</SectionTitle>
					<SectionDescription>
						Newest first, in your local time. Up to 100 reports and 100 Work
						events from the last 24 hours, plus 50 recent replies. Unobserved
						history is unknown.
					</SectionDescription>
				</SectionHeading>
			</SectionHeader>
			<div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
				<Filter
					label="Sources"
					value={source}
					onChange={setSource}
					options={["hook", "supervisor", "reply", "work"]}
				/>
				<Filter
					label="Hosts"
					value={host}
					onChange={setHost}
					options={["claude-code", "codex", "devin", "opencode"]}
				/>
				<Filter
					label="Outcomes"
					value={outcome}
					onChange={setOutcome}
					options={[
						"observed",
						"success",
						"deferred",
						"failed",
						"unknown",
						"stale report",
					]}
				/>
			</div>
			{query.isError && (
				<>
					<OfficeReadError resource="Office activity" error={query.error} />
					<Text as="p">
						{query.data
							? "Showing the last read; activity may be stale."
							: "Activity is unavailable; this does not mean nothing happened."}
					</Text>
					<Button onClick={() => void query.refetch()}>Retry activity</Button>
				</>
			)}
			{query.isPending && (
				<Skeleton
					className="h-24 w-full"
					aria-label="Loading Office activity"
				/>
			)}
			{query.data && (
				<>
					<Text as="p" role="label" tone="secondary">
						Last read {new Date(query.data.observedAt).toLocaleTimeString()}.
						Quiet or missing reports do not prove a source is online or offline.
					</Text>
					{filtered.length === 0 ? (
						<Text as="p">
							No observed activity in this loaded history matches these filters.
							Earlier or offline activity is unknown.
						</Text>
					) : (
						<Collection className="divide-y divide-kumo-line">
							{filtered.map((row) => (
								<li
									key={row.id}
									className="grid min-w-0 gap-2 px-4 py-3 sm:grid-cols-[10rem_1fr]"
								>
									<time
										dateTime={row.at}
										className="type-tedix-label text-kumo-subtle"
									>
										{new Date(normalizeD1Timestamp(row.at)).toLocaleString()}
									</time>
									<div className="grid min-w-0 gap-2">
										<div className="flex flex-wrap gap-2">
											<Badge>
												{row.host ? `${row.host} ` : ""}
												{row.source}
											</Badge>
											<Badge>{row.outcome}</Badge>
										</div>
										<Text as="p">{row.title}</Text>
										{(row.source === "hook" || row.source === "supervisor") &&
											stale(row.at) && (
												<Text as="p" role="label" tone="secondary">
													Stale report; current source availability is unknown.
												</Text>
											)}
										<Text
											as="p"
											role="label"
											tone="secondary"
											className="break-all"
										>
											{row.sessionKey
												? `Session ${row.sessionKey}`
												: "Originating session unknown"}{" "}
											· {row.evidence}
										</Text>
										<div className="flex flex-wrap gap-3">
											{row.workItemId && (
												<Link
													href={`/work/items/${encodeURIComponent(row.workItemId)}`}
												>
													Work
												</Link>
											)}
											{row.attemptId && row.workItemId && (
												<Link
													href={`/work/items/${encodeURIComponent(row.workItemId)}#attempt-${encodeURIComponent(row.attemptId)}`}
												>
													Attempt {row.attemptId.slice(0, 8)}
												</Link>
											)}
											{row.requestId && (
												<Link
													href={`/work/interactions/${encodeURIComponent(row.requestId)}`}
												>
													Request
												</Link>
											)}
										</div>
									</div>
								</li>
							))}
						</Collection>
					)}
					{limit === 50 && query.data.nextBefore && (
						<Button variant="outline" onClick={() => setLimit(100)}>
							Show up to 100 reports
						</Button>
					)}
				</>
			)}
		</PageSection>
	);
}
