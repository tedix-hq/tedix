import {
	ArrowCounterClockwise,
	Check,
	Copy,
	WarningCircle,
} from "@phosphor-icons/react";
import { asRecord } from "@tedix/api-contract/utils/is-record";
import { useEffect, useRef, useState } from "react";
import { ChatMarkdown } from "@/components/chat-markdown";
import { Button } from "@/components/kumo/button";
import { ClipboardText } from "@/components/kumo/clipboard-text";
import { CodeBlock } from "@/components/kumo/code";
import {
	Collapsible,
	CollapsibleDefaultTrigger,
	CollapsibleDefaultContent,
} from "@/components/kumo/collapsible";
import { Text } from "@/components/kumo/text";
import { toast } from "@/components/kumo/toast";
import {
	describeToolFailure,
	formatJson,
	formatPartialJson,
	type JsonPayload,
	jsonSizeLabel,
	parseWriteApprovalRequest,
	parseWriteFailure,
	splitJsonSegments,
	type WriteApprovalRequest,
	type WriteFailure,
} from "@/lib/chat-structured-content";
import { orpcErrorCode } from "@/lib/orpc-error";
import { sanitizeUntrustedText } from "@/lib/untrusted-text";

// UNTRUSTED TEXT. Tool names, app slugs, arguments and error text are
// tool-authored; each string goes through `sanitizeUntrustedText` (plain
// text) or `ChatMarkdown` (markdown) at the render site.

function CopyJsonButton({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	const reset = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (reset.current) clearTimeout(reset.current);
		},
		[],
	);
	return (
		<Button
			type="button"
			variant="ghost"
			size="sm"
			aria-label={copied ? "Copied" : "Copy JSON"}
			icon={copied ? <Check size={14} /> : <Copy size={14} />}
			onClick={async () => {
				try {
					await navigator.clipboard.writeText(text);
					setCopied(true);
					if (reset.current) clearTimeout(reset.current);
					reset.current = setTimeout(() => setCopied(false), 2000);
				} catch {
					toast.error("Could not copy");
				}
			}}
		>
			{copied ? "Copied" : "Copy"}
		</Button>
	);
}

/**
 * A JSON payload behind a disclosure: collapsed by default, pretty-printed,
 * height-bounded, long strings folded until asked for, and a copy button that
 * always copies the full payload.
 */
export function JsonDetails({
	label,
	payload,
	defaultOpen = false,
}: {
	label: string;
	payload: JsonPayload;
	defaultOpen?: boolean;
}) {
	const [showFull, setShowFull] = useState(false);
	const full = payload.complete
		? formatJson(payload.value).text
		: formatPartialJson(payload.raw);
	const folded = payload.complete
		? formatJson(payload.value, { fold: true })
		: { text: full, folded: 0 };
	const shown = sanitizeUntrustedText(showFull ? full : folded.text);
	const size = payload.complete ? jsonSizeLabel(payload.value) : null;
	return (
		<Collapsible defaultOpen={defaultOpen} data-slot="chat-json-details">
			<CollapsibleDefaultTrigger className="group/disclosure -ml-2">
				{label}
				{size ? <span className="text-kumo-subtle">· {size}</span> : null}
			</CollapsibleDefaultTrigger>
			<CollapsibleDefaultContent keepMounted>
				<div className="mt-1 flex min-w-0 flex-col gap-1">
					<div className="flex flex-wrap items-center justify-end gap-1">
						{!payload.complete ? (
							<Text as="span" role="label" tone="secondary" className="mr-auto">
								Shortened by the server
							</Text>
						) : null}
						{folded.folded > 0 ? (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								aria-pressed={showFull}
								onClick={() => setShowFull((value) => !value)}
							>
								{showFull ? "Shorten long values" : "Show full values"}
							</Button>
						) : null}
						<CopyJsonButton text={full} />
					</div>
					<div
						className="chat-markdown-code min-w-0 max-w-full whitespace-normal [&_pre]:max-h-80 [&_pre]:max-w-full [&_pre]:overflow-auto [&_pre]:whitespace-pre"
						data-slot="chat-json-code"
					>
						<CodeBlock code={shown} lang="json" />
					</div>
				</div>
			</CollapsibleDefaultContent>
		</Collapsible>
	);
}

const ERROR_CATEGORIES: Record<string, string> = {
	UNAUTHORIZED: "Sign-in or access",
	FORBIDDEN: "Sign-in or access",
	NOT_FOUND: "Not found",
	TIMEOUT: "Took too long",
	TOO_MANY_REQUESTS: "Too many requests",
	BAD_REQUEST: "Request not accepted",
	CONFLICT: "Changed elsewhere",
};

/** A plain category for a failed call; never the server's own words. */
export function chatErrorCategory(error: unknown): string {
	const code = orpcErrorCode(error);
	return (code && ERROR_CATEGORIES[code]) || "Connection or service";
}

/** The reference id a failed call carries, for support; never its message. */
export function chatErrorReference(error: unknown): string | null {
	if (!error || typeof error !== "object") return null;
	const record = error as { traceId?: unknown; data?: unknown };
	const data = asRecord(record.data);
	const id = [record.traceId, data?.traceId, data?.requestId].find(
		(value): value is string => typeof value === "string" && value !== "",
	);
	return id ?? null;
}

/**
 * One calm error line in the chat: a plain sentence, Retry when it applies,
 * and a closed "Details" holding only a plain category and a copyable
 * reference id. Raw provider or database text never shows here.
 */
export function ChatErrorLine({
	message,
	category,
	referenceId,
	onRetry,
	retrying = false,
}: {
	message: string;
	category?: string | null;
	referenceId?: string | null;
	onRetry?: () => void;
	retrying?: boolean;
}) {
	return (
		<div
			data-slot="chat-error-line"
			role="alert"
			className="flex min-w-0 flex-col gap-0.5"
		>
			<p className="m-0 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-kumo-default type-tedix-body">
				<WarningCircle
					size={16}
					aria-hidden
					className="shrink-0 text-kumo-danger"
				/>
				<span className="min-w-0 [overflow-wrap:anywhere]">{message}</span>
				{onRetry ? (
					<Button
						type="button"
						size="sm"
						variant="ghost"
						icon={<ArrowCounterClockwise size={14} />}
						disabled={retrying}
						onClick={() => onRetry()}
					>
						Retry
					</Button>
				) : null}
			</p>
			{category || referenceId ? (
				<Collapsible className="pl-6">
					<CollapsibleDefaultTrigger className="-ml-2 min-h-6 py-0 text-kumo-subtle type-tedix-caption">
						Details
					</CollapsibleDefaultTrigger>
					<CollapsibleDefaultContent>
						<div className="flex min-w-0 flex-col gap-1 text-kumo-subtle type-tedix-caption">
							{category ? <span>Kind: {category}</span> : null}
							{referenceId ? (
								<ClipboardText
									size="sm"
									text={referenceId}
									textToCopy={referenceId}
								/>
							) : null}
						</div>
					</CollapsibleDefaultContent>
				</Collapsible>
			) : null}
		</div>
	);
}

/** The Home write-approval message, as a summary with its details folded away. */
export function WriteApprovalRequestMessage({
	request,
}: {
	request: WriteApprovalRequest;
}) {
	return (
		<div
			className="flex min-w-0 flex-col gap-1.5"
			data-slot="chat-write-approval"
		>
			<Text as="p" role="body" tone="strong" weight="medium" className="m-0">
				{sanitizeUntrustedText(request.summary)}
			</Text>
			{request.note ? <ChatMarkdown content={request.note} /> : null}
			{request.instruction ? (
				<Text as="p" role="body" tone="secondary" className="m-0">
					{sanitizeUntrustedText(request.instruction)}
				</Text>
			) : null}
			{request.args ? (
				<JsonDetails label="Arguments" payload={request.args} />
			) : null}
		</div>
	);
}

/** One calm line for a write that failed after approval. */
export function WriteFailureMessage({ failure }: { failure: WriteFailure }) {
	return (
		<div data-slot="chat-write-failure">
			<ChatErrorLine
				message={`${describeToolFailure(sanitizeUntrustedText(failure.toolName))}.`}
				category="Connected app change"
			/>
		</div>
	);
}

/**
 * Assistant text with its structured parts rendered as structure: the write
 * approval request, an approved write's failure, and embedded JSON. Text with
 * none of these renders exactly as `ChatMarkdown` would.
 */
export function StructuredChatContent({ content }: { content: string }) {
	const request = parseWriteApprovalRequest(content);
	if (request) return <WriteApprovalRequestMessage request={request} />;
	const failure = parseWriteFailure(content);
	if (failure) return <WriteFailureMessage failure={failure} />;
	const segments = splitJsonSegments(content);
	if (segments.length === 1 && segments[0]!.kind === "text") {
		return <ChatMarkdown content={content} />;
	}
	return (
		<div className="flex min-w-0 flex-col gap-1.5" data-slot="chat-structured">
			{segments.map((segment, index) =>
				segment.kind === "text" ? (
					segment.text.trim() ? (
						<ChatMarkdown key={index} content={segment.text.trim()} />
					) : null
				) : segment.kind === "mcp_text" ? (
					<p
						key={index}
						className="m-0 min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere] text-kumo-default type-tedix-body"
					>
						{sanitizeUntrustedText(segment.text)}
					</p>
				) : (
					<JsonDetails
						key={index}
						label="Data"
						payload={{ complete: true, value: segment.value, raw: segment.raw }}
					/>
				),
			)}
		</div>
	);
}
