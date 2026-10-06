import type { SkillRunStatus } from "@tedix/api-contract/contracts/cognitive";
import { Badge } from "@/components/kumo/badge";
import { sentenceCase } from "@/lib/format";
import { TONE_BADGE_VARIANTS } from "@/lib/status-tone";

export function runStatusTone(
	status: SkillRunStatus,
): "neutral" | "active" | "blocked" | "done" {
	switch (status) {
		case "queued":
		case "running":
		case "paused":
			return "active";
		case "failed":
			return "blocked";
		case "completed":
			return "done";
		default:
			return "neutral";
	}
}

export function RunStatusChip({ status }: { status: SkillRunStatus }) {
	const tone = runStatusTone(status);
	return (
		<Badge
			variant={TONE_BADGE_VARIANTS[tone]}
			data-tone={tone}
			data-status={status}
		>
			{sentenceCase(status)}
		</Badge>
	);
}
