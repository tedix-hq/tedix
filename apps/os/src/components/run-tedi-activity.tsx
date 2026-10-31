import { useQuery } from "@tanstack/react-query";
import type { SkillWorkflowStepTediActivitySchema } from "@tedix/api-contract/schemas/cognitive";
import type { z } from "zod";
import { LoadError } from "@/components/kumo/alert";
import { Text } from "@/components/kumo/text";
import { RunStepResult } from "@/components/run-step-result";
import { osQuery } from "@/lib/os-query-options";

type Activity = z.infer<typeof SkillWorkflowStepTediActivitySchema>;

export function LinkedTediActivity({
	runId,
	executionEpoch,
	path,
	attempt,
}: {
	runId: string;
	executionEpoch: number;
	path: string;
	attempt: number | undefined;
}) {
	const activity = useQuery({
		...osQuery.skills.getWorkflowStepTediActivity.queryOptions({
			input: { runId, executionEpoch, path, attempt: attempt ?? 1 },
		}),
		enabled: typeof attempt === "number",
		retry: false,
		staleTime: 0,
		refetchOnMount: "always",
	});
	if (typeof attempt !== "number")
		return (
			<Text as="p" tone="secondary">
				Linked task activity is unavailable for this historical receipt.
			</Text>
		);
	if (activity.isPending || activity.isFetching)
		return (
			<Text as="p" tone="secondary">
				Loading linked task activity…
			</Text>
		);
	if (activity.isError)
		return (
			<LoadError
				title="Linked task activity unavailable"
				error={activity.error}
				onRetry={() => activity.refetch()}
				retrying={activity.isFetching}
			/>
		);
	return <LinkedTediActivityDetails activity={activity.data} />;
}

export function LinkedTediActivityDetails({
	activity,
}: {
	activity: Activity;
}) {
	if (activity.status === "redacted")
		return (
			<Text as="p" tone="secondary">
				Linked task activity is withheld.
			</Text>
		);
	if (
		activity.status !== "available" ||
		activity.activitySource !== "linked_tedi_run"
	)
		return (
			<Text as="p" tone="secondary">
				Linked task activity is unavailable. {activity.reason}
			</Text>
		);
	return (
		<div className="grid gap-3">
			<Text as="p" tone="secondary">
				Recorded activity from the linked assistant task; it may also be
				referenced by other calls.
			</Text>
			{activity.runStatus && (
				<Text as="p" tone="secondary">
					Task status: {activity.runStatus.replaceAll("_", " ")}
				</Text>
			)}
			{activity.actions.length > 0 ? (
				<ul className="m-0 grid gap-2 pl-5">
					{activity.actions.slice(0, 50).map((action) => (
						<li key={action.id}>
							{action.kind
								.replace("tool.", "Tool ")
								.replace("subagent.", "Delegation ")}
							{action.toolName ? ` · ${action.toolName}` : ""}
						</li>
					))}
				</ul>
			) : (
				<Text as="p" tone="secondary">
					No tool or delegation events were recorded in the available activity.
				</Text>
			)}
			{(activity.truncated || activity.actions.length > 50) && (
				<Text as="p" tone="secondary">
					Only part of the linked task activity is shown.
				</Text>
			)}
			<Text as="h4" role="label" weight="medium">
				Linked task result
			</Text>
			{activity.finalResult.status === "redacted" ? (
				<Text as="p" tone="secondary">
					The linked task result is withheld.
				</Text>
			) : activity.runStatus === "completed" &&
			  activity.finalResult.status === "available" &&
			  typeof activity.finalResult.content === "string" ? (
				<>
					<RunStepResult value={activity.finalResult.content} />
					{activity.finalResult.truncated && (
						<Text as="p" tone="secondary">
							Only part of the linked task result was recorded here.
						</Text>
					)}
				</>
			) : (
				<Text as="p" tone="secondary">
					No final result is available in this record.
				</Text>
			)}
		</div>
	);
}
