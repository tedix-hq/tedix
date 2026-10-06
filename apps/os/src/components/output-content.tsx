import type {
	OsOutputContent,
	OsRichTextNode,
} from "@tedix/api-contract/schemas/os-workspaces";
import { useState } from "react";
import { Button } from "@/components/kumo/button";
import { Text } from "@/components/kumo/text";
import { ReadOnlyElement } from "@/components/output-slide-element";
import {
	activeWorkbookSheet,
	normalizeDocumentContent,
	normalizePresentationContent,
	normalizeSheetContent,
	safeImageSource,
} from "@/lib/output-models";
import { evaluateWorkbook, formatWorkbookValue } from "@/lib/workbook-formulas";

export function OutputContentView({ content }: { content: OsOutputContent }) {
	switch (content.kind) {
		case "document":
			return <RichDocumentView content={content} />;
		case "sheet":
			return <WorkbookView content={content} />;
		case "presentation":
			return <DeckView content={content} />;
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
						typeof href === "string" && /^https?:\/\//i.test(href) ? (
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
	};
	switch (node.type) {
		case "heading": {
			const level = Math.min(4, Math.max(1, Number(node.attrs?.level) || 2));
			const Tag = `h${level}` as "h1" | "h2" | "h3" | "h4";
			return <Tag style={style}>{children}</Tag>;
		}
		case "paragraph":
			return <p style={style}>{children}</p>;
		case "bulletList":
			return <ul>{children}</ul>;
		case "orderedList":
			return <ol>{children}</ol>;
		case "listItem":
			return <li>{children}</li>;
		case "blockquote":
			return <blockquote>{children}</blockquote>;
		case "codeBlock":
			return (
				<pre>
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
	const initial = evaluateWorkbook(normalizeSheetContent(content).workbook!);
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
														textAlign: cell?.format?.horizontalAlign,
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
					<div className="sheet-read-tabs flex gap-1">
						{initial.sheets.map((candidate) => (
							<Button
								key={candidate.id}
								size="xs"
								variant={candidate.id === sheet.id ? "secondary" : "ghost"}
								onClick={() => setActiveSheetId(candidate.id)}
							>
								{candidate.name}
							</Button>
						))}
					</div>
				</div>
			</div>
		</div>
	);
}

function DeckView({
	content,
}: {
	content: Extract<OsOutputContent, { kind: "presentation" }>;
}) {
	const deck = normalizePresentationContent(content).deck!;
	const [activeSlideId, setActiveSlideId] = useState(deck.activeSlideId);
	const slide =
		deck.slides.find((candidate) => candidate.id === activeSlideId) ??
		deck.slides[0];
	if (!slide)
		return (
			<Text role="body" tone="secondary">
				This presentation has no slides yet.
			</Text>
		);
	return (
		<div className="grid gap-3 lg:grid-cols-[11rem_minmax(0,1fr)]">
			<ol className="m-0 grid max-h-[70vh] list-none content-start gap-2 overflow-auto p-0">
				{deck.slides.map((candidate, index) => (
					<li key={candidate.id}>
						{/*
						 * A real miniature, not the slide's name. The editor rail and
						 * the Outputs gallery both show a deck; the read view was the
						 * only place it was words. `ReadOnlyElement` is reused rather
						 * than approximated -- it positions in percentages and sizes
						 * type in `cqw`, so the same renderer scales into a thumbnail
						 * with no second implementation to drift.
						 */}
						<Button
							aria-current={candidate.id === slide.id || undefined}
							aria-label={`Slide ${index + 1}: ${candidate.name}`}
							className="deck-read-thumb w-full flex-col items-stretch gap-1 p-1 text-left"
							multiline
							onClick={() => setActiveSlideId(candidate.id)}
							size="sm"
							variant={candidate.id === slide.id ? "secondary" : "outline"}
						>
							<span
								className="deck-read-thumb-canvas"
								style={{ background: candidate.background }}
							>
								{candidate.elements.map((element) => (
									<ReadOnlyElement element={element} key={element.id} />
								))}
							</span>
							<span className="deck-read-thumb-name">
								{index + 1}. {candidate.name}
							</span>
						</Button>
					</li>
				))}
			</ol>
			<div>
				{/* Fit-to-stage, same rule the editor canvas earned: the stage is the
				    size container and the slide is bounded by BOTH its axes.
				    `aspect-video w-full` was width-driven only, so a short container
				    clipped the deck instead of letterboxing it. */}
				<div className="deck-read-stage">
					<div
						className="deck-read-canvas relative overflow-hidden rounded-md"
						style={{
							background: slide.background,
							containerType: "inline-size",
						}}
					>
						{slide.elements.map((element) => (
							<ReadOnlyElement key={element.id} element={element} />
						))}
					</div>
				</div>
				{slide.notes && (
					<Text role="body" tone="secondary" className="mt-3">
						Notes: {slide.notes}
					</Text>
				)}
			</div>
		</div>
	);
}
