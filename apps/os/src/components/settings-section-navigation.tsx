import { CaretLeft, CaretRight } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/kumo/button";
import { Link } from "@/components/kumo/link";

export type SettingsSectionItem = readonly [label: string, id: string];

const EDGE_TOLERANCE = 12;
const ACTIVE_OFFSET = 40;

function overflowState(viewport: HTMLDivElement) {
	return {
		canScrollBack: viewport.scrollLeft > EDGE_TOLERANCE,
		canScrollForward:
			viewport.scrollLeft + viewport.clientWidth <
			viewport.scrollWidth - EDGE_TOLERANCE,
	};
}

/**
 * Sticky anchor rail for long settings pages.
 *
 * The page owns section labels and ids; this shared composition owns genuine
 * link semantics, current-section feedback, responsive overflow, and the Kumo
 * focus/touch contract. It observes the nearest Page scroll root because OS
 * pages scroll inside the application shell rather than the document.
 */
export function SettingsSectionNavigation({
	ariaLabel,
	items,
}: {
	ariaLabel: string;
	items: readonly SettingsSectionItem[];
}) {
	const navigationRef = useRef<HTMLElement>(null);
	const viewportRef = useRef<HTMLDivElement>(null);
	const firstSection = items[0]?.[1] ?? "";
	const [activeSection, setActiveSection] = useState(() => {
		if (typeof window === "undefined") return firstSection;
		const hash = window.location.hash.slice(1);
		return items.some(([, id]) => id === hash) ? hash : firstSection;
	});
	const [overflow, setOverflow] = useState({
		canScrollBack: false,
		canScrollForward: false,
	});

	const updateOverflow = useCallback(() => {
		const viewport = viewportRef.current;
		if (viewport) setOverflow(overflowState(viewport));
	}, []);

	useEffect(() => {
		const viewport = viewportRef.current;
		if (!viewport) return;
		viewport.addEventListener("scroll", updateOverflow, { passive: true });
		const resizeObserver =
			typeof ResizeObserver === "undefined"
				? null
				: new ResizeObserver(updateOverflow);
		resizeObserver?.observe(viewport);
		updateOverflow();
		return () => {
			viewport.removeEventListener("scroll", updateOverflow);
			resizeObserver?.disconnect();
		};
	}, [updateOverflow]);

	useEffect(() => {
		const navigation = navigationRef.current;
		const scrollRoot = navigation?.closest<HTMLElement>('[data-slot="page"]');
		if (!navigation || !scrollRoot) return;
		let restoreHashUntil = 0;
		const stopHashRestoration = () => {
			restoreHashUntil = 0;
		};
		const restoreHashTarget = () => {
			if (Date.now() > restoreHashUntil) return;
			const hash = window.location.hash.slice(1);
			if (!items.some(([, id]) => id === hash)) return;
			document.getElementById(hash)?.scrollIntoView({ block: "start" });
		};

		const updateActiveSection = () => {
			const atScrollEnd =
				scrollRoot.scrollTop + scrollRoot.clientHeight >=
				scrollRoot.scrollHeight - EDGE_TOLERANCE;
			if (atScrollEnd) {
				setActiveSection(items.at(-1)?.[1] ?? firstSection);
				return;
			}
			const activationLine =
				navigation.getBoundingClientRect().bottom + ACTIVE_OFFSET;
			let current = firstSection;
			for (const [, id] of items) {
				const section = document.getElementById(id);
				if (!section || section.getBoundingClientRect().top > activationLine)
					break;
				current = id;
			}
			setActiveSection(current);
		};
		const updateFromHash = () => {
			const hash = window.location.hash.slice(1);
			if (items.some(([, id]) => id === hash)) {
				restoreHashUntil = Date.now() + 3000;
				setActiveSection(hash);
				restoreHashTarget();
			} else updateActiveSection();
		};
		const mutationObserver =
			typeof MutationObserver === "undefined"
				? null
				: new MutationObserver(restoreHashTarget);

		scrollRoot.addEventListener("scroll", updateActiveSection, {
			passive: true,
		});
		for (const eventName of ["wheel", "touchstart", "pointerdown", "keydown"]) {
			scrollRoot.addEventListener(eventName, stopHashRestoration, {
				passive: true,
			});
		}
		window.addEventListener("hashchange", updateFromHash);
		const resizeObserver =
			typeof ResizeObserver === "undefined"
				? null
				: new ResizeObserver(updateActiveSection);
		resizeObserver?.observe(scrollRoot);
		mutationObserver?.observe(scrollRoot, { childList: true, subtree: true });
		updateFromHash();

		return () => {
			scrollRoot.removeEventListener("scroll", updateActiveSection);
			for (const eventName of [
				"wheel",
				"touchstart",
				"pointerdown",
				"keydown",
			]) {
				scrollRoot.removeEventListener(eventName, stopHashRestoration);
			}
			window.removeEventListener("hashchange", updateFromHash);
			resizeObserver?.disconnect();
			mutationObserver?.disconnect();
		};
	}, [firstSection, items]);

	const scrollRail = (direction: -1 | 1) => {
		const viewport = viewportRef.current;
		if (!viewport) return;
		viewport.scrollBy({
			behavior: "smooth",
			left: direction * Math.max(viewport.clientWidth * 0.75, 160),
		});
	};

	return (
		<nav
			ref={navigationRef}
			aria-label={ariaLabel}
			className="sticky top-0 z-10 -mx-4 border-kumo-line border-b bg-kumo-base sm:-mx-6 lg:-mx-10"
		>
			<div
				ref={viewportRef}
				className="min-w-0 max-w-full scroll-px-12 overflow-x-auto overscroll-x-contain"
			>
				<div className="flex w-max min-w-full items-center gap-1 px-4 py-2 sm:px-6 lg:px-10">
					{items.map(([label, id]) => (
						<Link
							key={id}
							aria-current={activeSection === id ? "location" : undefined}
							data-section-current={activeSection === id || undefined}
							data-section-target={id}
							href={`#${id}`}
							variant="section"
						>
							{label}
						</Link>
					))}
				</div>
			</div>
			{overflow.canScrollBack ? (
				<Button
					aria-label={`Scroll ${ariaLabel} left`}
					className="absolute top-2 left-2 bg-kumo-base"
					size="icon-sm"
					variant="outline"
					onClick={() => scrollRail(-1)}
				>
					<CaretLeft aria-hidden size={14} />
				</Button>
			) : null}
			{overflow.canScrollForward ? (
				<Button
					aria-label={`Scroll ${ariaLabel} right`}
					className="absolute top-2 right-2 bg-kumo-base"
					size="icon-sm"
					variant="outline"
					onClick={() => scrollRail(1)}
				>
					<CaretRight aria-hidden size={14} />
				</Button>
			) : null}
		</nav>
	);
}
