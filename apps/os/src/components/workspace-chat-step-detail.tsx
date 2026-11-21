import { ArrowClockwise, Check, Copy } from "@phosphor-icons/react";
import { useContext, useEffect, useRef, useState } from "react";
import { ChatOutputLinkContext } from "@/components/chat-markdown";
import { Button } from "@/components/kumo/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/kumo/collapsible";
import { Text } from "@/components/kumo/text";
import { toast } from "@/components/kumo/toast";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/kumo/tooltip";
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
	// A call without arguments, such as listing apps, has no request to show.
	return text && text !== "{}" && text !== "[]"
		? { label: "Request", text }
		: null;
}

/**
 * What went wrong in a failed step: the plain line, and the error as it was
 * recorded. Older events carry only the recorded error. The step's row
 * already says "Didn't work", so that line is not repeated here.
 */
function stepError(step: ChatStep): { plain?: string; raw?: string } {
	if (step.status !== "error") return {};
	if (!step.detail) return { raw: step.error };
	return step.error && step.error !== "Didn't work"
		? { plain: step.error, raw: step.detail }
		: { raw: step.detail };
}

/** True when the step has code, a request, a result or an error to show. */
export function stepHasDetail(step: ChatStep): boolean {
	return (
		stepRequest(step) !== null ||
		Boolean(step.result) ||
		Boolean(stepError(step).raw)
	);
}

/** Longer raw text than this waits behind "Show raw output". */
const RAW_PREVIEW_CHARS = 240;

function RawText({ label, text }: { label: string; text: string }) {
	const long = text.length > RAW_PREVIEW_CHARS || text.split("\n").length > 4;
	return (
		<>
			<Text role="caption" tone="secondary">
				{label}
			</Text>
			{long ? (
				<Collapsible>
					<CollapsibleTrigger className="workspace-chat-raw-toggle">
						Show raw output
					</CollapsibleTrigger>
					<CollapsibleContent>
						<pre>{text}</pre>
					</CollapsibleContent>
				</Collapsible>
			) : (
				<pre>{text}</pre>
			)}
		</>
	);
}

/**
 * What one step ran, the start of what came back, and what went wrong. All
 * arrive already cut to a few thousand characters; long text stays folded
 * and each block scrolls inside a fixed height.
 */
export function StepDetail({ step }: { step: ChatStep }) {
	const request = stepRequest(step);
	const error = stepError(step);
	if (!request && !step.result && !error.raw) return null;
	return (
		<div
			className="workspace-chat-step-detail"
			data-testid="workspace-chat-step-detail"
		>
			{error.plain ? <Text role="caption">{error.plain}</Text> : null}
			{request ? <RawText label={request.label} text={request.text} /> : null}
			{step.result ? <RawText label="Result" text={step.result} /> : null}
			{error.raw ? <RawText label="Error" text={error.raw} /> : null}
		</div>
	);
}

/**
 * Under a finished reply, shown on hover or keyboard focus: when it began
 * (its tooltip says what was recorded), copy, and send the message again.
 */
export function ReplyActions({
	text,
	startedAt,
	details,
	onRetry,
}: {
	/** The finished reply; `null` offers no copy. */
	text: string | null;
	startedAt: number;
	details: string[];
	onRetry: (() => void) | null;
}) {
	const [copied, setCopied] = useState(false);
	const reset = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (reset.current) clearTimeout(reset.current);
		},
		[],
	);
	const time = Number.isFinite(startedAt)
		? new Date(startedAt).toLocaleTimeString([], {
				hour: "2-digit",
				minute: "2-digit",
			})
		: null;
	if (!time && !text && !onRetry) return null;
	return (
		<div
			className="workspace-chat-reply-hover"
			data-testid="workspace-chat-reply-actions-hover"
		>
			{time && details.length ? (
				<Tooltip>
					<TooltipTrigger
						render={
							<Button
								data-testid="workspace-chat-turn-time"
								size="xs"
								variant="ghost"
							/>
						}
					>
						{time}
					</TooltipTrigger>
					<TooltipContent align="start" side="bottom">
						{details.map((detail) => (
							<span key={detail}>{detail}</span>
						))}
					</TooltipContent>
				</Tooltip>
			) : time ? (
				<Text
					as="span"
					role="caption"
					tone="secondary"
					data-testid="workspace-chat-turn-time"
				>
					{time}
				</Text>
			) : null}
			{text ? (
				<Button
					aria-label={copied ? "Copied" : "Copy"}
					icon={copied ? <Check size={16} /> : <Copy size={16} />}
					onClick={async () => {
						try {
							await navigator.clipboard.writeText(text);
							setCopied(true);
							toast.success("Copied");
							if (reset.current) clearTimeout(reset.current);
							reset.current = setTimeout(() => setCopied(false), 2000);
						} catch {
							toast.error("Could not copy response");
						}
					}}
					size="icon-sm"
					title={copied ? "Copied" : "Copy"}
					variant="ghost"
				/>
			) : null}
			{onRetry ? (
				<Button
					aria-label="Retry"
					icon={<ArrowClockwise size={16} />}
					onClick={onRetry}
					size="icon-sm"
					title="Send your message again"
					variant="ghost"
				/>
			) : null}
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

/**
 * Opens the app an approved change created. Inside a workspace it opens in
 * the workspace's own pane; elsewhere it goes to the app in its workspace.
 */
export function OpenCreatedApp({
	workspaceId,
	appId,
	name,
}: {
	workspaceId: string;
	appId: string;
	name: string;
}) {
	const { openEditor } = useContext(ChatOutputLinkContext);
	return (
		<Button
			aria-label={`Open preview for ${name}`}
			onClick={() => {
				if (openEditor) openEditor(appId);
				else
					window.location.assign(
						`/workspace/${encodeURIComponent(workspaceId)}?workpiece=gadget:${encodeURIComponent(appId)}&pane=workpiece`,
					);
			}}
			size="sm"
			variant="outline"
		>
			Open preview
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
		>
			<Tooltip>
				<TooltipTrigger render={<span tabIndex={0} />}>
					Earlier messages were summarised
				</TooltipTrigger>
				<TooltipContent>
					The agent now works from a summary of the earlier messages. They are
					still shown here.
				</TooltipContent>
			</Tooltip>
		</div>
	);
}
