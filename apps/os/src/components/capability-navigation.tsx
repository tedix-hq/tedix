import { CaretLeft, CaretRight } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/kumo/button";
import { Link } from "@/components/kumo/link";

export const CAPABILITY_NAV_ITEMS = [
	{ id: "gateway", label: "Gateway", to: "/gateways" },
	{ id: "installed", label: "Installed apps", to: "/apps" },
	{ id: "browse", label: "Browse apps", to: "/explore/apps" },
	{ id: "skills", label: "Skills", to: "/skills" },
	{
		id: "organization",
		label: "Organization connections",
		to: "/admin/connections",
	},
	{ id: "personal", label: "My accounts", to: "/account/connections" },
] as const;

export const CAPABILITY_NAV_CLASSNAME =
	"flex min-w-0 max-w-full items-start gap-1 border-kumo-line border-b";
export const CAPABILITY_NAV_VIEWPORT_CLASSNAME =
	"min-w-0 flex-1 scroll-px-3 overflow-x-auto overscroll-x-contain";
export const CAPABILITY_NAV_TRACK_CLASSNAME =
	"flex w-max min-w-full items-center gap-1 pb-3";
export const CAPABILITY_NAV_EDGE_TOLERANCE = 12;

export function getCapabilityNavOverflowState({
	clientWidth,
	scrollLeft,
	scrollWidth,
}: {
	clientWidth: number;
	scrollLeft: number;
	scrollWidth: number;
}) {
	return {
		canScrollBack: scrollLeft > CAPABILITY_NAV_EDGE_TOLERANCE,
		canScrollForward:
			scrollLeft + clientWidth < scrollWidth - CAPABILITY_NAV_EDGE_TOLERANCE,
	};
}

/** Navigation between distinct inventories; installation never implies a credential. */
export function CapabilityNavigation({
	active,
}: {
	active:
		| "gateway"
		| "installed"
		| "browse"
		| "skills"
		| "organization"
		| "personal";
}) {
	const activeItemRef = useRef<HTMLSpanElement>(null);
	const viewportRef = useRef<HTMLDivElement>(null);
	const [overflowState, setOverflowState] = useState({
		canScrollBack: false,
		canScrollForward: false,
	});

	const updateOverflowState = useCallback(() => {
		const viewport = viewportRef.current;
		if (!viewport) return;
		const nextState = getCapabilityNavOverflowState({
			clientWidth: viewport.clientWidth,
			scrollLeft: viewport.scrollLeft,
			scrollWidth: viewport.scrollWidth,
		});
		// scrollIntoView can leave a tiny browser-dependent offset even when the
		// first destination is still the visible edge. Normalize that residue so
		// the back control does not consume space for a false edge.
		if (!nextState.canScrollBack && viewport.scrollLeft > 0) {
			viewport.scrollLeft = 0;
		}
		setOverflowState(nextState);
	}, []);

	// A route can enter this shared rail on either of its trailing items. Keep
	// the current destination visible without wrapping the information
	// architecture into a second row on narrow screens. Revealing an edge
	// control changes the viewport width, so repeat the reveal after either
	// control appears or disappears instead of leaving the active label clipped.
	useEffect(() => {
		activeItemRef.current?.scrollIntoView({
			block: "nearest",
			inline: "nearest",
		});
		const frame = requestAnimationFrame(updateOverflowState);
		return () => cancelAnimationFrame(frame);
	}, [
		active,
		overflowState.canScrollBack,
		overflowState.canScrollForward,
		updateOverflowState,
	]);

	useEffect(() => {
		const viewport = viewportRef.current;
		if (!viewport) return;

		viewport.addEventListener("scroll", updateOverflowState, { passive: true });
		const resizeObserver =
			typeof ResizeObserver === "undefined"
				? null
				: new ResizeObserver(updateOverflowState);
		resizeObserver?.observe(viewport);
		updateOverflowState();

		return () => {
			viewport.removeEventListener("scroll", updateOverflowState);
			resizeObserver?.disconnect();
		};
	}, [updateOverflowState]);

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
			aria-label="Gateway, apps, skills and accounts"
			className={CAPABILITY_NAV_CLASSNAME}
		>
			{overflowState.canScrollBack ? (
				<Button
					aria-label="Scroll capability navigation left"
					className="shrink-0 bg-kumo-base"
					size="icon-sm"
					variant="outline"
					onClick={() => scrollRail(-1)}
				>
					<CaretLeft aria-hidden size={14} />
				</Button>
			) : null}
			<div ref={viewportRef} className={CAPABILITY_NAV_VIEWPORT_CLASSNAME}>
				<div className={CAPABILITY_NAV_TRACK_CLASSNAME}>
					{CAPABILITY_NAV_ITEMS.map((item) => {
						const isActive = active === item.id;
						return (
							<span
								key={item.id}
								ref={isActive ? activeItemRef : undefined}
								className="shrink-0"
							>
								<Link
									variant="navigation"
									href={item.to}
									aria-current={isActive ? "page" : undefined}
								>
									{item.label}
								</Link>
							</span>
						);
					})}
				</div>
			</div>
			{overflowState.canScrollForward ? (
				<Button
					aria-label="Scroll capability navigation right"
					className="shrink-0 bg-kumo-base"
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
