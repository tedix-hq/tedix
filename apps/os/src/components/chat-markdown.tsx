import { safeMarkdownHref } from "@tedix/chat-transport/markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock, CodeInline } from "@/components/kumo/code";
import { cn } from "@/lib/utils";
import {
	rehypeStripDirectionControls,
	sanitizeUntrustedMarkdown,
} from "@/lib/untrusted-text";

/**
 * The shape of the hast node `react-markdown` hands each component. Declared
 * locally rather than imported from `hast`, which is only a transitive
 * dependency here.
 */
interface MarkdownNode {
	type: string;
	tagName?: string;
	value?: string;
	properties?: { className?: unknown };
	children?: MarkdownNode[];
}

/**
 * `react-markdown` renders a fenced block as `pre > code`, so the block is
 * claimed in the `pre` slot: `CodeBlock` brings its own `<pre>`, and reading
 * the fence off the hast node (rather than off the `code` component's
 * `className`) keeps an unlabelled fence a block instead of silently
 * degrading it to inline code.
 */
function fencedCode(
	node: MarkdownNode | undefined,
): { code: string; lang: string } | null {
	const codeNode = node?.children?.find(
		(child) => child.type === "element" && child.tagName === "code",
	);
	if (!codeNode) return null;
	const classes = codeNode.properties?.className;
	const lang = (Array.isArray(classes) ? classes : [])
		.map(String)
		.find((name) => name.startsWith("language-"))
		?.slice("language-".length);
	const code = (codeNode.children ?? [])
		.map((child) => (child.type === "text" ? (child.value ?? "") : ""))
		.join("")
		.replace(/\n$/, "");
	return { code, lang: lang || "text" };
}

/**
 * Link policy shared with the embedded Tedi widget
 * (`@tedix/chat-transport/markdown`): absolute `https:` destinations open in
 * a new tab; same-origin routes navigate in place; anything else (`http:`,
 * `javascript:`, protocol-relative, mailto) stays literal text.
 */
export function resolveChatMarkdownHref(
	href: string | undefined,
): { href: string; external: boolean } | null {
	if (!href) return null;
	if (href.startsWith("/") && !href.startsWith("//"))
		return { href, external: false };
	const safe = safeMarkdownHref(href);
	return safe ? { href: safe, external: true } : null;
}

/** Safe rich-text rendering for durable chat content. Raw HTML remains text. */
export function ChatMarkdown({
	content,
	preserveLineBreaks = false,
}: {
	content: string;
	/** User-authored turns preserve deliberate single newlines; model prose uses Markdown flow. */
	preserveLineBreaks?: boolean;
}) {
	// `skipHtml` discards raw HTML nodes; `sanitizeUntrustedMarkdown` escapes the
	// angle brackets first, so the operator keeps a literal transcript, and
	// strips the bidi controls that would let it render out of order. It is the
	// SAME chokepoint the live cards use — see `@/lib/untrusted-text`.
	//
	// The string pass alone is NOT sufficient here, and only here: the parser
	// decodes `&#x202E;` / `&#8238;` into a live control AFTER it ran, so
	// `rehypeStripDirectionControls` re-strips the decoded tree. Both halves
	// stay — the string pass is what keeps a control out of the markdown
	// grammar itself.
	const markdown = sanitizeUntrustedMarkdown(content);
	return (
		<div
			className={`chat-markdown min-w-0 max-w-full break-words text-kumo-default type-tedix-body ${preserveLineBreaks ? "whitespace-pre-wrap" : ""}`}
		>
			<ReactMarkdown
				skipHtml
				remarkPlugins={[remarkGfm]}
				rehypePlugins={[rehypeStripDirectionControls]}
				components={{
					p: ({ children }) => (
						<p className="my-[0.4em] first:mt-0 last:mb-0">{children}</p>
					),
					h1: ({ children }) => (
						<h1 className="mt-[0.9em] mb-[0.4em] text-xl font-semibold first:mt-0">
							{children}
						</h1>
					),
					h2: ({ children }) => (
						<h2 className="mt-[0.9em] mb-[0.4em] text-lg font-semibold first:mt-0">
							{children}
						</h2>
					),
					h3: ({ children }) => (
						<h3 className="mt-[0.9em] mb-[0.4em] font-semibold first:mt-0">
							{children}
						</h3>
					),
					ul: ({ className, children }) => (
						<ul
							className={cn(
								"my-[0.4em] list-disc pl-6",
								className?.includes("contains-task-list") && "list-none pl-0",
							)}
						>
							{children}
						</ul>
					),
					ol: ({ children }) => (
						<ol className="my-[0.4em] list-decimal pl-6">{children}</ol>
					),
					li: ({ className, children }) => (
						<li
							className={cn(
								"my-[0.2em]",
								className?.includes("task-list-item") && "list-none",
							)}
						>
							{children}
						</li>
					),
					input: ({ type, checked }) =>
						type === "checkbox" ? (
							<input
								type="checkbox"
								checked={checked}
								readOnly
								disabled
								className="mr-2 size-3.5 align-middle accent-[var(--primary)]"
							/>
						) : null,
					del: ({ children }) => (
						<del className="text-kumo-subtle decoration-kumo-subtle">
							{children}
						</del>
					),
					blockquote: ({ children }) => (
						<blockquote className="my-[0.6em] border-kumo-hairline border-l-2 pl-3 text-kumo-subtle">
							{children}
						</blockquote>
					),
					hr: () => <hr className="my-4 border-kumo-hairline" />,
					table: ({ children }) => (
						<div className="my-3 max-w-full overflow-x-auto rounded-lg border border-kumo-hairline">
							<table className="w-full border-collapse text-left text-sm">
								{children}
							</table>
						</div>
					),
					th: ({ children }) => (
						<th className="border-kumo-hairline border-b bg-kumo-fill px-3 py-2 font-medium">
							{children}
						</th>
					),
					td: ({ children }) => (
						<td className="border-kumo-hairline border-b px-3 py-2 align-top last:border-b-0">
							{children}
						</td>
					),
					pre: ({ node, children }) => {
						const fenced = fencedCode(node as MarkdownNode | undefined);
						// Kumo's highlighter owns the block's geometry; the wrapper owns
						// the width contract. `min-w-0` lets a flex/grid parent shrink
						// the block below its content width, and `overflow-x-auto` on
						// both wrapper and `<pre>` scrolls a long line instead of
						// clipping it — in a 370px pane as well as a wide one.
						return fenced ? (
							<div
								className="chat-markdown-code my-3 min-w-0 max-w-full overflow-x-auto whitespace-normal [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:whitespace-pre"
								data-slot="chat-markdown-code"
							>
								<CodeBlock
									code={fenced.code}
									lang={fenced.lang}
									showCopyButton
								/>
							</div>
						) : (
							<pre className="max-w-full overflow-x-auto">{children}</pre>
						);
					},
					code: ({ children }) => <CodeInline>{children}</CodeInline>,
					a: ({ href, children }) => {
						const resolved = resolveChatMarkdownHref(href);
						if (!resolved) return <span>{children}</span>;
						return (
							<a
								href={resolved.href}
								rel="noopener noreferrer"
								{...(resolved.external ? { target: "_blank" } : {})}
								className="text-kumo-link underline-offset-2 hover:underline"
							>
								{children}
							</a>
						);
					},
				}}
			>
				{markdown}
			</ReactMarkdown>
		</div>
	);
}
