"use client";

import * as React from "react";
import { cn } from "../lib/utils";

export interface ExpandableTextProps {
	/**
	 * Text content to display. Supports HTML <br> tags for line breaks.
	 */
	children: string;

	/**
	 * Maximum number of lines to show when collapsed
	 * @default 3
	 */
	maxLines?: number;

	/**
	 * Label for expand button
	 * @default "Show more"
	 */
	expandLabel?: string;

	/**
	 * Label for collapse button
	 * @default "Show less"
	 */
	collapseLabel?: string;

	/**
	 * Additional CSS class name
	 */
	className?: string;

	/**
	 * Force expanded state (controlled component)
	 */
	expanded?: boolean;

	/**
	 * Callback when expanded state changes
	 */
	onExpandedChange?: (expanded: boolean) => void;
}

interface SafeBrTextProps {
	/**
	 * Text content that may contain HTML <br> tags
	 */
	text: string;
}

/**
 * SafeBrText - Safely renders text with <br> tags converted to actual line breaks.
 * Only processes <br>, <br/>, and <br /> tags (case-insensitive).
 * All other HTML is rendered as plain text.
 */
function SafeBrText({ text }: SafeBrTextProps) {
	// Split on <br> variants (case-insensitive), trimming spaces
	const parts = text.split(/<br\s*\/?>/i);

	return (
		<>
			{parts.map((part, index) => (
				<React.Fragment key={index}>
					{part}
					{index < parts.length - 1 && <br />}
				</React.Fragment>
			))}
		</>
	);
}

/**
 * ExpandableText - Text component with line-clamp and expand/collapse functionality.
 * Automatically detects if text needs truncation using JavaScript measurement.
 * Responsive - recalculates on container resize.
 *
 * @example
 * ```tsx
 * <ExpandableText maxLines={3} expandLabel="Read more" collapseLabel="Read less">
 *   Long description text...
 * </ExpandableText>
 * ```
 *
 * @example
 * // With HTML line breaks
 * ```tsx
 * <ExpandableText maxLines={3}>
 *   First paragraph<br/><br/>Second paragraph with line breaks
 * </ExpandableText>
 * ```
 *
 * @example
 * // Controlled mode
 * ```tsx
 * const [isExpanded, setIsExpanded] = useState(false);
 * <ExpandableText
 *   expanded={isExpanded}
 *   onExpandedChange={setIsExpanded}
 * >
 *   Long text...
 * </ExpandableText>
 * ```
 */
function ExpandableText({
	children: text,
	maxLines = 3,
	expandLabel = "Show more",
	collapseLabel = "Show less",
	className,
	expanded: controlledExpanded,
	onExpandedChange,
}: ExpandableTextProps) {
	const [internalExpanded, setInternalExpanded] = React.useState(false);
	const [needsTruncation, setNeedsTruncation] = React.useState(false);
	const [truncatedText, setTruncatedText] = React.useState(text);
	const textRef = React.useRef<HTMLDivElement>(null);

	const isControlled = controlledExpanded !== undefined;
	const expanded = isControlled ? controlledExpanded : internalExpanded;

	// JavaScript-based truncation to insert button inline
	React.useEffect(() => {
		const element = textRef.current;
		if (!element || expanded) return;

		const checkAndTruncate = () => {
			// Get line height
			const styles = getComputedStyle(element);
			const lineHeight = parseFloat(styles.lineHeight);
			const maxHeight = lineHeight * maxLines;

			// Create a temporary element to measure
			const tempElement = element.cloneNode(true) as HTMLDivElement;
			tempElement.style.position = "absolute";
			tempElement.style.visibility = "hidden";
			tempElement.style.width = `${element.offsetWidth}px`;
			tempElement.style.whiteSpace = "pre-wrap";
			tempElement.style.wordWrap = "break-word";
			document.body.appendChild(tempElement);

			// Check if full text fits
			tempElement.innerHTML = "";
			tempElement.appendChild(document.createTextNode(text));

			if (tempElement.scrollHeight <= maxHeight) {
				setNeedsTruncation(false);
				setTruncatedText(text);
				document.body.removeChild(tempElement);
				return;
			}

			// Binary search for truncation point
			let low = 0;
			let high = text.length;
			let bestFit = text.substring(0, 50); // Default fallback

			while (low <= high) {
				const mid = Math.floor((low + high) / 2);
				const testText = text.substring(0, mid);

				tempElement.innerHTML = "";
				tempElement.textContent = `${testText}... ${expandLabel}`;

				if (tempElement.scrollHeight <= maxHeight) {
					bestFit = testText;
					low = mid + 1;
				} else {
					high = mid - 1;
				}
			}

			document.body.removeChild(tempElement);
			setTruncatedText(bestFit);
			setNeedsTruncation(true);
		};

		// Double requestAnimationFrame for accurate DOM measurements
		requestAnimationFrame(() => {
			requestAnimationFrame(checkAndTruncate);
		});
	}, [text, maxLines, expanded, expandLabel]);

	// Responsive - recalculate on resize
	React.useEffect(() => {
		const element = textRef.current;
		if (!element) return;

		const resizeObserver = new ResizeObserver(() => {
			// Trigger truncation recalculation
			if (!expanded) {
				requestAnimationFrame(() => {
					requestAnimationFrame(() => {
						const styles = getComputedStyle(element);
						const lineHeight = parseFloat(styles.lineHeight);
						const maxHeight = lineHeight * maxLines;

						const tempElement = element.cloneNode(true) as HTMLDivElement;
						tempElement.style.position = "absolute";
						tempElement.style.visibility = "hidden";
						tempElement.style.width = `${element.offsetWidth}px`;
						tempElement.style.whiteSpace = "pre-wrap";
						tempElement.style.wordWrap = "break-word";
						document.body.appendChild(tempElement);

						tempElement.innerHTML = "";
						tempElement.appendChild(document.createTextNode(text));

						if (tempElement.scrollHeight <= maxHeight) {
							setNeedsTruncation(false);
							setTruncatedText(text);
							document.body.removeChild(tempElement);
							return;
						}

						let low = 0;
						let high = text.length;
						let bestFit = text.substring(0, 50);

						while (low <= high) {
							const mid = Math.floor((low + high) / 2);
							const testText = text.substring(0, mid);

							tempElement.innerHTML = "";
							tempElement.textContent = `${testText}... ${expandLabel}`;

							if (tempElement.scrollHeight <= maxHeight) {
								bestFit = testText;
								low = mid + 1;
							} else {
								high = mid - 1;
							}
						}

						document.body.removeChild(tempElement);
						setTruncatedText(bestFit);
						setNeedsTruncation(true);
					});
				});
			}
		});

		resizeObserver.observe(element);

		return () => {
			resizeObserver.disconnect();
		};
	}, [text, maxLines, expanded, expandLabel]);

	const handleToggle = () => {
		if (isControlled) {
			onExpandedChange?.(!expanded);
		} else {
			setInternalExpanded(!expanded);
			onExpandedChange?.(!expanded);
		}
	};

	return (
		<div className={cn("relative", className)}>
			<div
				ref={textRef}
				className="m-0 whitespace-pre-wrap break-words text-foreground text-sm leading-relaxed"
			>
				{!expanded && needsTruncation ? (
					<>
						<SafeBrText text={truncatedText} />
						...{" "}
						<button
							className="inline border-0 bg-transparent p-0 font-medium text-foreground text-sm underline transition-opacity duration-200 hover:opacity-80 active:opacity-60"
							onClick={handleToggle}
							type="button"
							aria-expanded={expanded}
						>
							{expandLabel}
						</button>
					</>
				) : (
					<>
						<SafeBrText text={text} />
						{needsTruncation && expanded && (
							<>
								{" "}
								<button
									className="inline border-0 bg-transparent p-0 font-medium text-foreground text-sm underline transition-opacity duration-200 hover:opacity-80 active:opacity-60"
									onClick={handleToggle}
									type="button"
									aria-expanded={expanded}
								>
									{collapseLabel}
								</button>
							</>
						)}
					</>
				)}
			</div>
		</div>
	);
}

export { ExpandableText };
