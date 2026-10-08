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
import { useWorkWebMcpTools } from "@/components/work-webmcp-tools";

export const WORK_SECTIONS = [
	["Queue", "/work"],
	["Portfolio", "/work/portfolio"],
	["Cases", "/work/cases"],
	["Graph", "/work/graph"],
	["Clusters", "/work/clusters"],
	["Admission", "/work/admission"],
	["Attempts", "/work/attempts"],
	["Approvals", "/work/approvals"],
	["Interactions", "/work/interactions"],
	["Capacity", "/work/capacity"],
	["Attention", "/work/control"],
	["Recovery", "/work/recovery"],
	["Agents", "/work/agents"],
	["Office", "/work/office"],
] as const;

export const PRIMARY_WORK_SECTIONS = [
	WORK_SECTIONS[0],
	WORK_SECTIONS[13],
	WORK_SECTIONS[1],
	WORK_SECTIONS[10],
	WORK_SECTIONS[12],
	WORK_SECTIONS[6],
	WORK_SECTIONS[7],
] as const;
export const ADVANCED_WORK_SECTIONS = [
	WORK_SECTIONS[2],
	WORK_SECTIONS[3],
	WORK_SECTIONS[4],
	WORK_SECTIONS[5],
	WORK_SECTIONS[8],
	WORK_SECTIONS[9],
	WORK_SECTIONS[11],
] as const;

type WorkSectionPath = (typeof WORK_SECTIONS)[number][1];

export function workSectionForPathname(pathname: string) {
	if (pathname.startsWith("/work/projects/")) return WORK_SECTIONS[1];
	return (
		WORK_SECTIONS.find(([, href]) =>
			href === "/work" ? pathname === href : pathname.startsWith(href),
		) ?? WORK_SECTIONS[0]
	);
}

export function WorkShell() {
	useWorkWebMcpTools();
	const navigate = useNavigate();
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});
	const activeSection = workSectionForPathname(pathname);
	const activeAdvancedSection = ADVANCED_WORK_SECTIONS.find(
		([, href]) => href === activeSection[1],
	);
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="border-kumo-line border-b px-4 py-2 sm:hidden">
				<Select
					value={activeSection[1]}
					onValueChange={(value) => {
						void navigate({ to: value as WorkSectionPath });
					}}
				>
					<SelectTrigger aria-label="Work section" className="w-full">
						<SelectValue>
							{(value) =>
								WORK_SECTIONS.find(([, href]) => href === value)?.[0] ??
								activeSection[0]
							}
						</SelectValue>
					</SelectTrigger>
					<SelectContent align="start">
						{WORK_SECTIONS.map(([label, href]) => (
							<SelectItem key={href} value={href}>
								{label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
			<Tabs className="hidden gap-0 sm:flex" value={activeSection[1]}>
				<TabsList aria-label="Work factory" className="px-6" variant="line">
					{PRIMARY_WORK_SECTIONS.map(([label, href]) => (
						<TabsTrigger
							key={href}
							nativeButton={false}
							value={href}
							render={<Link to={href} preload="intent" />}
						>
							{label}
						</TabsTrigger>
					))}
					<DropdownMenu>
						<DropdownMenuTrigger
							render={
								<Button
									aria-label="More Work sections"
									className={
										activeAdvancedSection
											? "h-full rounded-none border-kumo-brand border-b-2 px-3 text-kumo-default"
											: "h-full rounded-none px-3 text-kumo-subtle"
									}
									variant="ghost"
								/>
							}
						>
							{activeAdvancedSection?.[0] ?? "More"}
							<CaretDown className="size-3.5" />
						</DropdownMenuTrigger>
						<DropdownMenuContent align="start">
							{ADVANCED_WORK_SECTIONS.map(([label, href]) => (
								<DropdownMenuItem
									key={href}
									onClick={() => void navigate({ to: href })}
								>
									{label}
								</DropdownMenuItem>
							))}
						</DropdownMenuContent>
					</DropdownMenu>
				</TabsList>
			</Tabs>
			<Outlet />
		</div>
	);
}
