import "./output-editor.css";
import type {
	OsOutputContent,
	OsRichTextNode,
} from "@tedix/api-contract/schemas/os-workspaces";
import { FileText, PencilSimple } from "@phosphor-icons/react";
import { lazy, Suspense, useEffect, useId, useMemo, useState } from "react";
import {
	DocumentOutline,
	type DocumentOutlineItem,
	richTextOutline,
} from "@/components/document-outline";
import { Button } from "@/components/kumo/button";
import { Empty } from "@/components/kumo/empty";
import { Text } from "@/components/kumo/text";
import { DeckReadView } from "@/components/deck-read-view";
import {
	INDENT_STEP_PX,
	MAX_INDENT,
	safeImageSource,
} from "@/lib/output-models";
import { normalizeDocumentContent } from "@tedix/api-contract/utils/os-document";
import { WorkbookView } from "@/components/sheet-read-view";

const FilePreview = lazy(() =>
	import("./workspace-file-preview").then((module) => ({
		default: module.WorkspaceFilePreview,
	})),
);
export function FileOutputView(props: {
	workspaceId: string;
	resourceId: string;
}) {
	return (
		<Suspense
			fallback={
				<Text as="p" role="body">
					Loading file…
				</Text>
			}
		>
			<FilePreview {...props} />
		</Suspense>
	);
}

export function OutputContentView({
	content,
	onEdit,
}: {
	content: OsOutputContent;
	/** Opens the editor; the deck view binds it to the E key. */
	onEdit?: () => void;
}) {
	switch (content.kind) {
		case "document":
			return (
				<>
					{content.file ? <FileOutputView {...content.file} /> : null}
					<RichDocumentView content={content} onEdit={onEdit} />
				</>
			);
		case "sheet":
			return <WorkbookView content={content} />;
		case "presentation":
			return <DeckReadView content={content} onEdit={onEdit} />;
		case "video":
			return <VideoOutputView content={content} />;
	}
}

export function VideoOutputView({
	content,
}: {
	content: Extract<OsOutputContent, { kind: "video" }>;
}) {
	return (
		<figure className="mx-auto grid w-full max-w-5xl gap-3">
			<video
				className="aspect-video w-full rounded-xl border border-kumo-line bg-black shadow-sm"
				controls
				preload="metadata"
				src={`/api/video-renders/${encodeURIComponent(content.renderId)}/media`}
			>
				<track kind="captions" />
				Your browser does not support MP4 playback.
			</video>
			{content.caption ? (
				<Text as="figcaption" role="body" tone="secondary">
					{content.caption}
				</Text>
			) : null}
		</figure>
	);
}

function RichNode({
	node,
	nodeKey,
}: {
	node: OsRichTextNode;
	nodeKey: string;
}) {
	const taskLabelId = useId();
	if (node.type === "text") {
		let child: React.ReactNode = node.text ?? "";
		for (const [index, mark] of (node.marks ?? []).entries()) {
			const key = `${nodeKey}-mark-${index}`;
			switch (mark.type) {
				case "bold":
					child = <strong key={key}>{child}</strong>;
					break;
				case "italic":
					child = <em key={key}>{child}</em>;
					break;
				case "underline":
					child = <u key={key}>{child}</u>;
					break;
				case "strike":
					child = <s key={key}>{child}</s>;
					break;
				case "code":
					child = <code key={key}>{child}</code>;
					break;
				case "link": {
					const href = mark.attrs?.href;
					child =
						typeof href === "string" && /^(https?:\/\/|mailto:)/i.test(href) ? (
							<a key={key} href={href} target="_blank" rel="noreferrer">
								{child}
							</a>
						) : (
							child
						);
					break;
				}
				case "textStyle":
					child = (
						<span
							key={key}
							style={{
								color:
									typeof mark.attrs?.color === "string"
										? mark.attrs.color
										: undefined,
								fontSize:
									typeof mark.attrs?.fontSize === "string" &&
									/^\d+(?:\.\d+)?px$/.test(mark.attrs.fontSize)
										? mark.attrs.fontSize
										: undefined,
								fontFamily:
									typeof mark.attrs?.fontFamily === "string"
										? mark.attrs.fontFamily
										: undefined,
							}}
						>
							{child}
						</span>
					);
					break;
				case "highlight":
					child = (
						<mark
							key={key}
							style={{
								background:
									typeof mark.attrs?.color === "string"
										? mark.attrs.color
										: undefined,
							}}
						>
							{child}
						</mark>
					);
			}
		}
		return child;
	}

	const children = (node.content ?? []).map((child, index) => (
		<RichNode
			key={`${nodeKey}-${index}`}
			node={child}
			nodeKey={`${nodeKey}-${index}`}
		/>
	));
	const style = {
		textAlign:
			typeof node.attrs?.textAlign === "string"
				? (node.attrs.textAlign as React.CSSProperties["textAlign"])
				: undefined,
		marginLeft:
			Number(node.attrs?.indent) > 0
				? Math.min(Number(node.attrs?.indent), MAX_INDENT) * INDENT_STEP_PX
				: undefined,
	};
	switch (node.type) {
		case "heading": {
			const level = Math.min(4, Math.max(1, Number(node.attrs?.level) || 2));
			const Tag = `h${level}` as "h1" | "h2" | "h3" | "h4";
			return (
				<Tag
					style={style}
					className={node.attrs?.variant === "title" ? "doc-title" : undefined}
				>
					{children}
				</Tag>
			);
		}
		case "table": {
			const first = node.content?.[0]?.content ?? [];
			const header =
				first.length > 0 && first.every((cell) => cell.type === "tableHeader");
			const rows = node.content ?? [];
			const renderRow = (row: OsRichTextNode, index: number) => (
				<RichNode key={index} node={row} nodeKey={`${nodeKey}-${index}`} />
			);
			return (
				<div
					className="document-table-scroll"
					role="region"
					aria-label="Document table"
					tabIndex={0}
				>
					<table>
						<colgroup>
							{first.map((cell, index) => {
								const width = Array.isArray(cell.attrs?.colwidth)
									? Number(cell.attrs.colwidth[0])
									: 0;
								return (
									<col
										key={index}
										style={width >= 40 && width <= 2000 ? { width } : undefined}
									/>
								);
							})}
						</colgroup>
						{header && <thead>{renderRow(rows[0]!, 0)}</thead>}
						<tbody>{rows.slice(header ? 1 : 0).map(renderRow)}</tbody>
					</table>
				</div>
			);
		}
		case "tableRow":
			return <tr>{children}</tr>;
		case "tableHeader":
		case "tableCell": {
			const Tag = node.type === "tableHeader" ? "th" : "td";
			return (
				<Tag
					scope={Tag === "th" ? "col" : undefined}
					colSpan={Math.max(1, Math.min(64, Number(node.attrs?.colspan) || 1))}
					rowSpan={Math.max(
						1,
						Math.min(1000, Number(node.attrs?.rowspan) || 1),
					)}
				>
					{children}
				</Tag>
			);
		}
		case "callout":
			return <aside data-type="callout">{children}</aside>;
		case "details":
			return <details open={node.attrs?.open === true}>{children}</details>;
		case "detailsSummary":
			return <summary>{children}</summary>;
		case "detailsContent":
			return <div>{children}</div>;
		case "taskList":
			return <ul data-type="taskList">{children}</ul>;
		case "taskItem":
			return (
				<li data-type="taskItem">
					<label>
						<input
							type="checkbox"
							checked={node.attrs?.checked === true}
							readOnly
							disabled
							aria-labelledby={taskLabelId}
						/>
					</label>
					<div id={taskLabelId}>{children}</div>
				</li>
			);
		case "hardBreak":
			return <br />;
		case "paragraph":
			return <p style={style}>{children}</p>;
		case "bulletList":
			return <ul>{children}</ul>;
		case "orderedList":
			return (
				<ol
					start={
						typeof node.attrs?.start === "number" ? node.attrs.start : undefined
					}
				>
					{children}
				</ol>
			);
		case "listItem":
			return <li>{children}</li>;
		case "blockquote":
			return <blockquote>{children}</blockquote>;
		case "codeBlock":
			return (
				<pre style={style}>
					<code>{children}</code>
				</pre>
			);
		case "horizontalRule":
			return <hr />;
		case "image": {
			const src = safeImageSource(node.attrs?.src);
			return src ? (
				<img
					src={src}
					width={
						typeof node.attrs?.width === "number" && node.attrs.width > 0
							? node.attrs.width
							: undefined
					}
					height={
						typeof node.attrs?.height === "number" && node.attrs.height > 0
							? node.attrs.height
							: undefined
					}
					alt={
						typeof node.attrs?.alt === "string"
							? node.attrs.alt
							: "Document visual"
					}
				/>
			) : null;
		}
		default:
			return <>{children}</>;
	}
}

/** Headings a saved document needs before its read view lists its contents. */
const READ_OUTLINE_MIN_HEADINGS = 3;

/**
 * The heading the reader is in: the last one whose top has passed the upper
 * fifth of the viewport, measured as the page scrolls in any scroll container.
 */
function useReadingHeading(
	article: HTMLElement | null,
	headingCount: number,
): number {
	const [active, setActive] = useState(0);
	useEffect(() => {
		if (!article || headingCount === 0) return;
		let frame = 0;
		const measure = () => {
			frame = 0;
			const headings = article.querySelectorAll<HTMLElement>(
				":scope > :is(h1, h2, h3, h4)",
			);
			const line = window.innerHeight * 0.2;
			let next = 0;
			headings.forEach((heading, index) => {
				if (heading.getBoundingClientRect().top <= line) next = index;
			});
			setActive(next);
		};
		const schedule = () => {
			if (!frame) frame = requestAnimationFrame(measure);
		};
		measure();
		window.addEventListener("scroll", schedule, {
			capture: true,
			passive: true,
		});
		window.addEventListener("resize", schedule);
		return () => {
			if (frame) cancelAnimationFrame(frame);
			window.removeEventListener("scroll", schedule, { capture: true });
			window.removeEventListener("resize", schedule);
		};
	}, [article, headingCount]);
	return active;
}

function RichDocumentView({
	content,
	onEdit,
}: {
	content: Extract<OsOutputContent, { kind: "document" }>;
	onEdit?: () => void;
}) {
	const document = normalizeDocumentContent(content).richText!;
	const [article, setArticle] = useState<HTMLElement | null>(null);
	const outline = useMemo(
		() => richTextOutline(document.content),
		[document.content],
	);
	// Every top-level heading renders, empty or not, so the DOM index of a
	// heading is its count among the headings before it.
	const domIndex = useMemo(() => {
		const indexes = new Map<number, number>();
		let count = 0;
		document.content.forEach((node, index) => {
			if (node.type !== "heading") return;
			indexes.set(index, count);
			count += 1;
		});
		return indexes;
	}, [document.content]);
	const withOutline = outline.length >= READ_OUTLINE_MIN_HEADINGS;
	const readingDom = useReadingHeading(
		withOutline ? article : null,
		outline.length,
	);
	// A fresh document saves one empty paragraph; that is still an empty page.
	const empty = document.content.every(
		(node) => node.type === "paragraph" && !node.content?.length,
	);
	if (empty && content.file) return null;
	if (empty) {
		return (
			<Empty
				appearance="quiet"
				className="document-read-empty mx-auto w-full max-w-[52rem]"
				icon={<FileText size={28} aria-hidden />}
				title="This document is empty"
				description={
					onEdit
						? "Open the editor to start writing. Type / on an empty line to add headings, lists, tables and images."
						: "Nothing has been written here yet."
				}
			>
				{onEdit ? (
					<Button size="sm" variant="secondary" onClick={onEdit}>
						<PencilSimple size={14} /> Start writing
					</Button>
				) : null}
			</Empty>
		);
	}
	const activeOutline = outline.findIndex(
		(item) => domIndex.get(item.position) === readingDom,
	);
	const jump = (item: DocumentOutlineItem) => {
		const heading = article?.querySelectorAll<HTMLElement>(
			":scope > :is(h1, h2, h3, h4)",
		)[domIndex.get(item.position) ?? -1];
		if (!heading) return;
		const reduce = window.matchMedia?.(
			"(prefers-reduced-motion: reduce)",
		).matches;
		heading.scrollIntoView({
			block: "start",
			behavior: reduce ? "auto" : "smooth",
		});
	};
	return (
		<div className="document-read-frame">
			<div
				className="document-read-layout"
				data-with-outline={withOutline || undefined}
			>
				<article
					ref={setArticle}
					className="document-page document-prose document-read-page mx-auto w-full bg-(--tedix-document-paper) text-(--tedix-document-ink)"
					data-kumo-part="document-paper"
				>
					{document.content.map((node, index) => (
						<RichNode
							key={`root-${index}`}
							node={node}
							nodeKey={`root-${index}`}
						/>
					))}
				</article>
				{withOutline ? (
					<aside className="document-read-outline">
						<DocumentOutline
							label="Contents"
							items={outline}
							activeIndex={activeOutline}
							onSelect={jump}
						/>
					</aside>
				) : null}
			</div>
		</div>
	);
}
