import { Check, Copy } from "@phosphor-icons/react";
import { safeMarkdownHref } from "@tedix/chat-transport/markdown";
import {
	Children,
	cloneElement,
	createContext,
	isValidElement,
	type MouseEvent,
	type ReactElement,
	type ReactNode,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/kumo/button";
import { CodeBlock, CodeInline } from "@/components/kumo/code";
import { Link } from "@/components/kumo/link";
import type { FileRoutesByFullPath } from "@/routeTree.gen";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/kumo/table";
import { toast } from "@/components/kumo/toast";
import { outputIdFromHref } from "@/lib/output-navigation";
import {
	rehypeStripDirectionControls,
	sanitizeUntrustedMarkdown,
	sanitizeUntrustedText,
} from "@/lib/untrusted-text";
import "./chat-markdown.css";

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

function markdownText(children: ReactNode): string {
	let text = "";
	Children.forEach(children, (child) => {
		if (typeof child === "string" || typeof child === "number") {
			text += child;
		} else if (isValidElement(child)) {
			text += markdownText((child.props as { children?: ReactNode }).children);
		}
	});
	return text;
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

/** A raw dump longer than this many lines starts folded. */
const FOLD_ABOVE_LINES = 24;
/** How many lines a folded block shows. */
const FOLDED_LINES = 20;

function CopyCodeButton({ code }: { code: string }) {
	const [copied, setCopied] = useState(false);
	const reset = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (reset.current) clearTimeout(reset.current);
		},
		[],
	);
	const label = copied ? "Copied" : "Copy code";
	return (
		<Button
			type="button"
			variant="ghost"
			size="icon-xs"
			aria-label={label}
			title={label}
			icon={copied ? <Check size={14} /> : <Copy size={14} />}
			onClick={async () => {
				try {
					await navigator.clipboard.writeText(code);
					setCopied(true);
					if (reset.current) clearTimeout(reset.current);
					reset.current = setTimeout(() => setCopied(false), 2000);
				} catch {
					toast.error("Could not copy");
				}
			}}
		/>
	);
}

/**
 * A code block in a reply: a header naming the language with a copy button
 * and a body that scrolls sideways instead of wrapping. A fenced block is
 * code the reply wrote, so it shows every line; a reply that is only a raw
 * JSON dump is output, folded to its first lines until the reader asks for
 * the rest. Tool logs fold in their own step detail. Copy always takes the
 * whole block.
 */
function ChatCodeBlock({
	code,
	lang,
	fold,
}: {
	code: string;
	lang: string;
	fold: boolean;
}) {
	const [expanded, setExpanded] = useState(false);
	const lines = code.split("\n");
	const foldable = fold && lines.length > FOLD_ABOVE_LINES;
	const folded = foldable && !expanded;
	return (
		<div
			className="chat-markdown-code"
			data-slot="chat-markdown-code"
			data-folded={folded ? "true" : undefined}
		>
			<div className="chat-markdown-code-header">
				<span className="chat-markdown-code-lang">{lang}</span>
				<CopyCodeButton code={code} />
			</div>
			<CodeBlock
				code={folded ? lines.slice(0, FOLDED_LINES).join("\n") : code}
				lang={lang}
				variant="plain"
				className="chat-markdown-code-body rounded-none bg-transparent px-3 py-2.5"
			/>
			{foldable ? (
				<div className="chat-markdown-code-more">
					<Button
						type="button"
						variant="ghost"
						size="xs"
						aria-expanded={expanded}
						onClick={() => setExpanded((value) => !value)}
					>
						{expanded ? "Show fewer lines" : `Show all ${lines.length} lines`}
					</Button>
				</div>
			) : null}
		</div>
	);
}

/**
 * A reply that is nothing but a JSON object or array: a raw dump, shown as a
 * code block rather than run together as prose.
 */
function jsonDump(content: string): string | null {
	const trimmed = content.trim();
	if (!/^[[{]/.test(trimmed)) return null;
	try {
		JSON.parse(trimmed);
		return trimmed;
	} catch {
		return null;
	}
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

/**
 * Where a chat link to `/outputs/<id>` opens. A Workspace provides a handler
 * so the output opens in its own editor pane instead of leaving the
 * Workspace; without one the link goes to the standalone output page.
 * A Workspace also offers `openEditor`, which opens an app by its id, for
 * example a new editable copy of an uploaded file or an app the agent made.
 */
export const ChatOutputLinkContext = createContext<{
	openOutput?: (outputId: string) => void;
	openEditor?: (gadgetId: string) => void;
}>({});

/** The part of the Markdown tree an app path is looked for in. */
interface MarkdownTreeNode {
	type: string;
	value?: string;
	url?: string;
	children?: MarkdownTreeNode[];
}

/**
 * An app path written in prose, "/workspaces" or "(/work/items/42)": at the
 * start, after a space or an opening parenthesis, and with no file
 * extension, so "and/or" and "/src/main.ts" stay text.
 */
const APP_PATH =
	/(^|[\s(])(\/[a-z][\w-]*(?:\/[\w-]+)*\/?)(?=$|[\s),;:!?]|\.(?!\w))/giu;

type FirstSegment<Path> = Path extends `/${infer Segment}/${string}`
	? Segment
	: Path extends `/${infer Segment}`
		? Segment
		: never;

/** First segments of the app's own routes: "work" for "/work/items/$id". */
type AppRouteSegment = Exclude<
	FirstSegment<keyof FileRoutesByFullPath>,
	"" | `$${string}`
>;

/**
 * Only a path under one of the app's routes becomes a link, so
 * "/tmp/report" or "/Users/me" stay text. `satisfies` keeps this list in
 * step with the generated route tree: a new or removed route fails the build.
 */
const APP_ROUTE_SEGMENTS = new Set(
	Object.keys({
		account: true,
		admin: true,
		apps: true,
		audit: true,
		blueprint: true,
		blueprints: true,
		brain: true,
		chat: true,
		cli: true,
		compute: true,
		"desktop-sign-in": true,
		explore: true,
		guest: true,
		inbox: true,
		install: true,
		invite: true,
		login: true,
		oauth: true,
		outputs: true,
		s: true,
		settings: true,
		shared: true,
		sites: true,
		skills: true,
		team: true,
		usage: true,
		widget: true,
		work: true,
		workspace: true,
		workspaces: true,
	} satisfies Record<AppRouteSegment, true>),
);

/** Whether `path` ("/work/items/42") starts with one of the app's routes. */
function isAppRoutePath(path: string): boolean {
	return APP_ROUTE_SEGMENTS.has(path.split("/")[1] ?? "");
}

/** Nodes whose text is never turned into a link. */
const NO_APP_PATHS = new Set([
	"link",
	"linkReference",
	"definition",
	"inlineCode",
	"code",
]);

function linkAppPaths(node: MarkdownTreeNode): void {
	if (NO_APP_PATHS.has(node.type) || !node.children) return;
	node.children = node.children.flatMap((child) => {
		if (child.type !== "text" || !child.value) {
			linkAppPaths(child);
			return [child];
		}
		const parts: MarkdownTreeNode[] = [];
		let last = 0;
		for (const match of child.value.matchAll(APP_PATH)) {
			const start = match.index + match[1]!.length;
			const path = match[2]!;
			// "/skill <slug>" asks for a skill; it is not a page.
			if (path === "/skill" || !isAppRoutePath(path)) continue;
			if (start > last)
				parts.push({ type: "text", value: child.value.slice(last, start) });
			parts.push({
				type: "link",
				url: path,
				children: [{ type: "text", value: path }],
			});
			last = start + path.length;
		}
		if (parts.length === 0) return [child];
		if (last < child.value.length)
			parts.push({ type: "text", value: child.value.slice(last) });
		return parts;
	});
}

/** Turns app paths in prose into links; bare web addresses come from GFM. */
function remarkAppPaths() {
	return (tree: MarkdownTreeNode) => linkAppPaths(tree);
}

function unescapeCodeText(node: MarkdownTreeNode): void {
	if ((node.type === "code" || node.type === "inlineCode") && node.value) {
		node.value = node.value.replaceAll("&lt;", "<").replaceAll("&gt;", ">");
	}
	node.children?.forEach(unescapeCodeText);
}

/**
 * `sanitizeUntrustedMarkdown` escapes every angle bracket, and Markdown does
 * not decode character references inside code, so `a < b` in a fence would
 * read `a &lt; b`. Code text is rendered as text (React or the highlighter
 * escapes it), so the brackets go back.
 */
function remarkCodeText() {
	return (tree: MarkdownTreeNode) => unescapeCodeText(tree);
}

/** A plain primary click; modified clicks keep the browser's own behavior. */
function isPlainPrimaryClick(event: MouseEvent<HTMLAnchorElement>): boolean {
	return (
		event.button === 0 &&
		!event.metaKey &&
		!event.ctrlKey &&
		!event.shiftKey &&
		!event.altKey
	);
}

/** Safe rich-text rendering for durable chat content. Raw HTML remains text. */
export function ChatMarkdown({
	content,
	preserveLineBreaks = false,
	components,
}: {
	content: string;
	/** User-authored turns preserve deliberate single newlines; model prose uses Markdown flow. */
	preserveLineBreaks?: boolean;
	components?: Components;
}) {
	const { openOutput } = useContext(ChatOutputLinkContext);
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
	const dump = jsonDump(content);
	// Typography lives in `chat-markdown.css`; only behaviour stays here.
	const className = `chat-markdown min-w-0 max-w-full [overflow-wrap:anywhere] text-kumo-default ${preserveLineBreaks ? "whitespace-pre-wrap" : ""}`;
	if (dump) {
		return (
			<div className={className}>
				{/* A bare JSON dump is raw output, not code someone asked for. */}
				<ChatCodeBlock code={sanitizeUntrustedText(dump)} fold lang="json" />
			</div>
		);
	}
	return (
		<div className={className}>
			<ReactMarkdown
				skipHtml
				remarkPlugins={[remarkGfm, remarkAppPaths, remarkCodeText]}
				rehypePlugins={[rehypeStripDirectionControls]}
				components={{
					// Lists stay components, not plain tags: only a component element
					// carries its `node`, which a caller's `li` override reads to find
					// a nested list.
					ul: ({ className, children }) => (
						<ul className={className}>{children}</ul>
					),
					ol: ({ className, start, children }) => (
						<ol className={className} start={start}>
							{children}
						</ol>
					),
					li: ({ className, children }) => {
						const taskLabel = className?.includes("task-list-item")
							? markdownText(children).trim()
							: null;
						let inputLabelled = false;
						const renderedChildren = taskLabel
							? Children.map(children, (child) => {
									if (!inputLabelled && isValidElement(child)) {
										inputLabelled = true;
										return cloneElement(
											child as ReactElement<{ "aria-label"?: string }>,
											{ "aria-label": taskLabel },
										);
									}
									return child;
								})
							: children;
						return <li className={className}>{renderedChildren}</li>;
					},
					input: ({ type, checked, "aria-label": ariaLabel }) =>
						type === "checkbox" ? (
							<input
								type="checkbox"
								checked={checked}
								aria-label={ariaLabel}
								readOnly
								disabled
								className="mr-2 size-3.5 align-middle accent-[var(--primary)]"
							/>
						) : null,
					table: ({ children }) => (
						<Table containerClassName="chat-markdown-table">{children}</Table>
					),
					thead: ({ children }) => <TableHeader>{children}</TableHeader>,
					tbody: ({ children }) => <TableBody>{children}</TableBody>,
					tr: ({ children }) => <TableRow>{children}</TableRow>,
					// Body cells wrap, so a column of prose does not stretch the table;
					// the container still scrolls sideways when the columns cannot fit.
					th: ({ children, style }) => (
						<TableHead style={style}>{children}</TableHead>
					),
					td: ({ children, style }) => (
						<TableCell style={style} className="whitespace-normal align-top">
							{children}
						</TableCell>
					),
					// `react-markdown` renders a fenced block as `pre > code`, so the
					// block is claimed here and `ChatCodeBlock` brings its own `<pre>`.
					pre: ({ node, children }) => {
						const fenced = fencedCode(node as MarkdownNode | undefined);
						return fenced ? (
							<ChatCodeBlock
								code={fenced.code}
								fold={false}
								lang={fenced.lang}
							/>
						) : (
							<pre className="max-w-full overflow-x-auto">{children}</pre>
						);
					},
					code: ({ children }) => <CodeInline>{children}</CodeInline>,
					a: ({ href, children }) => {
						const resolved = resolveChatMarkdownHref(href);
						if (!resolved) return <span>{children}</span>;
						if (resolved.external)
							return (
								<Link
									href={resolved.href}
									target="_blank"
									rel="noopener noreferrer"
								>
									{children}
								</Link>
							);
						const outputId = outputIdFromHref(resolved.href);
						// Another page of the app goes through the router; an output
						// opens in the host Workspace's pane on a plain click.
						if (!(outputId && openOutput))
							return <Link href={resolved.href}>{children}</Link>;
						return (
							<Link
								render={<a href={resolved.href} />}
								onClick={(event: MouseEvent<HTMLAnchorElement>) => {
									if (!isPlainPrimaryClick(event)) return;
									event.preventDefault();
									openOutput(outputId);
								}}
							>
								{children}
							</Link>
						);
					},
					...components,
				}}
			>
				{markdown}
			</ReactMarkdown>
		</div>
	);
}
