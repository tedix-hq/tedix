import { Breadcrumbs as KumoBreadcrumbs } from "@cloudflare/kumo/components/breadcrumbs";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

type BreadcrumbItem = { label: string; href?: string };

function BreadcrumbTitle({
	label,
	focusable = false,
}: {
	label: string;
	focusable?: boolean;
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<span
						className="block max-w-full truncate"
						tabIndex={focusable ? 0 : undefined}
					>
						{label}
					</span>
				}
			/>
			<TooltipContent role="tooltip">{label}</TooltipContent>
		</Tooltip>
	);
}

/** Section headings are labels; only actual destinations belong in the trail. */
export function Breadcrumbs({
	items,
	section,
}: {
	items: readonly BreadcrumbItem[];
	section?: string;
}) {
	return (
		<div className="flex min-w-0 items-center gap-1.5 type-tedix-control">
			{section ? (
				<>
					<span className="shrink-0 text-kumo-subtle max-sm:hidden">
						{section}
					</span>
					<span aria-hidden="true" className="text-kumo-inactive max-sm:hidden">
						›
					</span>
				</>
			) : null}
			<KumoBreadcrumbs
				size="sm"
				className="mr-0 h-auto min-w-0 overflow-clip type-tedix-control [overflow-clip-margin:0.25rem] [&_.truncate]:min-w-0 [&_.truncate]:overflow-clip [&_.truncate]:[overflow-clip-margin:0.25rem] max-sm:[&>div:first-child>span:first-child]:hidden max-sm:[&>div:first-child>span:first-child+span]:hidden [&_[aria-current=page]]:text-kumo-default [&_[data-kumo-part=link]]:min-w-0 [&_[data-kumo-part=link]]:max-w-[45%] [&_[data-kumo-part=link]>span]:min-w-0 [&_[data-kumo-part=link]>span]:truncate"
			>
				{items.flatMap((item, index) => [
					...(index
						? [<KumoBreadcrumbs.Separator key={`separator-${index}`} />]
						: []),
					item.href ? (
						<KumoBreadcrumbs.Link key={index} href={item.href}>
							<BreadcrumbTitle label={item.label} />
						</KumoBreadcrumbs.Link>
					) : (
						<KumoBreadcrumbs.Current key={index}>
							<BreadcrumbTitle label={item.label} focusable />
						</KumoBreadcrumbs.Current>
					),
				])}
			</KumoBreadcrumbs>
		</div>
	);
}
