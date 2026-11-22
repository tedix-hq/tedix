import { DotsThree } from "@phosphor-icons/react";
import { useRouterState } from "@tanstack/react-router";
import { Fragment, useId } from "react";
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
import {
	openableWorkViews,
	WORK_VIEWS,
	workViewsByGroup,
	type WorkView,
} from "@/lib/work-views";
import { OS_COPY } from "@/shared/os-copy";

function viewLink(view: WorkView, agentHref: string) {
	if (view.id === "agents") return <OsRouterLink to={agentHref} />;
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
 *
 * It lists only what opens: a view backed by a Work app appears once that app
 * is installed. Agents always has a destination, because Capacity needs no
 * app, and stands for Office and Capacity too.
 */
export function WorkMoreViewsMenu({
	apps,
	agentNavigation,
}: {
	apps: Parameters<typeof openableWorkViews>[0];
	agentNavigation?: { active: boolean; href: string };
}) {
	const itemId = useId();
	const label = OS_COPY.workHome.moreViews;
	const selectedView = useRouterState({
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
	const agents = WORK_VIEWS.find((view) => view.id === "agents")!;
	const activeView =
		agentNavigation?.active ||
		["office", "capacity"].includes(selectedView?.id ?? "")
			? agents
			: selectedView;
	const openable = openableWorkViews(apps);
	const groups = workViewsByGroup(
		WORK_VIEWS.filter(
			(view) =>
				view.id === "agents" ||
				(openable.includes(view) && !["office", "capacity"].includes(view.id)),
		),
	);
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
						{activeView ? (
							<span data-tab-label>{activeView.label}</span>
						) : (
							<span data-tab-label className="sm:hidden">
								{OS_COPY.workHome.more}
							</span>
						)}
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
									// A link item stays open by default and would cover the page
									// it just opened.
									closeOnClick
									// The name is the view; its sentence is read as the description.
									aria-labelledby={`${itemId}-${view.id}`}
									aria-describedby={`${itemId}-${view.id}-about`}
									aria-current={activeView?.id === view.id ? "page" : undefined}
									render={viewLink(
										view,
										agentNavigation?.href ?? "/work?app=agents",
									)}
									className="items-start py-2 aria-[current=page]:bg-kumo-tint"
								>
									<span className="grid min-w-0 gap-0.5">
										<Text as="span" weight="medium" id={`${itemId}-${view.id}`}>
											{view.label}
										</Text>
										<Text
											as="span"
											role="caption"
											tone="secondary"
											id={`${itemId}-${view.id}-about`}
										>
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
