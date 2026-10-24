import "./output-editor.css";
import {
	ArrowLeft,
	ArrowRight,
	ArrowsOut,
	Notepad,
	SquaresFour,
} from "@phosphor-icons/react";
import type { OsPresentationDeck } from "@tedix/api-contract/schemas/os-workspaces";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/kumo/button";
import { ReadOnlyElement } from "@/components/output-slide-element";
import { useSlideEntrance, useSlideSwipe } from "@/components/slide-motion";
import { bareKey, slideNavigationTarget } from "@/components/slide-navigation";

function trapFocus(
	dialog: HTMLDivElement | null,
	event: KeyboardEvent | React.KeyboardEvent,
) {
	if (event.key !== "Tab" || !dialog) return false;
	const focusable = Array.from(
		dialog.querySelectorAll<HTMLElement>(
			'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
		),
	);
	const current = focusable.indexOf(document.activeElement as HTMLElement);
	if (
		focusable.length === 0 ||
		(event.shiftKey
			? current > 0
			: current !== -1 && current < focusable.length - 1)
	)
		return false;
	event.preventDefault();
	focusable[event.shiftKey ? focusable.length - 1 : 0]?.focus();
	return true;
}

/**
 * Present mode, shared by the editor and the read view. Keys: the slide
 * navigation grammar, F to leave, and Escape in order — close the jump menu,
 * then clear the editor's element selection, then exit.
 */
export function SlidePresenter({
	deck,
	slideId,
	onNavigate,
	onExit,
	hasSelection = false,
	onDeselect,
}: {
	deck: OsPresentationDeck;
	slideId: string;
	onNavigate: (slideId: string) => void;
	onExit: () => void;
	hasSelection?: boolean;
	onDeselect?: () => void;
}) {
	const [jumpOpen, setJumpOpen] = useState(false);
	const [showNotes, setShowNotes] = useState(false);
	const index = Math.max(
		0,
		deck.slides.findIndex((slide) => slide.id === slideId),
	);
	const slide = deck.slides[index];
	const go = (target: number) => {
		const next = deck.slides[target];
		if (next) onNavigate(next.id);
	};
	const handleKey = (event: KeyboardEvent | React.KeyboardEvent) => {
		if (event.key === "Escape") {
			event.preventDefault();
			if (jumpOpen) setJumpOpen(false);
			else if (hasSelection) onDeselect?.();
			else onExit();
			return;
		}
		if (bareKey(event) === "f") {
			event.preventDefault();
			onExit();
			return;
		}
		// A focused control keeps Space and Enter for itself.
		if (
			event.key === " " &&
			(event.target as HTMLElement | null)?.tagName === "BUTTON"
		)
			return;
		const target = slideNavigationTarget(event.key, index, deck.slides.length);
		if (target === null) return;
		event.preventDefault();
		go(target);
	};
	const handleKeyRef = useRef(handleKey);
	handleKeyRef.current = handleKey;
	const dialogRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLDivElement>(null);
	useSlideEntrance(canvasRef, slide?.id, index);
	const swipe = useSlideSwipe(
		() => go(index - 1),
		() => go(index + 1),
	);
	const openerRef = useRef<HTMLElement | null>(
		typeof document !== "undefined" &&
			document.activeElement instanceof HTMLElement
			? document.activeElement
			: null,
	);
	// Clicking the slide, or a jump-menu button that then unmounts, leaves
	// focus on the page body. Present mode is modal, so it still owns the keys.
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.defaultPrevented) return;
			if (trapFocus(dialogRef.current, event)) return;
			if (dialogRef.current?.contains(event.target as Node)) return;
			handleKeyRef.current(event);
		};
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("keydown", onKey);
			if (openerRef.current?.isConnected) openerRef.current.focus();
		};
	}, []);
	if (!slide) return null;
	return (
		<div
			ref={dialogRef}
			className="slides-present fixed inset-0 z-50 grid grid-rows-[minmax(0,1fr)_auto] gap-4 bg-(--tedix-presentation-stage) p-4 text-(--tedix-presentation-stage-text)"
			role="dialog"
			aria-modal="true"
			aria-label="Presentation mode"
			data-show-notes={showNotes || undefined}
			onKeyDown={(event) => {
				event.stopPropagation();
				if (trapFocus(dialogRef.current, event)) return;
				handleKey(event);
			}}
		>
			<div className="absolute top-4 right-4 z-10 flex gap-2">
				<Button
					size="sm"
					variant="secondary"
					aria-pressed={showNotes}
					onClick={() => setShowNotes((visible) => !visible)}
				>
					<Notepad size={14} /> Notes
				</Button>
				<Button
					size="sm"
					variant="secondary"
					onClick={() => document.documentElement.requestFullscreen?.()}
				>
					<ArrowsOut size={14} /> Full screen
				</Button>
				<Button autoFocus size="sm" variant="secondary" onClick={onExit}>
					Exit
				</Button>
			</div>
			<div
				className="slides-present-progress"
				role="progressbar"
				aria-label="Presentation progress"
				aria-valuemin={1}
				aria-valuemax={deck.slides.length}
				aria-valuenow={index + 1}
				style={{
					transform: `scaleX(${(index + 1) / deck.slides.length})`,
				}}
			/>
			<div className="slides-present-body">
				<div className="slides-present-stage" {...swipe}>
					<div
						ref={canvasRef}
						className="slides-editor-canvas relative overflow-hidden"
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
				{showNotes && (
					<aside
						aria-label="Speaker notes"
						className="slides-present-notes overflow-y-auto whitespace-pre-wrap rounded-md p-4"
					>
						{slide.notes || "No speaker notes for this slide."}
					</aside>
				)}
			</div>
			<div className="relative flex items-center justify-center gap-3">
				<Button
					size="sm"
					variant="secondary"
					aria-label="Previous slide"
					disabled={index === 0}
					onClick={() => go(index - 1)}
				>
					<ArrowLeft size={16} />
				</Button>
				<Button
					size="sm"
					variant="secondary"
					aria-label="Jump to slide"
					aria-expanded={jumpOpen}
					onClick={() => setJumpOpen((open) => !open)}
				>
					<SquaresFour size={14} />
					<span className="tabular-nums">
						{index + 1} / {deck.slides.length}
					</span>
				</Button>
				<Button
					size="sm"
					variant="secondary"
					aria-label="Next slide"
					disabled={index === deck.slides.length - 1}
					onClick={() => go(index + 1)}
				>
					<ArrowRight size={16} />
				</Button>
				{jumpOpen && (
					<nav
						aria-label="Slides"
						className="slides-present-jump absolute bottom-full left-1/2 mb-2 grid -translate-x-1/2 justify-center max-h-[50vh] grid-cols-[repeat(auto-fill,2.5rem)] gap-1 overflow-y-auto rounded-lg p-2"
					>
						{deck.slides.map((candidate, candidateIndex) => (
							<Button
								key={candidate.id}
								size="sm"
								variant={candidateIndex === index ? "default" : "ghost"}
								aria-current={candidateIndex === index || undefined}
								aria-label={`Slide ${candidateIndex + 1}: ${candidate.name}`}
								className="tabular-nums"
								onClick={() => {
									go(candidateIndex);
									setJumpOpen(false);
								}}
							>
								{candidateIndex + 1}
							</Button>
						))}
					</nav>
				)}
			</div>
		</div>
	);
}
