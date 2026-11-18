import { useContext } from "react";
import { ChatMessageActions } from "@/components/chat-message-actions";
import { ChatOutputLinkContext } from "@/components/chat-markdown";
import { Button } from "@/components/kumo/button";
import { Text } from "@/components/kumo/text";
import type { ChatStep } from "@/lib/workspace-chat-state";

/** What a step ran: its code, or the request it made. */
function stepRequest(
	step: ChatStep,
): { label: "Code" | "Request"; text: string } | null {
	const input = step.input;
	if (input === undefined || input === null) return null;
	if (typeof input === "object" && !Array.isArray(input)) {
		const code = (input as Record<string, unknown>).code;
		if (step.kind === "code" && typeof code === "string")
			return code ? { label: "Code", text: code } : null;
	}
	const text =
		typeof input === "string" ? input : JSON.stringify(input, null, 2);
	return text ? { label: "Request", text } : null;
}

/** True when the step has code, a request or a result to show. */
export function stepHasDetail(step: ChatStep): boolean {
	return stepRequest(step) !== null || Boolean(step.result);
}

/**
 * What one step ran and the start of what came back. Both arrive already cut
 * to a few thousand characters; each block scrolls inside a fixed height.
 */
export function StepDetail({ step }: { step: ChatStep }) {
	const request = stepRequest(step);
	if (!request && !step.result) return null;
	return (
		<div
			className="workspace-chat-step-detail"
			data-testid="workspace-chat-step-detail"
		>
			{request ? (
				<>
					<Text role="caption" tone="secondary">
						{request.label}
					</Text>
					<pre>{request.text}</pre>
				</>
			) : null}
			{step.result ? (
				<>
					<Text role="caption" tone="secondary">
						Result
					</Text>
					<pre>{step.result}</pre>
				</>
			) : null}
		</div>
	);
}

/** Copies one finished agent reply. Always visible on the newest reply. */
export function ReplyCopy({ text, latest }: { text: string; latest: boolean }) {
	return (
		<div
			className="workspace-chat-reply-copy"
			data-testid="workspace-chat-reply-copy"
		>
			<ChatMessageActions content={text} latest={latest} />
		</div>
	);
}

/**
 * Opens the file an applied change saved. Inside a workspace it opens in the
 * workspace's own pane; elsewhere it goes to the file's page.
 */
export function OpenChangedFile({
	outputId,
	title,
}: {
	outputId: string;
	title: string | null;
}) {
	const { openOutput } = useContext(ChatOutputLinkContext);
	return (
		<Button
			aria-label={title ? `Open ${title}` : "Open the file"}
			onClick={() => {
				if (openOutput) openOutput(outputId);
				else window.location.assign(`/outputs/${encodeURIComponent(outputId)}`);
			}}
			size="sm"
			variant="outline"
		>
			Open
		</Button>
	);
}

/** Marks the turn before which earlier messages were summarised. */
export function SummarisedMarker() {
	return (
		<div
			className="workspace-chat-summarised"
			data-testid="workspace-chat-summarised"
			role="note"
			title="The agent now works from a summary of the earlier messages. They are still shown here."
		>
			<span>Earlier messages were summarised</span>
		</div>
	);
}
