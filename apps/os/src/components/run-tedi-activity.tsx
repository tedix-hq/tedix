import { useQuery } from "@tanstack/react-query";
import type { SkillWorkflowStepTediActivitySchema } from "@tedix/api-contract/schemas/cognitive";
import type { z } from "zod";
import { LoadError } from "@/components/kumo/alert";
import { Text } from "@/components/kumo/text";
import { RunStepResult } from "@/components/run-step-result";
import { plainToolTitle } from "@/lib/approval-titles";
import { osQuery } from "@/lib/os-query-options";

type Activity = z.infer<typeof SkillWorkflowStepTediActivitySchema>;

function activityToolLabel(name: string | undefined) {
	if (
		!name ||
		!/^[a-z][a-z0-9_.-]{0,99}$/i.test(name) ||
		/[0-9a-f]{8}-[0-9a-f-]{27}|[0-9a-f]{16,}/i.test(name)
	)
		return "Tool";
	return plainToolTitle(name);
}

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
				Activity unavailable for this older run.
			</Text>
		);
	if (activity.isPending || activity.isFetching)
		return (
			<Text as="p" tone="secondary">
				Loading assistant activity…
			</Text>
		);
	if (activity.isError)
		return (
			<LoadError
				title="Assistant activity unavailable"
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
				Assistant activity is withheld.
			</Text>
		);
	if (
		activity.status !== "available" ||
		activity.activitySource !== "linked_tedi_run"
	)
		return (
			<Text as="p" tone="secondary">
				{/historical|no verified/i.test(activity.reason ?? "")
					? "Activity unavailable for this older run."
					: "Assistant activity is unavailable."}
			</Text>
		);
	return (
		<div className="grid gap-3">
			<Text as="h4" role="label" weight="medium">
				Assistant activity
			</Text>
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
							{action.kind.startsWith("tool.")
								? activityToolLabel(action.toolName)
								: "Delegation"}
							{` · ${action.kind.split(".")[1]}`}
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
					Only part of the assistant activity is shown.
				</Text>
			)}
			<Text as="h4" role="label" weight="medium">
				Answer
			</Text>
			{activity.finalResult.status === "redacted" ? (
				<Text as="p" tone="secondary">
					The answer is withheld.
				</Text>
			) : activity.runStatus === "completed" &&
			  activity.finalResult.status === "available" &&
			  typeof activity.finalResult.content === "string" ? (
				<>
					<RunStepResult value={activity.finalResult.content} />
					{activity.finalResult.truncated && (
						<Text as="p" tone="secondary">
							Only part of the answer was saved.
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
