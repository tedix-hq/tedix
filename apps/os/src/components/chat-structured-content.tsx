import { CaretRight, Check, Copy, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { ChatMarkdown } from "@/components/chat-markdown";
import { Button } from "@/components/kumo/button";
import { CodeBlock } from "@/components/kumo/code";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
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
			<CollapsibleTrigger className="group/disclosure -ml-2">
				<CaretRight
					size={14}
					aria-hidden
					className="shrink-0 transition-transform group-data-[panel-open]/disclosure:rotate-90 motion-reduce:transition-none"
				/>
				{label}
				{size ? <span className="text-kumo-subtle">· {size}</span> : null}
			</CollapsibleTrigger>
			<CollapsibleContent keepMounted>
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
			</CollapsibleContent>
		</Collapsible>
	);
}

/** Tool, app and request id: kept, but quieter than the summary. */
function ToolCallMeta({
	toolName,
	appSlug,
	requestId,
}: {
	toolName: string;
	appSlug: string | null;
	requestId?: string | null;
}) {
	return (
		<Text
			as="p"
			role="label"
			tone="secondary"
			className="m-0 flex min-w-0 flex-wrap items-center gap-x-1.5 break-all"
			data-slot="chat-tool-meta"
		>
			<span className="font-mono">{sanitizeUntrustedText(toolName)}</span>
			{appSlug ? <span>· {sanitizeUntrustedText(appSlug)}</span> : null}
			{requestId ? (
				<span title={`Request ${requestId}`}>
					· Request{" "}
					<span className="font-mono">{sanitizeUntrustedText(requestId)}</span>
				</span>
			) : null}
		</Text>
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
			<ToolCallMeta
				toolName={request.toolName}
				appSlug={request.appSlug}
				requestId={request.requestId}
			/>
		</div>
	);
}

/** One clear error line for a write that failed after approval. */
export function WriteFailureMessage({ failure }: { failure: WriteFailure }) {
	return (
		<div className="flex min-w-0 flex-col gap-1" data-slot="chat-write-failure">
			<p className="m-0 flex min-w-0 items-start gap-2 text-kumo-danger type-tedix-body">
				<WarningCircle size={16} aria-hidden className="mt-0.5 shrink-0" />
				<span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
					<span className="font-medium">
						{describeToolFailure(sanitizeUntrustedText(failure.toolName))}:
					</span>{" "}
					{sanitizeUntrustedText(failure.error)}
				</span>
			</p>
			<span className="pl-6">
				<ToolCallMeta toolName={failure.toolName} appSlug={failure.appSlug} />
			</span>
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
