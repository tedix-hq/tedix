import { Children, Fragment, type ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/utils";

interface MarqueeProps extends ComponentPropsWithoutRef<"div"> {
	className?: string;
	reverse?: boolean;
	pauseOnHover?: boolean;
	children: React.ReactNode;
	vertical?: boolean;
	repeat?: number;
}

export function Marquee({
	className,
	reverse = false,
	pauseOnHover = false,
	children,
	vertical = false,
	repeat = 4,
	...props
}: MarqueeProps) {
	const childArray = Children.toArray(children);
	const cycleCount = Math.max(1, repeat);

	const renderCycle = (cycleKey: string) => (
		<div
			aria-hidden={cycleKey === "duplicate" ? true : undefined}
			className={cn("flex shrink-0 justify-around gap-[--gap]", {
				"flex-row pr-[--gap]": !vertical,
				"flex-col pb-[--gap]": vertical,
			})}
		>
			{Array.from({ length: cycleCount }).map((_, repeatIndex) =>
				childArray.map((child, childIndex) => (
					<Fragment key={`${cycleKey}-${repeatIndex}-${childIndex}`}>
						{child}
					</Fragment>
				)),
			)}
		</div>
	);

	return (
		<div
			{...props}
			className={cn(
				"group flex overflow-hidden p-2 [--duration:40s] [--gap:1rem]",
				{
					"flex-row": !vertical,
					"flex-col": vertical,
				},
				className,
			)}
		>
			<div
				className={cn("flex shrink-0 will-change-transform", {
					"animate-marquee flex-row": !vertical,
					"animate-marquee-vertical flex-col": vertical,
					"group-hover:[animation-play-state:paused]": pauseOnHover,
					"[animation-direction:reverse]": reverse,
				})}
			>
				{renderCycle("primary")}
				{renderCycle("duplicate")}
			</div>
		</div>
	);
}
