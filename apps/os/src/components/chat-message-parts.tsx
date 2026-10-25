/** Presentational chat pieces: message bubble, widgets, banners, indicators and starter prompts. */
import { CHAT_STARTERS } from "@/components/chat-composer-options";
import { isLocalWorkersAi } from "@/lib/local-inference";
import {
	ArrowCounterClockwise,
	ArrowDown,
	FolderSimple,
} from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import type {
	HomeMessage,
	HomeRun,
} from "@tedix/api-contract/schemas/kernel-runtime";
import { Fragment } from "react";
import {
	Alert,
	AlertAction,
	AlertDescription,
	AlertTitle,
} from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
import { Loader } from "@/components/kumo/loader";
import { Text } from "@/components/kumo/text";
import { Badge } from "@/components/kumo/badge";
import { ChatMessageActions } from "@/components/chat-message-actions";
import { ChatMarkdown } from "@/components/chat-markdown";
import { StructuredChatContent } from "@/components/chat-structured-content";
import { Surface } from "@/components/kumo/surface";
import { sanitizeUntrustedText } from "@/lib/untrusted-text";
import { CostChip } from "@/components/cost-chip";
import { kernelUsageReading } from "@/lib/cost-reading";
import {
	PROVISIONAL_SEND_LABEL,
	type ProvisionalSend,
} from "@/lib/provisional-send";
import { useOsFormattingPreferences } from "@/lib/format";
import { absoluteTime, relativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { WidgetFrame } from "@/components/widget-frame";
import { chatWidgetTargetsFromMetadata } from "@/lib/chat-widget-targets";
import {
	directReadError,
	directReadResult,
} from "@/components/chat-direct-read";
import {
	type ChatContext,
	decodeChatContext,
} from "@/components/chat-transcript";

/**
 * Renders a direct-read tool result. Every string here is tool-authored — the
 * object keys as much as the values — so each goes through
 * `sanitizeUntrustedText` at the render site, per the rule in
 * `@/lib/untrusted-text`: a sanitizer a component has to remember to call is
 * one that eventually gets skipped, and this component was the proof.
 *
 * React already escapes markup on this path, so the residual risk is the
 * invisible characters — a U+202E dropped into a key or value reorders the
 * operator's own reading flow without changing the string.
 *
 * Exported for the hostile-string test.
 */
export function StructuredReadResult({ value }: { value: unknown }) {
	if (Array.isArray(value)) {
		return (
			<div className="grid gap-2">
				{value.slice(0, 20).map((item, index) => (
					<Surface key={index} className="p-2">
						<StructuredReadResult value={item} />
					</Surface>
				))}
			</div>
		);
	}
	if (value && typeof value === "object") {
		return (
			<dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[minmax(8rem,auto)_1fr]">
				{Object.entries(value as Record<string, unknown>)
					.slice(0, 40)
					.map(([key, item]) => (
						<Fragment key={key}>
							<Text as="dt" role="label" tone="secondary" weight="medium">
								{sanitizeUntrustedText(key)}
							</Text>
							<Text as="dd" role="body" className="m-0 min-w-0 break-words">
								{item && typeof item === "object" ? (
									<StructuredReadResult value={item} />
								) : (
									sanitizeUntrustedText(String(item ?? "—"))
								)}
							</Text>
						</Fragment>
					))}
			</dl>
		);
	}
	return <span>{sanitizeUntrustedText(String(value ?? "—"))}</span>;
}

// ---------------------------------------------------------------------------
// Pure presentational subcomponents (exported for tests)
// ---------------------------------------------------------------------------

/**
 * One transcript entry. Per the design brief the two roles get asymmetric
 * treatments: user turns are right-aligned bubbles (one grey step below the
 * canvas, 24px radius with a squared bottom-right corner, capped at
 * min(680px, 78%)); assistant turns are no bubble — plain text directly on
 * the canvas at full column width.
 */
export function ChatMessageBubble({
	message,
	showExecutionLink = true,
	latest = false,
	context,
	workspaceId,
	runActive = false,
}: {
	message: HomeMessage;
	showExecutionLink?: boolean;
	latest?: boolean;
	context?: ChatContext;
	workspaceId?: string;
	/** The message's run (or a run it delegated to) is still active. */
	runActive?: boolean;
}) {
	useOsFormattingPreferences();
	const isUser = message.role === "user";
	const decoded = decodeChatContext(message.content);
	const structuredResult = directReadResult(message);
	const readFailure = directReadError(message);
	const emptyLabel = emptyMessageLabel(message, runActive);
	return (
		<li
			data-role={message.role}
			className={cn(
				"group/message flex w-full min-w-0 max-w-full",
				isUser ? "justify-end" : "justify-start",
			)}
		>
			<div
				className={cn(
					"flex min-w-0 flex-col gap-1",
					isUser
						? "max-w-[min(680px,78%)] rounded-[24px] rounded-br-lg bg-kumo-fill px-4 py-2.5"
						: "max-w-full py-0.5",
				)}
			>
				{decoded.context &&
				!(
					(decoded.context.kind === "workspace" &&
						decoded.context.id === workspaceId) ||
					(decoded.context.kind === context?.kind &&
						decoded.context.id === context.id)
				) ? (
					<Badge variant="outline" className="w-fit gap-1.5">
						<FolderSimple size={13} aria-hidden />
						{decoded.context.kind}: {decoded.context.label}
					</Badge>
				) : null}
				{decoded.content ? (
					isUser ? (
						<ChatMarkdown content={decoded.content} preserveLineBreaks />
					) : (
						<StructuredChatContent content={decoded.content} />
					)
				) : (
					<Text role="label" tone="secondary" className="m-0">
						{emptyLabel}
					</Text>
				)}
				{structuredResult !== null ? (
					<Surface className="mt-2 p-3">
						<StructuredReadResult value={structuredResult} />
					</Surface>
				) : null}
				{readFailure ? (
					<Alert variant="destructive" className="mt-2">
						<AlertTitle>
							{readFailure.kind === "connection_required"
								? "Connection required"
								: "Connected app read failed"}
						</AlertTitle>
						<AlertDescription>
							{readFailure.retryable
								? "This failure is safe to retry with the same request."
								: "Review the connection or tool policy before trying again."}
						</AlertDescription>
						{readFailure.connectProviderId ? (
							<AlertAction>
								<Button
									size="sm"
									variant="outline"
									render={
										<Link
											to="/admin/connections"
											search={{
												q: "",
												status: "used",
												connect: readFailure.connectProviderId,
											}}
										/>
									}
								>
									Connect app
								</Button>
							</AlertAction>
						) : null}
					</Alert>
				) : null}
				<Text
					as="span"
					role="label"
					tone="secondary"
					className={cn(
						"flex flex-wrap items-center gap-2 tabular-nums",
						isUser && "justify-end",
					)}
				>
					<time
						dateTime={message.createdAt}
						title={absoluteTime(message.createdAt)}
					>
						{relativeTime(message.createdAt)}
					</time>
					{message.status === "failed" ? (
						<span className="text-kumo-danger">failed</span>
					) : null}
					{message.status === "canceled" ? <span>canceled</span> : null}
					{!isUser ? (
						<ChatMessageActions
							content={decoded.content}
							runId={showExecutionLink ? message.runId : undefined}
							latest={latest}
						/>
					) : null}
				</Text>
			</div>
		</li>
	);
}

/**
 * Truthful fallback for durable rows whose useful payload is not prose. The
 * row remains visible because its timestamp and execution link are canonical;
 * only the implementation-residue `(no text)` label is replaced.
 */
function emptyMessageLabel(message: HomeMessage, runActive: boolean): string {
	const attachmentCount = message.attachments?.length ?? 0;
	if (attachmentCount > 0) {
		return `${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}`;
	}
	if (chatWidgetTargetsFromMetadata(message.metadata).length > 0) {
		return "Interactive result attached";
	}
	if (directReadResult(message) !== null)
		return "Connected app result attached";
	if (directReadError(message)) return "Connected app read failed";
	if (message.role === "user") return "Message sent without text";
	if (message.role === "tool") return "Tool result recorded";
	if (message.role === "runtime") return "Execution update recorded";
	if (message.role === "system") return "System context recorded";
	if (message.status === "failed") {
		return "Response failed before text was produced";
	}
	if (message.status === "canceled") {
		return "Response canceled before text was produced";
	}
	// A row can read completed while its run, or a run it delegated to, still
	// works: only a terminal run has finished without a written response.
	if (
		message.status === "pending" ||
		message.status === "streaming" ||
		runActive
	) {
		return "Response is still being prepared";
	}
	return message.runId
		? "Execution completed without a written response"
		: "No written response";
}

/** MCP Apps returned with a durable assistant turn, rendered in Kumo chat chrome. */
export function ChatMessageWidgets({
	message,
	onFollowUp,
}: {
	message: HomeMessage;
	onFollowUp?: (message: string) => void;
}) {
	if (message.role !== "assistant") return null;
	const targets = chatWidgetTargetsFromMetadata(message.metadata);
	if (targets.length === 0) return null;

	return (
		<>
			{targets.map((target) => (
				<li
					key={target.resourceUri}
					data-slot="mcp-app-widget"
					className="flex min-w-0 max-w-full justify-start overflow-hidden"
				>
					<div className="min-w-0 max-w-full flex-1 overflow-hidden">
						<WidgetFrame
							appSlug={target.appSlug}
							resourceUri={target.resourceUri}
							title={`${target.appSlug} app`}
							toolInput={target.toolInput}
							toolResult={target.toolResult}
							onFollowUp={onFollowUp}
						/>
					</div>
				</li>
			))}
		</>
	);
}

/**
 * Keep the detached-scroll affordance in its own row between the scrollport
 * and composer so it cannot cover cards while the user reads the thread.
 */
export function JumpToLatestControl({
	visible,
	onJump,
}: {
	visible: boolean;
	onJump: () => void;
}) {
	if (!visible) return null;

	return (
		<div
			data-slot="jump-to-latest-control"
			className="pointer-events-none flex shrink-0 justify-center py-1"
		>
			<Button
				aria-label="Jump to latest"
				size="icon-sm"
				variant="outline"
				className="pointer-events-auto !rounded-full bg-kumo-base shadow-tedix-floating"
				icon={<ArrowDown aria-hidden="true" size={16} />}
				onClick={onJump}
			/>
		</div>
	);
}

export function ChatStarterPrompts({
	onChoose,
}: {
	onChoose: (prompt: string) => void;
}) {
	return (
		<div
			data-focus-ring="inset"
			className="chat-starter-prompts mt-6 grid w-full !max-w-none gap-2 text-wrap"
		>
			{CHAT_STARTERS.map((starter) => (
				<Button
					key={starter.title}
					type="button"
					size="sm"
					variant="outline"
					multiline
					className="h-auto w-full justify-start gap-3 px-3 py-2 text-left font-normal!"
					onClick={() => onChoose(starter.prompt)}
				>
					<starter.icon size={18} aria-hidden="true" className="shrink-0" />
					<span className="min-w-0">
						<span className="block truncate font-medium">{starter.title}</span>
						<span className="block truncate text-xs text-kumo-subtle">
							{starter.detail}
						</span>
					</span>
				</Button>
			))}
		</div>
	);
}

/**
 * The provisional user turn: the operator's own message, rendered the instant
 * Send is pressed and retired the moment its durable row lands.
 *
 * It is visibly provisional, never dressed as durable. The bubble is muted and
 * dashed, carries `aria-busy` while the call is in flight, and states its own
 * status in an `aria-live` region — "Sending…" claims nothing about the server,
 * and "Delivery unconfirmed" is neither a success nor a failure, which is the
 * only honest reading of a transport that died mid-send.
 *
 * There is no timestamp: the durable row owns `createdAt`, and printing a
 * client clock beside it would render a time the transcript does not agree
 * with the moment the row arrives.
 */
export function ProvisionalUserBubble({
	send,
	held = false,
}: {
	send: ProvisionalSend;
	/** The send has not left this client: it waits for the socket to return. */
	held?: boolean;
}) {
	const pending = send.state === "sending";
	return (
		<li
			data-slot="provisional-user-message"
			data-provisional-state={send.state}
			data-provisional-key={send.idempotencyKey}
			aria-busy={pending || undefined}
			className="flex w-full min-w-0 max-w-full justify-end"
		>
			<div className="flex min-w-0 max-w-[min(680px,78%)] flex-col gap-1 rounded-[24px] rounded-br-lg border border-kumo-hairline border-dashed bg-kumo-tint px-4 py-2.5">
				<Text
					role="body"
					tone="secondary"
					className="m-0 whitespace-pre-wrap break-words tracking-[-0.25px]"
				>
					{decodeChatContext(send.content).content}
				</Text>
				<span
					className="flex items-center justify-end gap-1.5 text-kumo-subtle text-xs"
					// Polite, not assertive: the send status is progress information,
					// and an assertive region would interrupt the transcript log the
					// operator is already reading.
					aria-live="polite"
					role="status"
				>
					{/* Decorative: this span is already the live region. */}
					{pending ? (
						<span aria-hidden="true" className="flex items-center">
							<Loader aria-label="Sending" size={12} />
						</span>
					) : null}
					{pending && held
						? "Reconnecting… will send"
						: PROVISIONAL_SEND_LABEL[send.state]}
					{send.attempts > 1 ? ` · attempt ${send.attempts}` : ""}
				</span>
			</div>
		</li>
	);
}

export function RunningIndicator({ label }: { label?: string | null }) {
	return (
		<li
			className="flex w-full justify-start"
			data-slot="running-indicator"
			aria-live="polite"
		>
			<div className="flex items-center gap-2 py-1 text-kumo-subtle type-tedix-body">
				{/* Decorative: the <li> above is already the live region. */}
				<span aria-hidden="true" className="flex items-center">
					<Loader aria-label="Working" size={16} />
				</span>
				<span>{label || "Working on it…"}</span>
			</div>
		</li>
	);
}

export function SendFailureBanner({
	outcomeUnknown,
	draftHeld = false,
	message,
	retrying = false,
	onRetry,
}: {
	message: string;
	retrying?: boolean;
	onRetry?: () => void;
	/**
	 * The transport died with the send in flight, so whether the server
	 * accepted it is genuinely unknown. Titling that "Message not sent" states
	 * the failure case as fact — and the body text immediately contradicts it.
	 */
	outcomeUnknown?: boolean;
	/**
	 * The message is held in the unconfirmed bubble above rather than back in
	 * the composer. Saying "your draft is intact" while the textarea is empty
	 * points the operator at the wrong place to look for it.
	 */
	draftHeld?: boolean;
}) {
	return (
		<Alert variant="destructive">
			<AlertTitle>
				{outcomeUnknown ? "Message may not have been sent" : "Message not sent"}
			</AlertTitle>
			<AlertDescription>
				{message}{" "}
				{draftHeld
					? "It is shown above as unconfirmed — Retry re-sends it exactly once."
					: outcomeUnknown
						? // Neither claim is safe here: the message may already be
							// durable (so it is not a lost draft), and the composer may
							// be empty (so promising an intact draft points at nothing).
							"Reload to see whether it was recorded before sending it again."
						: "Your draft is intact — Retry re-sends it exactly once."}
			</AlertDescription>
			<AlertAction className="p-2">
				<Button
					size="sm"
					variant="outline"
					icon={<ArrowCounterClockwise size={14} />}
					disabled={retrying}
					onClick={() => onRetry?.()}
				>
					Retry
				</Button>
			</AlertAction>
		</Alert>
	);
}

export function ApprovalInputGate({ count }: { count: number }) {
	return (
		<div
			data-slot="chat-approval-gate"
			role="status"
			className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 rounded-2xl border border-kumo-warning bg-kumo-warning-tint px-4 py-3"
		>
			<span className="min-w-0">
				<Text as="strong" role="body" tone="strong" className="block">
					Waiting for your approval
				</Text>
				<Text as="span" role="label" tone="secondary" className="block">
					Approve below or reply ‘approve’.
				</Text>
			</span>
			<Badge variant="outline" className="shrink-0">
				{count} pending
			</Badge>
		</div>
	);
}

/**
 * Conversation cost, from usage the run set already carries — no extra read.
 *
 * It measures the kernel route-planner call on each turn and nothing else:
 * `HomeRun.usage.costUsd` is `computeCost(...)` over the planner's tokens
 * (`apps/api/src/rpc/routers/kernel/turn-work.ts`), and the tool/body work of a
 * turn is attributed on the call ledger instead. So the chip names what it
 * measured rather than implying the conversation's total, and a run whose usage
 * was omitted makes the number a floor rather than silently shrinking it.
 */
export function ConversationCostChip({ runs }: { runs: readonly HomeRun[] }) {
	const usages = runs
		.map((run) => run.usage)
		.filter((usage): usage is NonNullable<HomeRun["usage"]> => Boolean(usage));
	return (
		<CostChip
			reading={kernelUsageReading(usages)}
			subject={
				isLocalWorkersAi()
					? "Planning estimate; inference is billed to your inference account"
					: "Planning cost for this conversation, on platform-included credits"
			}
		/>
	);
}
