import "./output-editor.css";
import type {
	OsOutputContent,
	OsRichTextNode,
} from "@tedix/api-contract/schemas/os-workspaces";
import { lazy, Suspense, useId, useMemo, useState } from "react";
import { SegmentedControl } from "@/components/kumo/segmented-control";
import { Text } from "@/components/kumo/text";
import { DeckReadView } from "@/components/deck-read-view";
import {
	activeWorkbookSheet,
	INDENT_STEP_PX,
	MAX_INDENT,
	normalizeSheetContent,
	safeImageSource,
} from "@/lib/output-models";
import { normalizeDocumentContent } from "@tedix/api-contract/utils/os-document";
import { evaluateWorkbook, formatWorkbookValue } from "@/lib/workbook-formulas";

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
					<RichDocumentView content={content} />
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

function RichDocumentView({
	content,
}: {
	content: Extract<OsOutputContent, { kind: "document" }>;
}) {
	const document = normalizeDocumentContent(content).richText!;
	if (document.content.length === 0) {
		return (
			<Text role="body" tone="secondary">
				This document has no content yet.
			</Text>
		);
	}
	return (
		<article
			className="document-page document-prose mx-auto w-full max-w-[52rem] bg-(--tedix-document-paper) px-4 py-8 text-[16px] text-(--tedix-document-ink) leading-relaxed sm:px-10 sm:py-10 [&_a]:text-(--tedix-document-link) [&_blockquote]:border-(--tedix-document-rule) [&_blockquote]:border-l-4 [&_blockquote]:pl-4 [&_h1]:text-[26px] [&_h1]:font-semibold [&_h2]:text-[21px] [&_h2]:font-semibold [&_h3]:text-[17px] [&_h3]:font-semibold [&_img]:max-w-full [&_img]:h-auto [&_mark]:text-(--tedix-document-ink) [&_ol]:list-decimal [&_ol]:pl-6 [&_pre]:overflow-auto [&_pre]:rounded-lg [&_pre]:bg-(--tedix-document-code-bg) [&_pre]:p-4 [&_pre]:text-(--tedix-document-code-fg) [&_ul]:list-disc [&_ul]:pl-6"
			data-kumo-part="document-paper"
		>
			{document.content.map((node, index) => (
				<RichNode key={`root-${index}`} node={node} nodeKey={`root-${index}`} />
			))}
		</article>
	);
}

function WorkbookView({
	content,
}: {
	content: Extract<OsOutputContent, { kind: "sheet" }>;
}) {
	// Evaluate formulas once per content, not on every tab click.
	const initial = useMemo(
		() => evaluateWorkbook(normalizeSheetContent(content).workbook!),
		[content],
	);
	const [activeSheetId, setActiveSheetId] = useState(initial.activeSheetId);
	const sheet =
		initial.sheets.find((candidate) => candidate.id === activeSheetId) ??
		activeWorkbookSheet(initial);
	return (
		<div className="grid gap-2">
			<div className="sheet-read-desk">
				<div className="sheet-page sheet-read-page">
					<div className="sheet-read-grid">
						<table className="border-collapse text-sm">
							<thead className="sticky top-0 bg-kumo-elevated">
								<tr>
									<th className="border border-kumo-line px-2" />
									{sheet.columns.map((column) => (
										<th
											key={column.id}
											className="border border-kumo-line px-3 py-2 text-left"
											style={{ minWidth: column.width }}
										>
											{column.label}
										</th>
									))}
								</tr>
							</thead>
							<tbody>
								{sheet.rows.map((row, rowIndex) => (
									<tr key={`row-${rowIndex}`}>
										<th className="border border-kumo-line bg-kumo-elevated px-2 text-right font-normal text-kumo-subtle">
											{rowIndex + 1}
										</th>
										{sheet.columns.map((column, columnIndex) => {
											const cell = row[columnIndex] ?? null;
											return (
												<td
													key={column.id}
													className="border border-kumo-line px-3 py-2"
													style={{
														background: cell?.format?.fillColor,
														color: cell?.format?.textColor,
														fontWeight: cell?.format?.bold ? 700 : undefined,
														fontStyle: cell?.format?.italic
															? "italic"
															: undefined,
														textAlign:
															cell?.format?.horizontalAlign ??
															(typeof cell?.value === "number"
																? "right"
																: undefined),
													}}
												>
													{formatWorkbookValue(cell)}
												</td>
											);
										})}
									</tr>
								))}
							</tbody>
						</table>
					</div>
					{/* Tabs live INSIDE the page, as they do in the editor: the grid
					    scrolls beneath them and the page stays one object. */}
					<SegmentedControl
						ariaLabel="Workbook sheets"
						compact
						value={sheet.id}
						options={initial.sheets.map((candidate) => ({
							value: candidate.id,
							label: candidate.name,
						}))}
						onValueChange={setActiveSheetId}
					/>
				</div>
			</div>
		</div>
	);
}
