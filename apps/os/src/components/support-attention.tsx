import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { osQuery } from "@/lib/os-query-options";
import { osApi } from "@/lib/api";
import { Button } from "@/components/kumo/button";
import {
	Card,
	CardHeader,
	CardTitle,
	CardContent,
} from "@/components/kumo/card";
import { Link } from "@/components/kumo/link";
import { Text } from "@/components/kumo/text";
import { absoluteTime } from "@/lib/time";

export function SupportAttention() {
	const cache = useQueryClient(),
		[staff, setStaff] = useState(false);
	const mine = useQuery({
		...osQuery.support.mine.queryOptions({ input: { limit: 50 } }),
		refetchInterval: 30_000,
		retry: false,
	});
	const queue = useQuery({
		...osQuery.support.queue.queryOptions({
			input: { limit: 100, includeClosed: false },
		}),
		enabled: staff && mine.data?.canReview === true,
		refetchInterval: 30_000,
		retry: false,
	});
	const publish = useMutation({
		mutationFn: (input: {
			ticketId: string;
			expectedVersion: number;
			idempotencyKey: string;
		}) => osApi.support.publish(input),
		onSuccess: () =>
			cache.invalidateQueries({
				queryKey: osQuery.support.key({ type: "query" }),
			}),
	});
	const items = staff
		? (queue.data ?? []).map((row) => row.receipt)
		: (mine.data?.items ?? []);
	return (
		<Card>
			<CardHeader>
				<CardTitle>Support</CardTitle>
				{mine.data?.canReview ? (
					<Button variant="ghost" onClick={() => setStaff(!staff)}>
						{staff ? "My tickets" : "Review support queue"}
					</Button>
				) : null}
			</CardHeader>
			<CardContent className="grid gap-4">
				{mine.isError ? (
					<Text tone="secondary">
						Support tickets are unavailable. Use Get help to retry.
					</Text>
				) : null}
				{queue.isError || publish.isError ? (
					<p role="alert">{queue.error?.message ?? publish.error?.message}</p>
				) : null}
				{items.map((row) => {
					const draft = staff
						? queue.data?.find((x) => x.receipt.ticketId === row.ticketId)
								?.draft
						: null;
					return (
						<article key={row.ticketId} className="grid gap-1">
							<Link href={row.statusUrl}>{row.title}</Link>
							<Text tone="secondary">
								{row.owner} · {row.status} · waiting on {row.waitingOn} · next
								update {absoluteTime(row.nextUpdateDue)} ·{" "}
								{row.reporterVerification}
							</Text>
							{row.publicUpdates.at(-1) ? (
								<p>{row.publicUpdates.at(-1)?.body}</p>
							) : null}
							{draft ? (
								<>
									<strong>Draft — not sent</strong>
									<p>{draft.body}</p>
									<p>{draft.nextStep}</p>
									{draft.evidence.map((ref) => (
										<Text key={ref}>{ref}</Text>
									))}
									<Button
										disabled={publish.isPending}
										onClick={() =>
											publish.mutate({
												ticketId: row.ticketId,
												expectedVersion: row.version,
												idempotencyKey: `publish:${row.ticketId}:${row.version}`,
											})
										}
									>
										Publish this answer to the reporter
									</Button>
								</>
							) : null}
						</article>
					);
				})}
				{!mine.isError && !items.length ? (
					<Text tone="secondary">
						{mine.isPending
							? "Loading tickets…"
							: "No support tickets to review."}
					</Text>
				) : null}
				{items.length === (staff ? 100 : 50) ? (
					<Text tone="secondary">
						Showing the first page. Open the Support project for the complete
						Work history.
					</Text>
				) : null}
			</CardContent>
		</Card>
	);
}
