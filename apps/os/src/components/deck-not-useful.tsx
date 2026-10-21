import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { DeckNotUsefulReason } from "@tedix/api-contract/schemas/deck-pipeline";
import { osApi } from "@/lib/api";
import { osQuery } from "@/lib/os-query-options";
import { OS_COPY } from "@/shared/os-copy";
import { Button } from "./kumo/button";
import { Text } from "./kumo/text";
import { InternalDecisionUndo } from "./internal-decision-undo";

const REASONS: DeckNotUsefulReason[] = [
	"already_decided",
	"expired",
	"agent_could_do",
	"duplicate",
	"not_for_me",
];

/** "Not useful" asks why; each chip teaches the Deck one specific fix. */
export function DeckNotUseful({
	request,
	disabled = false,
}: {
	request: { id: string; version: number };
	disabled?: boolean;
}) {
	const copy = OS_COPY.decisionDeck.notUseful;
	const client = useQueryClient();
	const [open, setOpen] = useState(false);
	const mark = useMutation({
		mutationFn: (reason: DeckNotUsefulReason) =>
			osApi.attention.markDeckCardNotUseful({
				requestId: request.id,
				expectedRequestVersion: request.version,
				reason,
			}),
		onSuccess: () =>
			Promise.all([
				client.invalidateQueries({ queryKey: osQuery.workInteractions.key() }),
				client.invalidateQueries({ queryKey: osQuery.attention.key() }),
				client.invalidateQueries({ queryKey: osQuery.learningFeedback.key() }),
			]),
	});
	if (mark.isSuccess)
		return (
			<div className="grid gap-1" role="status">
				<Text tone="secondary">{copy.done}</Text>
				{mark.data.rule && <Text>{copy.rule(mark.data.rule.sentence)}</Text>}
				{mark.data.undo && <InternalDecisionUndo target={mark.data.undo} />}
			</div>
		);
	return (
		<div className="grid gap-2" data-deck-not-useful>
			{open ? (
				<div
					role="group"
					aria-label={copy.prompt}
					className="flex flex-wrap gap-1"
				>
					{REASONS.map((reason) => (
						<Button
							key={reason}
							size="xs"
							variant="outline"
							disabled={disabled || mark.isPending}
							onClick={() => mark.mutate(reason)}
						>
							{copy.reasons[reason]}
						</Button>
					))}
				</div>
			) : (
				<Button
					variant="ghost"
					disabled={disabled}
					aria-expanded={open}
					onClick={() => setOpen(true)}
				>
					{copy.button}
				</Button>
			)}
			{mark.error && (
				<div role="alert">
					<Text tone="error">{mark.error.message}</Text>
				</div>
			)}
		</div>
	);
}
