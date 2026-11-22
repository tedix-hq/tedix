import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileText, CaretLeft, CaretRight } from "@phosphor-icons/react";
import type { OsOutputContent } from "@tedix/api-contract/schemas/os-workspaces";
import { slideDeckLogo } from "@tedix/api-contract/utils/presentation-style";
import { Button } from "./kumo/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "./kumo/dialog";
import { OutputContentView } from "./output-content";
import { ReadOnlySlide } from "./output-slide-element";
import { normalizePresentationContent } from "@/lib/output-models";
import { useOutputContentWithImages } from "@/lib/use-output-assets";
import { osQuery } from "@/lib/os-query-options";

type Citation = {
	outputId: string;
	revisionId: string;
	title: string;
	slide?: number;
	inline?: boolean;
};

function PreviewBody({
	outputId,
	content,
	slide,
}: {
	outputId: string;
	content: OsOutputContent;
	slide?: number;
}) {
	const body = useOutputContentWithImages(outputId, content);
	const [page, setPage] = useState(slide ?? 1);
	if (body.kind !== "presentation")
		return slide ? (
			<p>This source has no slides.</p>
		) : (
			<OutputContentView content={body} />
		);
	const deck = normalizePresentationContent(body).deck!;
	const current = deck.slides[page - 1];
	if (!current) return <p>This slide is unavailable in the cited version.</p>;
	return (
		<div className="grid gap-2">
			<ReadOnlySlide
				slide={current}
				theme={deck.theme}
				logo={slideDeckLogo(deck, page - 1)}
				className="relative aspect-video overflow-hidden rounded-md"
			/>
			<div className="flex items-center justify-center gap-3">
				<Button
					aria-label="Previous slide"
					variant="ghost"
					size="icon-sm"
					disabled={page === 1}
					onClick={() => setPage(page - 1)}
				>
					<CaretLeft />
				</Button>
				<span aria-live="polite">
					Slide {page} of {deck.slides.length}
				</span>
				<Button
					aria-label="Next slide"
					variant="ghost"
					size="icon-sm"
					disabled={page === deck.slides.length}
					onClick={() => setPage(page + 1)}
				>
					<CaretRight />
				</Button>
			</div>
		</div>
	);
}

function Revision({ outputId, revisionId, slide }: Citation) {
	const query = useQuery(
		osQuery.osWorkspaces.outputs.history.queryOptions({
			input: { outputId, revisionId },
		}),
	);
	if (query.isPending) return <p role="status">Opening source…</p>;
	const revision = query.data?.revisions.find(
		(row) => row.id === revisionId && row.outputId === outputId,
	);
	if (query.isError || !revision?.content)
		return <p role="status">This version is unavailable.</p>;
	return (
		<PreviewBody
			key={revision.id}
			outputId={outputId}
			content={revision.content}
			slide={slide}
		/>
	);
}

export function CitedOutput(props: Citation) {
	const [open, setOpen] = useState(false);
	const label = props.title + (props.slide ? " · Slide " + props.slide : "");
	return (
		<div className="min-w-0">
			{props.inline && (
				<div className="max-h-80 overflow-auto rounded-md border border-kumo-line p-2">
					<Revision {...props} />
				</div>
			)}
			<Button variant="ghost" onClick={() => setOpen(true)}>
				<FileText aria-hidden="true" />
				{label}
			</Button>
			{open && (
				<Dialog open onOpenChange={setOpen}>
					<DialogContent size="xl">
						<DialogHeader>
							<DialogTitle>{props.title}</DialogTitle>
						</DialogHeader>
						<Revision {...props} />
					</DialogContent>
				</Dialog>
			)}
		</div>
	);
}
