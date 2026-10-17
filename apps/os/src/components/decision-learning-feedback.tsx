import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { osApi } from "@/lib/api";
import { osQuery } from "@/lib/os-query-options";
import { OS_COPY } from "@/shared/os-copy";
import { Button } from "@/components/kumo/button";
import { Text } from "@/components/kumo/text";
import { toast } from "@/components/kumo/toast";

/** Learning corrections undo evidence only; canonical decisions keep their own controls. */
export function DecisionLearningFeedback() {
	const query = useQuery({
		...osQuery.learningFeedback.model.queryOptions({ input: {} }),
		refetchInterval: 60000,
	});
	const client = useQueryClient();
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState("");
	const model = query.data;
	const last = model?.config.enabled ? model.receipts[0] : undefined;
	useEffect(() => setMessage(""), [last?.eventId]);
	if (!last) return null;
	const copy = OS_COPY.learning;
	const subject = last.classId.replaceAll(/[-_:.]/g, " ");
	const preference = model?.preferences.find((p) => p.classId === last.classId);
	const learned =
		preference && last.eventKind === "edited"
			? copy.preference(preference.sentence.replaceAll(last.classId, subject))
			: last.shortened
				? copy.shorter(subject)
				: last.choice === "later" || last.choice === "skip"
					? copy.later(subject)
					: ["rejected", "ignored"].includes(last.eventKind)
						? copy.less(subject)
						: copy.noted(subject);
	return (
		<div
			className="flex flex-wrap items-center gap-x-3 gap-y-1 text-kumo-secondary"
			role="status"
			aria-live="polite"
		>
			<Text>{message || learned}</Text>
			<Button
				variant="ghost"
				size="sm"
				disabled={busy}
				onClick={async () => {
					setBusy(true);
					try {
						await osApi.learningFeedback.correct({
							eventId: last.eventId,
							clientEventId: crypto.randomUUID(),
						});
						setMessage(copy.undone);
						toast.success(copy.undone);
						await client.invalidateQueries({
							queryKey: osQuery.learningFeedback.key(),
						});
					} catch {
						setMessage(copy.failed);
					} finally {
						setBusy(false);
					}
				}}
			>
				{copy.undo}
			</Button>
		</div>
	);
}
