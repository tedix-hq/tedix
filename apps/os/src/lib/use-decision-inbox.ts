import { useQuery } from "@tanstack/react-query";
import {
	decisionNeedsPerson,
	type DecisionDeckConfig,
} from "@tedix/api-contract/schemas/os-decision-deck";
import { osQuery, pendingApprovalsQueryOptions } from "@/lib/os-query-options";
import {
	isOpenRequestForYou,
	isDecidableWorkApproval,
} from "@/components/work-needs-you-count";
import { decisionEnvelope, decisionIsDue } from "@/lib/decision-deck";
import { useFactoryCardCount } from "@/lib/use-factory-card-count";

/** The header and Deck use the same recipient checks, project scope and bounded pages. */
export function useDecisionInbox(config?: DecisionDeckConfig) {
	const factories = useFactoryCardCount(config?.factorySources ?? []);
	const inbox = useQuery({
		...osQuery.workInteractions.listInbox.queryOptions({
			input: {
				projectId: config?.projectId,
				limit: config?.limit ?? 50,
				states: ["open"],
			},
		}),
		enabled: Boolean(config),
		refetchInterval: 30_000,
	});
	const approvals = useQuery({
		...pendingApprovalsQueryOptions(),
		enabled: Boolean(config) && !config?.projectId,
		refetchInterval: 30_000,
	});
	const workApprovals = useQuery({
		...osQuery.workApprovals.listInbox.queryOptions({
			input: {
				projectId: config?.projectId,
				limit: config?.limit ?? 50,
				statuses: ["pending"],
			},
		}),
		enabled: Boolean(config),
		refetchInterval: 30_000,
	});
	const requests = (inbox.data?.data ?? []).filter((row) => {
		const decision = decisionEnvelope(row.request.metadata);
		return (
			isOpenRequestForYou(row) &&
			decisionIsDue(row.request, new Date()) &&
			row.canRespond &&
			(!decision || decisionNeedsPerson(decision))
		);
	});
	const work = (workApprovals.data?.data ?? []).filter(isDecidableWorkApproval);
	const runtime = !config?.projectId
		? (approvals.data?.data ?? []).filter((row) => row.status === "pending")
		: [];
	return {
		inbox,
		approvals,
		workApprovals,
		requests,
		work,
		count: requests.length + work.length + runtime.length + factories.count,
		queuePending:
			inbox.isPending ||
			workApprovals.isPending ||
			(!config?.projectId && approvals.isPending),
		queueFailed:
			inbox.isError ||
			workApprovals.isError ||
			(!config?.projectId && approvals.isError),
		pending:
			factories.pending ||
			inbox.isPending ||
			workApprovals.isPending ||
			(!config?.projectId && approvals.isPending),
		failed:
			factories.failed ||
			inbox.isError ||
			workApprovals.isError ||
			(!config?.projectId && approvals.isError),
		more: Boolean(
			factories.more ||
			inbox.data?.hasMore ||
			workApprovals.data?.hasMore ||
			(!config?.projectId && approvals.data?.pagination.hasMore),
		),
	};
}
