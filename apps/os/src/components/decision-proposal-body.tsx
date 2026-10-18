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
