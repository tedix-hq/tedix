import { useMutation, useQueryClient } from "@tanstack/react-query";
import { osApi } from "@/lib/api";
import { osQuery } from "@/lib/os-query-options";
import { Button } from "./kumo/button";
import { Text } from "./kumo/text";

export function InternalDecisionUndo({
	target,
	disabled = false,
}: {
	target: {
		requestId: string;
		expectedRequestVersion: number;
		expectedRevision: number;
		restoreRevision: number;
	};
	disabled?: boolean;
}) {
	const client = useQueryClient();
	const undo = useMutation({
		mutationFn: () => osApi.workInteractions.reviseCard(target),
		onSuccess: () =>
			Promise.all([
				client.invalidateQueries({ queryKey: osQuery.workInteractions.key() }),
				client.invalidateQueries({ queryKey: osQuery.attention.key() }),
				client.invalidateQueries({ queryKey: osQuery.workItems.key() }),
				client.invalidateQueries({ queryKey: osQuery.learningFeedback.key() }),
				client.invalidateQueries({ queryKey: osQuery.workAgentSessions.key() }),
			]),
	});
	return (
		<div className="grid gap-2">
			<Button
				size="sm"
				variant="ghost"
				disabled={disabled || undo.isPending || undo.isSuccess}
				onClick={() => undo.mutate()}
			>
				{undo.isSuccess ? "Undone" : "Undo"}
			</Button>
			{undo.error && (
				<div role="alert">
					<Text tone="error">
						{undo.error.message ||
							"Could not undo this action. Refresh and try again."}
					</Text>
				</div>
			)}
		</div>
	);
}
