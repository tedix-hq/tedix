import type { z } from "zod";
import type { ReopenDelegatedApprovalInputSchema } from "@tedix/api-contract/schemas/delegated-approvals";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { osApi } from "@/lib/api";
import { osQuery } from "@/lib/os-query-options";
import { Button } from "@/components/kumo/button";
import { Link } from "@/components/kumo/link";

/** Configured inside the Activity app; no separate route or navigation tab. */
export function DecidedForYou() {
	const [before, setBefore] = useState<string>();
	const client = useQueryClient();
	const decisions = useQuery(
		osQuery.workInteractions.listDecidedForYou.queryOptions({
			input: { limit: 25, ...(before ? { before } : {}) },
		}),
	);
	const [reopened, setReopened] = useState<Record<string, string>>({});
	const reopen = useMutation({
		mutationFn: (input: z.input<typeof ReopenDelegatedApprovalInputSchema>) =>
			osApi.workInteractions.reopenDelegatedApproval(input),
		onSuccess: (request, { requestId }) => {
			setReopened((previous) => ({ ...previous, [requestId]: request.id }));
			void client.invalidateQueries({
				queryKey: osQuery.workInteractions.key(),
			});
		},
	});
	return (
		<section
			aria-labelledby="decided-for-you-heading"
			className="space-y-3 p-4"
		>
			<h2 id="decided-for-you-heading" className="text-lg font-semibold">
				Decided for you
			</h2>
			{decisions.isPending && <p>Loading decisions…</p>}
			{decisions.isError && <p role="alert">Decisions could not be loaded.</p>}
			{decisions.data?.data.length === 0 && <p>No delegated decisions yet.</p>}
			<ul className="space-y-3">
				{decisions.data?.data.map((item) => (
					<li
						key={item.id}
						className="space-y-1 rounded-lg border border-kumo-line p-3"
					>
						<p>
							<strong>{item.receipt.actorName}</strong> decided: {item.subject}
						</p>
						<p>{item.decision}</p>
						<p>Why: {item.receipt.reason}</p>
						<Link
							href={
								item.source === "runtime"
									? "/work/approvals"
									: `/work/interactions/${item.requestId}`
							}
						>
							Decision record
						</Link>
						{reopened[item.requestId] ? (
							<Link href={`/work/interactions/${reopened[item.requestId]}`}>
								Open review
							</Link>
						) : (
							<Button
								size="sm"
								disabled={reopen.isPending}
								onClick={() =>
									reopen.mutate({
										requestId: item.requestId,
										source: item.source,
									})
								}
							>
								Reopen
							</Button>
						)}
					</li>
				))}
			</ul>
			{reopen.isError && (
				<p role="alert">The decision could not be reopened.</p>
			)}
			{before && (
				<Button size="sm" onClick={() => setBefore(undefined)}>
					Newest
				</Button>
			)}
			{decisions.data?.nextBefore && (
				<Button
					size="sm"
					onClick={() => setBefore(decisions.data!.nextBefore!)}
				>
					Older decisions
				</Button>
			)}
		</section>
	);
}
