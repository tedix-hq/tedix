import "./output-editor.css";
import type { OsOutputContent } from "@tedix/api-contract/schemas/os-workspaces";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/kumo/button";
import { Text } from "@/components/kumo/text";
import { isTypingEvent } from "@/lib/keyboard";
import { normalizePresentationContent } from "@/lib/output-models";
import { ReadOnlySlide } from "@/components/output-slide-element";
import { SLIDE_NAV_ATTRIBUTE, SlideDeckBar } from "@/components/slide-deck-bar";
import { useSlideEntrance, useSlideSwipe } from "@/components/slide-motion";
import {
	bareKey,
	ownsSlideKeys,
	slideNavigationTarget,
} from "@/components/slide-navigation";
import { SlidePresenter } from "@/components/slide-presenter";

/**
 * The committed deck: a rail of slide previews beside the current slide on
 * its desk, with the floating slide controls under it. Arrow keys, Page keys,
 * Space, Home and End browse; F presents; E opens the editor when there is
 * one; a horizontal swipe turns the page on touch screens.
 */
export function DeckReadView({
	content,
	onEdit,
}: {
	content: Extract<OsOutputContent, { kind: "presentation" }>;
	onEdit?: () => void;
}) {
	const deck = normalizePresentationContent(content).deck!;
	const [activeSlideId, setActiveSlideId] = useState(deck.activeSlideId);
	const [presenting, setPresenting] = useState(false);
	const stageRef = useRef<HTMLDivElement>(null);
	const slide =
		deck.slides.find((candidate) => candidate.id === activeSlideId) ??
		deck.slides[0];
	const index = slide ? deck.slides.indexOf(slide) : -1;
	const go = (target: number) => {
		const next = deck.slides[target];
		if (next) setActiveSlideId(next.id);
	};
	useSlideEntrance(stageRef, slide?.id, index);
	const swipe = useSlideSwipe(
		() => go(index - 1),
		() => go(index + 1),
	);
	// The read view has no focusable stage, so its keys listen on the page;
	// present mode handles its own while it is open.
	useEffect(() => {
		if (presenting) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.defaultPrevented || isTypingEvent(event)) return;
			// A thumbnail or a slide control keeps Space and Enter; arrows still
			// browse from it.
			const onNavigator =
				event.target instanceof HTMLElement &&
				event.target.closest(`.deck-read-thumb, [${SLIDE_NAV_ATTRIBUTE}]`) !==
					null;
			if (onNavigator ? event.key === " " : ownsSlideKeys(event.target)) return;
			const key = bareKey(event);
			if (key === "f" && index >= 0) {
				event.preventDefault();
				setPresenting(true);
				return;
			}
			if (key === "e" && onEdit) {
				event.preventDefault();
				onEdit();
				return;
			}
			if (key === null) return;
			const target = slideNavigationTarget(
				event.key,
				index,
				deck.slides.length,
			);
			if (target === null) return;
			event.preventDefault();
			setActiveSlideId(deck.slides[target]!.id);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [presenting, index, deck.slides, onEdit]);
	if (!slide)
		return (
			<Text role="body" tone="secondary">
				This presentation has no slides yet.
			</Text>
		);
	return (
		<div className="deck-read">
			<ol className="deck-read-rail m-0 list-none p-0" aria-label="Slides">
				{deck.slides.map((candidate, candidateIndex) => (
					<li key={candidate.id}>
						<Button
							aria-current={candidate.id === slide.id || undefined}
							aria-label={`Slide ${candidateIndex + 1}: ${candidate.name}`}
							className="deck-read-thumb w-full flex-col items-stretch gap-1 p-1 text-left"
							multiline
							onClick={() => setActiveSlideId(candidate.id)}
							size="sm"
							variant={candidate.id === slide.id ? "secondary" : "outline"}
						>
							<ReadOnlySlide
								slide={candidate}
								className="deck-read-thumb-canvas"
							/>
							<span className="deck-read-thumb-name">
								<span className="deck-read-thumb-number">
									{String(candidateIndex + 1).padStart(2, "0")}
								</span>
								{candidate.name}
							</span>
						</Button>
					</li>
				))}
			</ol>
			<div className="deck-read-desk">
				{/* The stage hugs the slide: its width is bounded by the column and
				    by the viewport height, and its height follows from 16:9. No
				    fixed-height stage, so there is no letterbox around the slide. */}
				<div ref={stageRef} className="deck-read-stage" {...swipe}>
					<ReadOnlySlide
						slide={slide}
						className="deck-read-canvas relative overflow-hidden rounded-md"
					/>
				</div>
				<div className="deck-read-footer grid justify-items-center gap-3">
					<SlideDeckBar
						index={index}
						count={deck.slides.length}
						onPrevious={() => go(index - 1)}
						onNext={() => go(index + 1)}
						onEdit={onEdit}
						onPresent={() => setPresenting(true)}
					/>
					{slide.notes ? (
						<Text
							role="body"
							tone="secondary"
							className="deck-read-notes m-0 justify-self-stretch"
						>
							{`Notes: ${slide.notes}`}
						</Text>
					) : null}
				</div>
			</div>
			{presenting && (
				<SlidePresenter
					deck={deck}
					slideId={slide.id}
					onNavigate={setActiveSlideId}
					onExit={() => setPresenting(false)}
				/>
			)}
		</div>
	);
}
