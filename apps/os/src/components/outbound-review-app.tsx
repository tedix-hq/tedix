import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { OutboundReviewConfig } from "@tedix/api-contract/schemas/os-outbound-review";
import { OutboundStateSchema } from "@tedix/api-contract/schemas/outbound";
import { OutboundReviewCard } from "@/components/outbound-card";
import { Input } from "@/components/kumo/input";
import { Link } from "@/components/kumo/link";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import { Text } from "@/components/kumo/text";
import { sentenceCase } from "@/lib/format";
import { osQuery } from "@/lib/os-query-options";
import { errorMessage } from "@/lib/orpc-error";

export function OutboundReviewApp({
	config,
}: {
	config: OutboundReviewConfig;
}) {
	const [status, setStatus] = useState<string>(config.initialStatus ?? "all");
	const [search, setSearch] = useState("");
	const query = useQuery(
		osQuery.workInteractions.outbound.list.queryOptions({
			input: { projectId: config.projectId, limit: config.limit },
		}),
	);
	const records = query.data?.filter(
		(record) =>
			(status === "all" || record.outbound.status === status) &&
			`${record.title} ${record.outbound.draft.recipient} ${record.outbound.draft.channel}`
				.toLocaleLowerCase()
				.includes(search.toLocaleLowerCase()),
	);
	return (
		<div
			className="grid min-w-0 gap-4"
			data-workspace-app-entry="outbound-review"
		>
			<div className="flex flex-wrap gap-3">
				<Input
					aria-label="Find drafts"
					placeholder="Find recipient, channel or title"
					value={search}
					onChange={(event) => setSearch(event.target.value)}
				/>
				<Select
					value={status}
					onValueChange={(value) => setStatus(value ?? "all")}
				>
					<SelectTrigger aria-label="Draft status">
						<SelectValue>
							{status === "all" ? "All statuses" : sentenceCase(status)}
						</SelectValue>
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="all">All statuses</SelectItem>
						{OutboundStateSchema.shape.status.options.map((value) => (
							<SelectItem key={value} value={value}>
								{sentenceCase(value)}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
			<Link href="/account/profile">
				Your style profile and last 10 approvals
			</Link>
			{query.isError ? (
				<Text role="body">{errorMessage(query.error)}</Text>
			) : query.isPending ? (
				<Text role="body">Loading drafts…</Text>
			) : (
				<>
					{records?.length === 0 && (
						<Text role="body">No drafts match these filters.</Text>
					)}
					{records?.map((record) => (
						<OutboundReviewCard
							key={`${record.workItemId}:${record.version}`}
							record={record}
						/>
					))}
					{query.data.length === config.limit && (
						<Text role="body" tone="secondary">
							Showing the latest {config.limit} drafts.
						</Text>
					)}
				</>
			)}
		</div>
	);
}
