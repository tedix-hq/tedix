import { Fragment, type ComponentProps, type ReactNode } from "react";
import { Text } from "@/components/kumo/text";
import { absoluteTime, relativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";

export function RelativeTime({ at, now }: { at: string; now?: Date }) {
	return (
		<time dateTime={at} title={absoluteTime(at)}>
			{relativeTime(at, now)}
		</time>
	);
}

export function LedgerRow({
	badge,
	title,
	meta,
	hint,
	actions,
	className,
	...liProps
}: Omit<ComponentProps<"li">, "title" | "children"> & {
	badge?: ReactNode;
	title: ReactNode;
	meta?: ReactNode;
	hint?: ReactNode;
	actions?: ReactNode;
}) {
	return (
		<li
			className={cn(
				"flex min-w-0 flex-wrap items-start gap-3 px-4 py-3 sm:flex-nowrap",
				className,
			)}
			{...liProps}
		>
			<div className="grid min-w-0 flex-1 gap-1">
				<Text
					as="p"
					role="body"
					className="m-0 flex min-w-0 flex-wrap items-center gap-2"
				>
					{badge}
					{title}
				</Text>
				{meta ? (
					<Text
						as="p"
						role="label"
						tone="secondary"
						className="m-0 line-clamp-2"
					>
						{meta}
					</Text>
				) : null}
				{hint ? (
					<Text
						as="p"
						role="label"
						tone="secondary"
						className="m-0 line-clamp-2"
					>
						{hint}
					</Text>
				) : null}
			</div>
			{actions ? <div className="shrink-0 flex gap-2">{actions}</div> : null}
		</li>
	);
}

export function LedgerRowMeta({
	items,
}: {
	items: readonly { term: string; value: ReactNode }[];
}) {
	return (
		<dl className="m-0 flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 text-kumo-subtle type-tedix-label">
			{items.map(({ term, value }, index) => (
				<Fragment key={term}>
					{index > 0 ? <span aria-hidden="true">·</span> : null}
					<div className="min-w-0">
						<dt className="sr-only">{term}</dt>
						<dd className="m-0">{value}</dd>
					</div>
				</Fragment>
			))}
		</dl>
	);
}
