import { DotsThree } from "@phosphor-icons/react";
import { useRouterState } from "@tanstack/react-router";
import { Fragment } from "react";
import { Button } from "@/components/kumo/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuLabel,
	DropdownMenuLinkItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/kumo/dropdown-menu";
import { Text } from "@/components/kumo/text";
import { OsRouterLink } from "@/components/kumo/link-provider";
import { WORK_VIEWS, workViewsByGroup, type WorkView } from "@/lib/work-views";
import { OS_COPY } from "@/shared/os-copy";

function viewLink(view: WorkView) {
	return view.to === "/work" ? (
		<OsRouterLink to={view.to} search={view.search} />
	) : (
		<OsRouterLink to={view.to} />
	);
}

/**
 * The one quiet entry to every secondary Work view. Feed and Deck stay the
 * only primary views; this menu sits at the end of their row and never grows
 * into a tab bar.
 */
export function WorkMoreViewsMenu() {
	const label = OS_COPY.workHome.moreViews;
	const activeView = useRouterState({
		select: ({ location }) => {
			const pathname = location.pathname.replace(/\/$/, "");
			const search = location.search as Record<string, unknown>;
			return WORK_VIEWS.find((view) =>
				view.to === "/work"
					? pathname === view.to &&
						(!search.app || search.app === view.search.app) &&
						Object.entries(view.search).every(
							([key, value]) => search[key] === value,
						)
					: pathname === view.to || pathname.startsWith(`${view.to}/`),
			);
		},
	});
	const groups = workViewsByGroup();
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						variant="ghost"
						{...(activeView
							? {
									size: "sm" as const,
									"aria-label": `${label}: ${activeView.label}`,
								}
							: { size: "icon-sm" as const, "aria-label": label })}
						data-active={activeView ? "true" : undefined}
						className="shrink-0 text-kumo-subtle data-[active]:bg-kumo-tint data-[active]:text-kumo-default data-[popup-open]:bg-kumo-tint data-[popup-open]:text-kumo-default"
					>
						<DotsThree size={20} weight="bold" aria-hidden="true" />
						{activeView?.label}
					</Button>
				}
			/>
			<DropdownMenuContent
				side="top"
				align="end"
				collisionPadding={8}
				className="w-72 max-w-[calc(100vw-1rem)] sm:w-80"
			>
				{groups.map((group, index) => (
					<Fragment key={group.id}>
						{index > 0 && <DropdownMenuSeparator />}
						<DropdownMenuGroup>
							<DropdownMenuLabel>{group.label}</DropdownMenuLabel>
							{group.views.map((view) => (
								<DropdownMenuLinkItem
									key={view.id}
									data-work-view={view.id}
									aria-current={activeView?.id === view.id ? "page" : undefined}
									render={viewLink(view)}
									className="items-start py-2 aria-[current=page]:bg-kumo-tint"
								>
									<span className="grid min-w-0 gap-0.5">
										<Text as="span" weight="medium">
											{view.label}
										</Text>
										<Text as="span" role="caption" tone="secondary">
											{view.description}
										</Text>
									</span>
								</DropdownMenuLinkItem>
							))}
						</DropdownMenuGroup>
					</Fragment>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
