import { useState } from "react";
import { markdownLineToPlainText } from "@tedix/api-contract/utils/markdown-plain-text";
import {
	ChatMarkdown,
	resolveChatMarkdownHref,
} from "@/components/chat-markdown";
import { Button } from "@/components/kumo/button";
import { Link } from "@/components/kumo/link";
import { OS_COPY } from "@/shared/os-copy";

/** Keep the proposal readable without losing the complete source text. */
export function DecisionProposalBody({ body }: { body: string }) {
	const [expanded, setExpanded] = useState(false);
	const preview = markdownLineToPlainText(
		body.replace(/https?:\/\/[^\s)<>]+/g, "").replace(/\n+/g, " "),
	);
	return (
		<div className="fd-proposal-body">
			{expanded ? (
				<ChatMarkdown
					content={body}
					components={{
						a: ({ href, children }) => {
							const resolved = resolveChatMarkdownHref(href);
							if (!resolved) return <span>{children}</span>;
							const bare =
								typeof children === "string" && /^https?:\/\//.test(children);
							const title = bare ? linkTitle(resolved.href) : children;
							return (
								<Link
									className="fd-link-chip"
									href={resolved.href}
									variant="plain"
									{...(resolved.external
										? { target: "_blank", rel: "noopener noreferrer" }
										: {})}
								>
									{title}
								</Link>
							);
						},
					}}
				/>
			) : (
				<p className="fd-proposal-preview">{preview}</p>
			)}
			<Button
				className="fd-proposal-more"
				variant="ghost"
				size="sm"
				aria-expanded={expanded}
				onClick={() => setExpanded((value) => !value)}
			>
				{expanded ? OS_COPY.feedDeckVisual.less : OS_COPY.feedDeckVisual.more}
			</Button>
		</div>
	);
}

function linkTitle(href: string) {
	const url = new URL(href, "https://example.invalid");
	if (
		url.pathname.startsWith("/workspace/") &&
		url.searchParams.get("workpiece")?.startsWith("output:")
	)
		return OS_COPY.feedDeckVisual.workspaceDocument;
	if (url.pathname.startsWith("/outputs/"))
		return OS_COPY.feedDeckVisual.document;
	if (url.pathname.startsWith("/work/"))
		return OS_COPY.feedDeckVisual.workRecord;
	return url.hostname === "example.invalid"
		? OS_COPY.feedDeckVisual.source
		: OS_COPY.feedDeckVisual.openSite(url.hostname.replace(/^www\./, ""));
}

export function DecisionProposalHeading({ title }: { title: string }) {
	return (
		<>
			{title.split(/(https?:\/\/[^\s<>]+)/g).map((part, index) => {
				if (!/^https?:\/\//.test(part)) return part;
				const resolved = resolveChatMarkdownHref(part);
				return resolved ? (
					<Link
						key={index}
						href={resolved.href}
						variant="plain"
						className="fd-link-chip"
						{...(resolved.external
							? { target: "_blank", rel: "noopener noreferrer" }
							: {})}
					>
						{OS_COPY.feedDeckVisual.linkedPage}
					</Link>
				) : (
					OS_COPY.feedDeckVisual.linkedPage
				);
			})}
		</>
	);
}

/** Derive a bounded heading when an older request uses its full brief as title. */
export function decisionProposalTitle(title: string): string {
	const plain = markdownLineToPlainText(
		title.replace(/https?:\/\/[^\s)<>]+/g, ""),
	)
		.replace(/\s+/g, " ")
		.trim();
	if (plain.length <= 90) return title.length <= 90 ? title : plain;
	if (
		/\bpublish\b/i.test(plain) &&
		/\bhome\b/i.test(plain) &&
		/\bCTA\b/i.test(plain)
	)
		return OS_COPY.feedDeckVisual.publishHomeCta;
	const sentence = plain.match(/^.{12,89}?[?!.](?:\s|$)/)?.[0]?.trim();
	if (sentence) return sentence;
	const clause = plain.split(/\s[→—]\s|;|\n/)[0]!.trim();
	if (clause.length >= 15 && clause.length <= 89) return clause;
	const prefix = plain
		.slice(0, 89)
		.replace(/\s+\S*$/, "")
		.replace(/[,:;\s]+$/, "");
	return `${prefix}…`;
}
