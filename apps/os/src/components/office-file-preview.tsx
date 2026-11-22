import { useContext, useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
	officeCellText,
	spreadsheetColumnLabel,
} from "@tedix/api-contract/utils/office-file-blocks";
import {
	readOfficeFile,
	type OfficeFileContent,
	type OfficeFileFormat,
} from "@tedix/api-contract/utils/office-file-read";
import { Button } from "@/components/kumo/button";
import { KumoTabs } from "@/components/kumo/tabs";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/kumo/table";
import { Text } from "@/components/kumo/text";
import { ChatOutputLinkContext } from "@/components/chat-markdown";
import {
	editableCopyContent,
	editableCopyKind,
	editableCopyTitle,
} from "@/lib/office-file-copy";
import {
	osQuery,
	osQueryKeys,
	workspaceResourcesQueryOptions,
} from "@/lib/os-query-options";

/** Larger files are offered as a download; reading them would stall the page. */
export const OFFICE_PREVIEW_MAX_BYTES = 20 * 1024 * 1024;
const PREVIEW_ROWS = 500;
const PREVIEW_COLUMNS = 52;

type Loaded =
	| { status: "loading" }
	| { status: "error"; message: string }
	| { status: "ready"; content: OfficeFileContent };

const KIND_LABEL = {
	sheet: "sheet",
	document: "doc",
	presentation: "slides",
} as const;

/**
 * A read-only look at an uploaded spreadsheet, Word document or slide deck,
 * read in the browser from the file itself, with a button that turns it into
 * an editable Tedix sheet, doc or slides file.
 */
export function OfficeFilePreview({
	workspaceId,
	resourceId,
	url,
	filename,
	format,
	allowEditableCopy = true,
}: {
	workspaceId: string;
	resourceId: string;
	url: string;
	filename: string;
	format: OfficeFileFormat;
	allowEditableCopy?: boolean;
}) {
	const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
	// The signed link rotates while the file stays the same; read it once.
	const latestUrl = useRef(url);
	latestUrl.current = url;
	useEffect(() => {
		let cancelled = false;
		setLoaded({ status: "loading" });
		void (async () => {
			try {
				const response = await fetch(latestUrl.current);
				if (!response.ok) throw new Error("The file could not be downloaded.");
				const content = await readOfficeFile(
					new Uint8Array(await response.arrayBuffer()),
					format,
				);
				if (!cancelled) setLoaded({ status: "ready", content });
			} catch (error) {
				if (!cancelled)
					setLoaded({
						status: "error",
						message:
							error instanceof Error
								? error.message
								: "The file could not be read.",
					});
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [workspaceId, resourceId, format]);

	if (loaded.status === "loading")
		return (
			<Text as="p" role="body" tone="secondary">
				Reading file…
			</Text>
		);
	if (loaded.status === "error")
		return (
			<Text as="p" role="body">
				{loaded.message} Download it to open it.
			</Text>
		);
	const { content } = loaded;
	return (
		<div className="grid min-w-0 gap-3" data-office-preview={content.kind}>
			{allowEditableCopy ? (
				<EditableCopy
					workspaceId={workspaceId}
					filename={filename}
					content={content}
				/>
			) : null}
			{content.kind === "sheet" ? (
				<SheetPreview content={content} />
			) : content.kind === "document" ? (
				<DocumentPreview content={content} />
			) : (
				<SlidesPreview content={content} />
			)}
			{content.truncated && (
				<Text as="p" role="caption" tone="secondary">
					This file is larger than Tedix reads at once, so only its start is
					shown.
				</Text>
			)}
		</div>
	);
}

function EditableCopy({
	workspaceId,
	filename,
	content,
}: {
	workspaceId: string;
	filename: string;
	content: OfficeFileContent;
}) {
	const queryClient = useQueryClient();
	const links = useContext(ChatOutputLinkContext);
	const kind = editableCopyKind(content);
	const create = useMutation(
		osQuery.osWorkspaces.outputs.create.mutationOptions(),
	);
	const install = useMutation(
		osQuery.osWorkspaces.gadgets.installOutputEditor.mutationOptions(),
	);
	const [createdId, setCreatedId] = useState<string | null>(null);
	const pending = create.isPending || install.isPending;
	const makeCopy = async () => {
		const { output } = await create.mutateAsync({
			kind,
			title: editableCopyTitle(filename),
			workspaceId,
			content: editableCopyContent(content),
		});
		setCreatedId(output.id);
		const { gadget } = await install.mutateAsync({
			workspaceId,
			outputId: output.id,
			kind,
		});
		await Promise.all([
			queryClient.invalidateQueries({ queryKey: osQueryKeys.outputs() }),
			queryClient.invalidateQueries({ queryKey: osQueryKeys.gadgets() }),
			queryClient.invalidateQueries({
				queryKey: workspaceResourcesQueryOptions(workspaceId).queryKey,
			}),
		]);
		if (links.openEditor) links.openEditor(gadget.id);
		else links.openOutput?.(output.id);
	};
	const error = create.error ?? install.error;
	return (
		<div className="flex flex-wrap items-center gap-2">
			<Button
				size="sm"
				variant="secondary"
				disabled={pending}
				onClick={() => void makeCopy().catch(() => undefined)}
			>
				{pending ? "Making a copy…" : "Make an editable copy"}
			</Button>
			<Text as="span" role="caption" tone={error ? "error" : "secondary"}>
				{error
					? `The copy could not be made. ${error.message}`
					: createdId && !pending
						? `Saved as a Tedix ${KIND_LABEL[kind]} in this workspace.`
						: `Saves a Tedix ${KIND_LABEL[kind]} you can edit. The upload stays as it is.`}
			</Text>
		</div>
	);
}

function SheetPreview({
	content,
}: {
	content: Extract<OfficeFileContent, { kind: "sheet" }>;
}) {
	const [active, setActive] = useState(0);
	const sheet = content.sheets[active] ?? content.sheets[0]!;
	const rows = sheet.rows.slice(0, PREVIEW_ROWS);
	const widest = sheet.rows.reduce((max, row) => Math.max(max, row.length), 0);
	const width = Math.min(PREVIEW_COLUMNS, Math.max(1, widest));
	return (
		<div className="grid min-w-0 gap-2">
			{content.sheets.length > 1 && (
				<KumoTabs
					aria-label="Sheets"
					variant="underline"
					value={String(active)}
					onValueChange={(value) => setActive(Number(value))}
					tabs={content.sheets.map((item, index) => ({
						value: String(index),
						label: item.name,
					}))}
				/>
			)}
			{rows.length === 0 ? (
				<Text as="p" role="body" tone="secondary">
					This sheet is empty.
				</Text>
			) : (
				<Table
					scrollLabel={`${sheet.name}, first rows`}
					containerClassName="max-h-[70vh] rounded-lg border border-kumo-line"
				>
					<TableHeader>
						<TableRow>
							<TableHead scope="col" className="w-12 text-right">
								<span className="sr-only">Row</span>
							</TableHead>
							{Array.from({ length: width }, (_, column) => (
								<TableHead key={column} scope="col">
									{spreadsheetColumnLabel(column)}
								</TableHead>
							))}
						</TableRow>
					</TableHeader>
					<TableBody>
						{rows.map((row, rowIndex) => (
							<TableRow key={rowIndex}>
								<TableHead
									scope="row"
									className="text-right text-kumo-subtle tabular-nums"
								>
									{rowIndex + 1}
								</TableHead>
								{Array.from({ length: width }, (_, column) => {
									const cell = row[column] ?? null;
									return (
										<TableCell
											key={column}
											className={
												typeof cell === "number"
													? "text-right tabular-nums whitespace-nowrap"
													: "max-w-[24rem] whitespace-pre-wrap wrap-anywhere"
											}
										>
											{officeCellText(cell)}
										</TableCell>
									);
								})}
							</TableRow>
						))}
					</TableBody>
				</Table>
			)}
			{(sheet.rows.length > rows.length || widest > width) && (
				<Text as="p" role="caption" tone="secondary">
					Showing {rows.length} of {sheet.rows.length} rows
					{widest > width
						? ` and columns A to ${spreadsheetColumnLabel(width - 1)}`
						: ""}
					. Make an editable copy to see every cell.
				</Text>
			)}
		</div>
	);
}

function DocumentPreview({
	content,
}: {
	content: Extract<OfficeFileContent, { kind: "document" }>;
}) {
	if (content.blocks.length === 0)
		return (
			<Text as="p" role="body" tone="secondary">
				This document has no text.
			</Text>
		);
	return (
		<article className="grid min-w-0 max-w-[52rem] gap-3">
			{content.blocks.map((block, index) =>
				block.type === "heading" ? (
					<Text
						key={index}
						as={`h${Math.min(6, block.level + 1)}` as "h2"}
						role={block.level === 1 ? "title" : "section"}
						weight="semibold"
					>
						{block.text}
					</Text>
				) : block.type === "paragraph" ? (
					<Text key={index} as="p" role="body" className="whitespace-pre-wrap">
						{block.text}
					</Text>
				) : (
					<Table
						key={index}
						containerClassName="rounded-lg border border-kumo-line"
					>
						<TableBody>
							{block.rows.map((row, rowIndex) => (
								<TableRow key={rowIndex}>
									{row.map((cell, column) => (
										<TableCell
											key={column}
											className="whitespace-pre-wrap wrap-anywhere"
										>
											{cell}
										</TableCell>
									))}
								</TableRow>
							))}
						</TableBody>
					</Table>
				),
			)}
		</article>
	);
}

function SlidesPreview({
	content,
}: {
	content: Extract<OfficeFileContent, { kind: "slides" }>;
}) {
	if (content.slides.length === 0)
		return (
			<Text as="p" role="body" tone="secondary">
				This presentation has no slides.
			</Text>
		);
	return (
		<ol className="m-0 grid list-none gap-2 p-0" aria-label="Slides">
			{content.slides.map((slide, index) => (
				<li
					key={index}
					className="grid gap-1 rounded-lg border border-kumo-line p-3"
				>
					<Text as="span" role="caption" tone="secondary">
						Slide {index + 1}
					</Text>
					<Text as="h3" role="section" weight="semibold">
						{slide.title || "Untitled slide"}
					</Text>
					{slide.text.length > 0 && (
						<ul className="m-0 grid gap-0.5 pl-5">
							{slide.text.map((line, lineIndex) => (
								<li key={lineIndex}>
									<Text as="span" role="body">
										{line}
									</Text>
								</li>
							))}
						</ul>
					)}
					{slide.notes && (
						<Text as="p" role="caption" tone="secondary">
							Speaker notes: {slide.notes}
						</Text>
					)}
				</li>
			))}
		</ol>
	);
}
