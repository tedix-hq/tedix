import {
	CaretLeft,
	CaretRight,
	PencilSimple,
	Play,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { Button } from "@/components/kumo/button";
import { Kbd } from "@/components/kumo/kbd";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/kumo/tooltip";

/**
 * Marks a control that keeps the slide arrow keys working while it has focus:
 * a click on Next leaves focus there, and the next Right arrow should still
 * turn the page rather than do nothing.
 */
export const SLIDE_NAV_ATTRIBUTE = "data-slide-nav";

export function DeckBarButton({
	label,
	shortcut,
	disabled,
	pressed,
	onClick,
	children,
}: {
	label: string;
	shortcut?: string;
	disabled?: boolean;
	pressed?: boolean;
	onClick: () => void;
	children: ReactNode;
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						aria-label={label}
						aria-keyshortcuts={shortcut}
						aria-pressed={pressed}
						disabled={disabled}
						data-slide-nav=""
						className="slide-deck-bar-button"
						onClick={onClick}
					/>
				}
			>
				{children}
			</TooltipTrigger>
			<TooltipContent className="flex-row items-center gap-2">
				{label}
				{shortcut ? <Kbd>{shortcut}</Kbd> : null}
			</TooltipContent>
		</Tooltip>
	);
}

/**
 * The floating slide control pill under a deck: previous, the position, next,
 * then Edit (when the viewer may edit) and Present. Each control names its
 * keyboard shortcut in its tooltip and `aria-keyshortcuts`.
 */
export function SlideDeckBar({
	index,
	count,
	onPrevious,
	onNext,
	onEdit,
	onPresent,
	children,
}: {
	index: number;
	count: number;
	onPrevious: () => void;
	onNext: () => void;
	onEdit?: () => void;
	onPresent: () => void;
	/** Extra controls, after the navigation group. */
	children?: ReactNode;
}) {
	return (
		<div role="group" aria-label="Slide controls" className="slide-deck-bar">
			<DeckBarButton
				label="Previous slide"
				shortcut="←"
				disabled={index <= 0}
				onClick={onPrevious}
			>
				<CaretLeft size={16} weight="bold" />
			</DeckBarButton>
			<span className="slide-deck-bar-count" role="status">
				<span className="sr-only">Slide </span>
				{index + 1}
				<span aria-hidden> / </span>
				<span className="sr-only"> of </span>
				{count}
			</span>
			<DeckBarButton
				label="Next slide"
				shortcut="→"
				disabled={index >= count - 1}
				onClick={onNext}
			>
				<CaretRight size={16} weight="bold" />
			</DeckBarButton>
			<span className="slide-deck-bar-divider" aria-hidden />
			{children}
			{onEdit ? (
				<DeckBarButton label="Edit slides" shortcut="E" onClick={onEdit}>
					<PencilSimple size={16} />
				</DeckBarButton>
			) : null}
			<DeckBarButton label="Present" shortcut="F" onClick={onPresent}>
				<Play size={16} weight="fill" />
			</DeckBarButton>
		</div>
	);
}
