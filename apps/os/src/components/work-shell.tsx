import {
	Link,
	Outlet,
	useNavigate,
	useRouterState,
} from "@tanstack/react-router";
import { CaretDown } from "@phosphor-icons/react";
import { Button } from "@/components/kumo/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/kumo/dropdown-menu";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/kumo/tabs";
import { lazy, Suspense } from "react";
import { cn } from "@/lib/utils";

const WorkWebMcpTools = lazy(() =>
	import("@/components/work-webmcp-tools").then((module) => ({
		default: module.WorkWebMcpTools,
	})),
);

export type WorkSection = {
	/** Unique id; also the mobile picker's value. */
	id: string;
	label: string;
	to: WorkSectionPath;
	search?: { disposition: "completed" };
};

type WorkSectionPath =
	| "/work/attention"
	| "/work/needs-you"
	| "/work/portfolio"
	| "/work/queue"
	| "/work/agents"
	| "/work/office"
	| "/work/attempts"
	| "/work/approvals"
	| "/work/interactions"
	| "/work/cases"
	| "/work/graph"
	| "/work/clusters"
	| "/work/admission"
	| "/work/capacity"
	| "/work/recovery";

export type WorkTab = {
	id: "attention" | "needs-you" | "board" | "history";
	label: string;
	sections: readonly WorkSection[];
};

/** Each primary tab opens on its first section. */
export const WORK_TABS: readonly WorkTab[] = [
	{
		id: "attention",
		label: "Attention",
		sections: [{ id: "attention", label: "Attention", to: "/work/attention" }],
	},
	{
		id: "needs-you",
		label: "Needs you",
		sections: [{ id: "needs-you", label: "Needs you", to: "/work/needs-you" }],
	},
	{
		id: "board",
		label: "Board",
		sections: [
			{ id: "projects", label: "Projects", to: "/work/portfolio" },
			{ id: "queue", label: "Queue", to: "/work/queue" },
			{ id: "agents", label: "Agents", to: "/work/agents" },
			{ id: "office", label: "Office", to: "/work/office" },
		],
	},
	{
		id: "history",
		label: "History",
		sections: [
			{ id: "activity", label: "Activity", to: "/work/attempts" },
			{
				id: "completed",
				label: "Completed",
				to: "/work/queue",
				search: { disposition: "completed" },
			},
		],
	},
];

/** Everything else stays one click away under More. */
export const MORE_WORK_SECTIONS: readonly WorkSection[] = [
	{ id: "approvals", label: "Approvals", to: "/work/approvals" },
	{ id: "interactions", label: "Requests", to: "/work/interactions" },
	{ id: "cases", label: "Cases", to: "/work/cases" },
	{ id: "graph", label: "Graph", to: "/work/graph" },
	{ id: "clusters", label: "Clusters", to: "/work/clusters" },
	{ id: "admission", label: "Admission", to: "/work/admission" },
	{ id: "capacity", label: "Capacity", to: "/work/capacity" },
	{ id: "recovery", label: "Recovery", to: "/work/recovery" },
];

export const ALL_WORK_SECTIONS: readonly WorkSection[] = [
	...WORK_TABS.flatMap((tab) => tab.sections),
	...MORE_WORK_SECTIONS,
];

const BOARD = WORK_TABS.find((tab) => tab.id === "board")!;

/**
 * The tab (or More) and section a Work URL belongs to. Record pages (projects,
 * items, runs) sit on the Board; completed Work is History.
 */
export function workLocation(
	pathname: string,
	search: { disposition?: unknown } = {},
): { tab: WorkTab | null; section: WorkSection } {
	const path = pathname.replace(/\/$/, "");
	if (path === "/work/queue" && search.disposition === "completed")
		return { tab: WORK_TABS[3]!, section: WORK_TABS[3]!.sections[1]! };
	for (const tab of WORK_TABS)
		for (const section of tab.sections)
			if (
				!section.search &&
				(path === section.to || path.startsWith(`${section.to}/`))
			)
				return { tab, section };
	const more = MORE_WORK_SECTIONS.find(
		(section) => path === section.to || path.startsWith(`${section.to}/`),
	);
	if (more) return { tab: null, section: more };
	return { tab: BOARD, section: BOARD.sections[0]! };
}

function SectionLink({
	section,
	current,
}: {
	section: WorkSection;
	current: boolean;
}) {
	const className = cn(
		"type-tedix-label no-underline",
		current
			? "font-semibold text-kumo-default"
			: "text-kumo-subtle hover:text-kumo-default",
	);
	const ariaCurrent = current ? ("page" as const) : undefined;
	return section.search ? (
		<Link
			to={section.to}
			search={section.search}
			preload="intent"
			className={className}
			aria-current={ariaCurrent}
		>
			{section.label}
		</Link>
	) : (
		<Link
			to={section.to}
			preload="intent"
			className={className}
			aria-current={ariaCurrent}
		>
			{section.label}
		</Link>
	);
}

export function WorkShell() {
	const navigate = useNavigate();
	const location = useRouterState({
		select: (state) => ({
			pathname: state.location.pathname,
			disposition: (state.location.search as { disposition?: unknown })
				?.disposition,
		}),
	});
	const { tab: activeTab, section: activeSection } = workLocation(
		location.pathname,
		{ disposition: location.disposition },
	);
	const go = (section: WorkSection) =>
		void navigate(
			section.search
				? { to: section.to, search: section.search }
				: { to: section.to },
		);
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<Suspense fallback={null}>
				<WorkWebMcpTools />
			</Suspense>
			<div className="border-kumo-line border-b px-4 py-2 sm:hidden">
				<Select
					value={activeSection.id}
					onValueChange={(value) => {
						const section = ALL_WORK_SECTIONS.find(({ id }) => id === value);
						if (section) go(section);
					}}
				>
					<SelectTrigger aria-label="Work section" className="w-full">
						<SelectValue>
							{(value) =>
								ALL_WORK_SECTIONS.find(({ id }) => id === value)?.label ??
								activeSection.label
							}
						</SelectValue>
					</SelectTrigger>
					<SelectContent align="start">
						{ALL_WORK_SECTIONS.map((section) => (
							<SelectItem key={section.id} value={section.id}>
								{section.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
			<Tabs className="hidden gap-0 sm:flex" value={activeTab?.id ?? "more"}>
				<TabsList aria-label="Work" className="px-6" variant="line">
					{WORK_TABS.map((tab) => (
						<TabsTrigger
							key={tab.id}
							nativeButton={false}
							value={tab.id}
							render={<Link to={tab.sections[0]!.to} preload="intent" />}
						>
							{tab.label}
						</TabsTrigger>
					))}
					<DropdownMenu>
						<DropdownMenuTrigger
							render={
								<Button
									aria-label="More Work sections"
									className={
										activeTab
											? "h-full rounded-none px-3 text-kumo-subtle"
											: "h-full rounded-none border-kumo-brand border-b-2 px-3 text-kumo-default"
									}
									variant="ghost"
								/>
							}
						>
							{activeTab ? "More" : activeSection.label}
							<CaretDown className="size-3.5" />
						</DropdownMenuTrigger>
						<DropdownMenuContent align="start">
							{MORE_WORK_SECTIONS.map((section) => (
								<DropdownMenuItem key={section.id} onClick={() => go(section)}>
									{section.label}
								</DropdownMenuItem>
							))}
						</DropdownMenuContent>
					</DropdownMenu>
				</TabsList>
			</Tabs>
			{activeTab && activeTab.sections.length > 1 ? (
				<nav
					aria-label={`${activeTab.label} views`}
					className="hidden gap-4 px-6 pt-3 sm:flex"
				>
					{activeTab.sections.map((section) => (
						<SectionLink
							key={section.id}
							section={section}
							current={section.id === activeSection.id}
						/>
					))}
				</nav>
			) : null}
			<Outlet />
		</div>
	);
}
