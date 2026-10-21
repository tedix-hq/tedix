import { useRef, useState } from "react";
import { matchQuery, useQueryClient } from "@tanstack/react-query";
import { removeOptimisticDeckCard } from "@/lib/optimistic-deck-decision";
import {
	osQuery,
	osQueryKeys,
	pendingApprovalsQueryOptions,
} from "@/lib/os-query-options";
import { toast } from "./kumo/toast";

export function useDeckDecision() {
	const client = useQueryClient();
	const [optimisticIds, setOptimisticIds] = useState<string[]>([]);
	const inFlightDecisions = useRef(0);
	const [saving, setSaving] = useState(false);
	const forCard = (id: string | null, onSaved: () => void) => {
		return id !== null
			? async (
					write: () => Promise<unknown>,
					options?: { errorShownInline?: boolean },
				) => {
					inFlightDecisions.current++;
					setSaving(true);
					try {
						const result = await write();
						setOptimisticIds((ids) => [...ids, id]);
						onSaved();
						removeOptimisticDeckCard(
							client,
							[
								osQuery.workInteractions.listInbox.key(),
								osQuery.workApprovals.listInbox.key(),
								pendingApprovalsQueryOptions().queryKey,
							],
							id.replace(/^(work-approval:|approval:)/, ""),
						);
						return result;
					} catch (error) {
						if (!options?.errorShownInline)
							toast.error(
								error instanceof Error
									? error.message
									: "Your decision could not be saved. Try again.",
							);
						throw error;
					} finally {
						if (--inFlightDecisions.current === 0) {
							setSaving(false);
							const keys = [
								osQuery.workInteractions.key(),
								osQuery.workApprovals.key(),
								osQueryKeys.approvals(),
								osQueryKeys.approvalRules(),
								osQuery.learningFeedback.key(),
								osQuery.workItems.key(),
								osQuery.workFleet.key(),
								osQuery.workScheduler.key(),
								osQuery.workAgentSessions.attention.key(),
								osQueryKeys.agentSessionRequests(),
							];
							void client.invalidateQueries({
								predicate: (query) =>
									keys.some((queryKey) => matchQuery({ queryKey }, query)),
							});
						}
					}
				}
			: null;
	};
	return { optimisticIds, saving, forCard };
}
