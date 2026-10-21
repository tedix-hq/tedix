"use client";

import {
	Tabs as KumoTabsPrimitive,
	type TabsProps as KumoTabsProps,
} from "@cloudflare/kumo/components/tabs";
import { Tabs as TabsPrimitive } from "@cloudflare/kumo/primitives/tabs";
import { CaretLeft, CaretRight } from "@phosphor-icons/react";
import {
	type RefObject,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";

import { cn } from "@/lib/utils";

import { Button } from "./button";

// Kumo does not forward an accessible name to its tablist.
// Keep the labelled group around its items-array API.
function KumoTabs({
	"aria-label": ariaLabel,
	className,
	variant = "segmented",
	listClassName,
	indicatorClassName,
	labels,
	tabs,
	...props
}: KumoTabsProps & { "aria-label": string }) {
	const groupRef = useRef<HTMLDivElement>(null);
	const scroll = (direction: -1 | 1) => {
		const list = groupRef.current?.querySelector('[role="tablist"]');
		if (!list) return;
		list.scrollBy({
			behavior: "smooth",
			left: direction * Math.max(list.clientWidth * 0.75, 160),
		});
	};
	return (
		<div
			ref={groupRef}
			role="group"
			aria-label={ariaLabel}
			className={cn(
				"group/routed-tabs relative min-w-0 max-w-full [&_[role=tablist]]:max-w-full [&_[role=tab]]:focus-visible:ring-inset max-sm:[&_[role=tablist]]:!h-auto max-sm:[&_[role=tab]]:!h-11 max-sm:[&_[role=tab]]:min-w-11 max-sm:[&_[role=tab]]:px-3 max-sm:[&_[data-kumo-part=overflow-control]]:min-h-11 max-sm:[&_[data-kumo-part=overflow-control]]:min-w-11 coarse:[&_[role=tablist]]:!h-auto coarse:[&_[role=tab]]:!h-11 coarse:[&_[role=tab]]:min-w-11 coarse:[&_[role=tab]]:px-3 coarse:[&_[data-kumo-part=overflow-control]]:min-h-11 coarse:[&_[data-kumo-part=overflow-control]]:min-w-11",
				variant === "segmented"
					? "[&_[role=tablist]]:!h-8 [&_[role=tablist]]:rounded-lg [&_[role=tablist]]:text-tedix-control [&_[role=tablist]]:leading-[1.125rem] [&_[role=tab]]:!h-7 [&_[role=tab]]:px-2.5 [&_[role=tab]]:py-0"
					: "[&_[role=tab]]:h-full [&_[role=tab]]:shrink-0 [&_[role=tab]]:justify-center [&_[role=tab]]:rounded-none [&_[role=tab]]:px-3 [&_[role=tab]]:py-0 [&_[role=tab]]:text-kumo-subtle [&_[role=tab]]:hover:bg-transparent [&_[role=tab]]:hover:text-kumo-default [&_[role=tab]]:aria-selected:text-kumo-default",
				className,
			)}
		>
			<KumoTabsPrimitive
				className="max-w-full"
				variant={variant}
				listClassName={cn(
					variant === "underline" &&
						"box-content h-9 w-full gap-0 border-kumo-hairline border-b pb-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
					listClassName,
				)}
				indicatorClassName={cn(
					variant === "underline" && "h-0.5 bg-kumo-brand",
					indicatorClassName,
				)}
				labels={labels}
				tabs={
					variant === "underline"
						? tabs?.map((tab) => ({
								...tab,
								className: cn("type-tedix-control", tab.className),
							}))
						: tabs
				}
				{...props}
			/>
			{/* Kumo 2.15 only renders overflow controls for segmented tabs. */}
			{variant === "underline" && (
				<>
					<Button
						type="button"
						data-kumo-part="overflow-control"
						aria-label={labels?.scrollStart ?? `Scroll ${ariaLabel} left`}
						className="absolute top-0 left-0 z-10 hidden bg-kumo-base group-has-[[role=tablist][data-overflow-start]]/routed-tabs:flex"
						size="icon-sm"
						variant="outline"
						onClick={() => scroll(-1)}
					>
						<CaretLeft aria-hidden size={14} />
					</Button>
					<Button
						type="button"
						data-kumo-part="overflow-control"
						aria-label={labels?.scrollEnd ?? `Scroll ${ariaLabel} right`}
						className="absolute top-0 right-0 z-10 hidden bg-kumo-base group-has-[[role=tablist][data-overflow-end]]/routed-tabs:flex"
						size="icon-sm"
						variant="outline"
						onClick={() => scroll(1)}
					>
						<CaretRight aria-hidden size={14} />
					</Button>
				</>
			)}
		</div>
	);
}

// Panel composition and the quiet Outputs filter still use the compound API.
// Routed bars use KumoTabs variant="underline".
function Tabs({
	className,
	orientation = "horizontal",
	...props
}: TabsPrimitive.Root.Props) {
	return (
		<TabsPrimitive.Root
			data-kumo-component="Tabs"
			data-orientation={orientation}
			className={cn(
				"group/tabs flex min-w-0 gap-2 font-medium data-[orientation=horizontal]:flex-col",
				className,
			)}
			orientation={orientation}
			{...props}
		/>
	);
}

function TabsList({
	className,
	variant,
	children,
	...props
}: TabsPrimitive.List.Props & {
	variant: "filter" | "line";
}) {
	const listRef = useRef<HTMLDivElement>(null);
	const overflow = useTabsOverflow(listRef);
	const accessibleName =
		typeof props["aria-label"] === "string" ? props["aria-label"] : "tabs";
	const scroll = (direction: -1 | 1) => {
		const element = listRef.current;
		if (!element) return;
		element.scrollBy({
			behavior: "smooth",
			left: direction * Math.max(element.clientWidth * 0.75, 160),
		});
	};
	return (
		<div className="relative min-w-0 max-w-full">
			<TabsPrimitive.List
				ref={listRef}
				data-kumo-part="list"
				data-variant={variant}
				data-overflowing={overflow.isOverflowing ? "" : undefined}
				data-overflow-start={overflow.canScrollStart ? "" : undefined}
				data-overflow-end={overflow.canScrollEnd ? "" : undefined}
				className={cn(
					"group/tabs-list relative isolate flex w-fit max-w-full min-w-0 scroll-px-(--scroll-fade-width) items-stretch overflow-x-auto overflow-y-hidden overscroll-x-contain [--scroll-fade-width:3rem] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
					"data-[variant=filter]:h-8 data-[variant=filter]:gap-1 data-[variant=filter]:bg-transparent max-sm:data-[variant=filter]:h-11 coarse:data-[variant=filter]:h-11",
					"data-[variant=line]:box-content data-[variant=line]:h-9 data-[variant=line]:w-full data-[variant=line]:gap-0 data-[variant=line]:border-kumo-hairline data-[variant=line]:border-b max-sm:data-[variant=line]:h-11 coarse:data-[variant=line]:h-11",
					"group-data-[orientation=vertical]/tabs:h-fit group-data-[orientation=vertical]/tabs:flex-col",
					className,
				)}
				{...props}
			>
				{children}
				<TabsPrimitive.Indicator
					className={cn(
						"absolute left-0 z-0 w-(--active-tab-width) translate-x-(--active-tab-left) transition-[transform,width,height,opacity] duration-tedix-structural ease-tedix-standard motion-reduce:transition-none data-[rendered=false]:scale-90 data-[rendered=false]:opacity-0",
						"group-data-[variant=filter]/tabs-list:top-(--active-tab-top) group-data-[variant=filter]/tabs-list:h-(--active-tab-height) group-data-[variant=filter]/tabs-list:rounded-lg group-data-[variant=filter]/tabs-list:bg-kumo-fill",
						"group-data-[variant=line]/tabs-list:bottom-0 group-data-[variant=line]/tabs-list:h-0.5 group-data-[variant=line]/tabs-list:bg-kumo-brand",
					)}
				/>
			</TabsPrimitive.List>
			{overflow.canScrollStart ? (
				<Button
					type="button"
					aria-label={`Scroll ${accessibleName} left`}
					className="absolute top-0 left-0 z-10 bg-kumo-base"
					size="icon-sm"
					variant="outline"
					onClick={() => scroll(-1)}
				>
					<CaretLeft aria-hidden size={14} />
				</Button>
			) : null}
			{overflow.canScrollEnd ? (
				<Button
					type="button"
					aria-label={`Scroll ${accessibleName} right`}
					className="absolute top-0 right-0 z-10 bg-kumo-base"
					size="icon-sm"
					variant="outline"
					onClick={() => scroll(1)}
				>
					<CaretRight aria-hidden size={14} />
				</Button>
			) : null}
		</div>
	);
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
	return (
		<TabsPrimitive.Tab
			data-kumo-part="tab"
			className={cn(
				"relative z-1 flex shrink-0 cursor-pointer items-center justify-center whitespace-nowrap rounded bg-transparent px-2.5 type-tedix-control text-kumo-subtle outline-none transition-colors motion-reduce:transition-none max-sm:min-w-11 max-sm:px-3 coarse:min-w-11 coarse:px-3",
				"hover:text-kumo-default focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-kumo-brand disabled:pointer-events-none disabled:opacity-50 aria-selected:text-kumo-default",
				"group-data-[variant=filter]/tabs-list:h-full group-data-[variant=filter]/tabs-list:rounded-lg group-data-[variant=filter]/tabs-list:px-3 group-data-[variant=filter]/tabs-list:hover:bg-kumo-tint max-sm:group-data-[variant=filter]/tabs-list:px-2",
				"group-data-[variant=line]/tabs-list:h-full group-data-[variant=line]/tabs-list:rounded-none group-data-[variant=line]/tabs-list:px-3 group-data-[variant=line]/tabs-list:py-0",
				className,
			)}
			{...props}
		/>
	);
}

function useTabsOverflow(ref: RefObject<HTMLElement | null>) {
	const [state, setState] = useState({
		isOverflowing: false,
		canScrollStart: false,
		canScrollEnd: false,
	});

	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) return;
		setState((current) => nextTabsOverflowState(element, current));
	}, [ref]);

	useEffect(() => {
		const element = ref.current;
		if (!element) return;

		const check = () => {
			setState((current) => nextTabsOverflowState(element, current));
		};
		const resizeObserver = new ResizeObserver(check);
		const mutationObserver = new MutationObserver(check);
		resizeObserver.observe(element);
		mutationObserver.observe(element, {
			childList: true,
			characterData: true,
			subtree: true,
		});
		element.addEventListener("scroll", check, { passive: true });
		check();

		return () => {
			resizeObserver.disconnect();
			mutationObserver.disconnect();
			element.removeEventListener("scroll", check);
		};
	}, [ref]);

	return state;
}

export function nextTabsOverflowState(
	element: HTMLElement,
	current: {
		isOverflowing: boolean;
		canScrollStart: boolean;
		canScrollEnd: boolean;
	},
) {
	const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth);
	const scrollLeft = Math.min(Math.max(0, element.scrollLeft), maxScrollLeft);
	const next = {
		isOverflowing: maxScrollLeft > 1,
		canScrollStart: scrollLeft > 1,
		canScrollEnd: maxScrollLeft - scrollLeft > 1,
	};
	return current.isOverflowing === next.isOverflowing &&
		current.canScrollStart === next.canScrollStart &&
		current.canScrollEnd === next.canScrollEnd
		? current
		: next;
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
	return (
		<TabsPrimitive.Panel
			className={cn(
				"min-w-0 flex-1 text-kumo-default type-tedix-body outline-none",
				className,
			)}
			{...props}
		/>
	);
}

export { KumoTabs, Tabs, TabsContent, TabsList, TabsTrigger };
