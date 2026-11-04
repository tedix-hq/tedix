import { useContext, useState, type ReactNode } from "react";
import { plainDecisionSource } from "@/lib/plain-decision-text";
import {
	DecisionRailContext,
	DecisionContextSection,
} from "@/components/decision-context-rail";
import { markdownLineToPlainText } from "@tedix/api-contract/utils/markdown-plain-text";
import {
	ChatMarkdown,
	resolveChatMarkdownHref,
} from "@/components/chat-markdown";
import { Button } from "@/components/kumo/button";
import { Link } from "@/components/kumo/link";
import { OS_COPY } from "@/shared/os-copy";

/** Keep the proposal readable without losing the complete source text. */
export function DecisionProposalBody({
	body,
	inline = false,
}: {
	body: string;
	inline?: boolean;
}) {
	const [expanded, setExpanded] = useState(false);
	const rail = useContext(DecisionRailContext);
	// An inline body is shown as written (an email draft is sent as is); a
	// summarized one hides identifiers and notes agents leave for each other.
	const shown = inline ? body : plainDecisionSource(body) || body;
	const preview = markdownLineToPlainText(
		shown.replace(/https?:\/\/[^\s)<>]+/g, "").replace(/\n+/g, " "),
	);
	const markdown = (
		<ChatMarkdown
			content={shown}
			components={{
				a: ({ href, children }) => (
					<DecisionLink href={href}>{children}</DecisionLink>
				),
			}}
		/>
	);
	if (rail && !inline)
		return (
			<div className="fd-proposal-body">
				<p className="fd-proposal-preview">{preview}</p>
				{body.length > 0 && (
					<DecisionContextSection
						sectionId="details"
						title="Details"
						defaultOpen
					>
						{markdown}
					</DecisionContextSection>
				)}
			</div>
		);
	return (
		<div className="fd-proposal-body">
			{inline || expanded ? (
				markdown
			) : (
				<p className="fd-proposal-preview">{preview}</p>
			)}
			{!inline && (
				<Button
					className="fd-proposal-more"
					variant="ghost"
					size="sm"
					aria-expanded={expanded}
					onClick={() => setExpanded((value) => !value)}
				>
					{expanded ? OS_COPY.feedDeckVisual.less : OS_COPY.feedDeckVisual.more}
				</Button>
			)}
		</div>
	);
}

/** A link with a readable label: a raw URL reads as "Open Work record". */
function DecisionLink({
	href,
	children,
}: {
	href: string | undefined;
	children: ReactNode;
}) {
	const resolved = resolveChatMarkdownHref(href);
	if (!resolved) return <span>{children}</span>;
	const bare =
		typeof children === "string" &&
		(/^https?:\/\//.test(children) || children === href);
	return (
		<Link
			className="fd-link-chip"
			href={resolved.href}
			variant="plain"
			{...(resolved.external
				? { target: "_blank", rel: "noopener noreferrer" }
				: {})}
		>
			{bare ? linkTitle(resolved.href) : children}
		</Link>
	);
}

/**
 * One line of card copy with the markdown people expect: `code` in
 * monospace, **bold**, and links with readable labels.
 */
export function InlineMarkdown({ text }: { text: string }) {
	const parts = text.split(
		/(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\s]+\)|https?:\/\/[^\s<>)]+)/g,
	);
	return (
		<>
			{parts.map((part, index) => {
				if (index % 2 === 0) return part;
				if (part.startsWith("`"))
					return (
						<code key={index} className="fd-inline-code">
							{part.slice(1, -1)}
						</code>
					);
				if (part.startsWith("**"))
					return <strong key={index}>{part.slice(2, -2)}</strong>;
				const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
				return (
					<DecisionLink key={index} href={link ? link[2] : part}>
						{link ? link[1] : part}
					</DecisionLink>
				);
			})}
		</>
	);
}

function linkTitle(href: string) {
	const parsed = new URL(href, "https://example.invalid");
	// A full link to this OS reads like a relative one.
	const url = /(?:^|\.)os\.[^.]+\.[^.]+$/.test(parsed.hostname)
		? new URL(`${parsed.pathname}${parsed.search}`, "https://example.invalid")
		: parsed;
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
	const readable = title
		.replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "the requested address")
		.replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "the linked record")
		.replace(/\b[0-9a-f]{7,40}\b/gi, "the referenced revision");
	const plain = markdownLineToPlainText(
		readable.replace(/https?:\/\/[^\s)<>]+/g, ""),
	)
		.replace(/\s+/g, " ")
		.trim();
	if (plain.length <= 90) return readable.length <= 90 ? readable : plain;
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

/** Keep source identifiers available without repeating a message in monospace. */
export function decisionIdentifiers(source: string): string[] {
	return [
		...new Set(
			source.match(
				/[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b[0-9a-f]{7,40}\b/gi,
			) ?? [],
		),
	].slice(0, 3);
}
