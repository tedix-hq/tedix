import { useQuery } from "@tanstack/react-query";
import type { TediSetup } from "@tedix/api-contract/contracts/tedis";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Link } from "@/components/kumo/link";
import { Button } from "@/components/kumo/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/kumo/collapsible";
import {
	PageSection,
	SectionHeader,
	SectionHeading,
	SectionTitle,
	SectionDescription,
	Collection,
} from "@/components/kumo/page";
import { Text } from "@/components/kumo/text";
import { ListSkeleton } from "@/components/list-skeleton";
import { ConnectionCapabilities } from "@/components/connection-capabilities";
import { tediSetupQueryOptions } from "@/lib/os-query-options";

export function SetupChip({
	tediId,
	setup,
	failed = false,
}: {
	tediId: string;
	setup?: TediSetup;
	failed?: boolean;
}) {
	const outstanding = setup?.items.filter((i) => i.state !== "ready").length;
	const label = failed
		? "unavailable"
		: !setup
			? "checking…"
			: setup.items.length === 0
				? "not needed"
				: outstanding
					? `${outstanding} to do`
					: "ready";
	return (
		<Button
			size="sm"
			variant="ghost"
			className={
				failed || outstanding ? "text-kumo-warning" : "text-kumo-subtle"
			}
			render={
				<Link
					href={`/team/${encodeURIComponent(tediId)}#setup`}
					variant="plain"
				/>
			}
		>
			Setup · {label}
		</Button>
	);
}

export function TediSetupChip({ tediId }: { tediId: string }) {
	const query = useQuery(tediSetupQueryOptions(tediId));
	return (
		<SetupChip tediId={tediId} setup={query.data} failed={query.isError} />
	);
}

function SetupItems({ items }: { items: TediSetup["items"] }) {
	return (
		<Collection>
			{items.map((item) => (
				<li key={item.id} className="grid min-w-0 gap-1 break-words px-4 py-3">
					<div className="flex flex-wrap items-center gap-2">
						<Link
							className="inline-flex min-h-11 items-center break-all"
							href={item.href}
						>
							{item.label}
						</Link>
						<Badge
							variant={
								item.state === "ready"
									? "success"
									: item.state === "missing"
										? "destructive"
										: "warning"
							}
						>
							{item.state === "needs_you"
								? "Needs you"
								: item.state === "missing"
									? "Missing"
									: "Ready"}
						</Badge>
					</div>
					<Text role="label" tone="secondary">
						{item.detail}
					</Text>
					<Text role="label" tone="secondary" className="break-all">
						Requirement ID: {item.id}
					</Text>
					<ConnectionCapabilities capabilities={item.capabilities} />
				</li>
			))}
		</Collection>
	);
}

function SetupGroups({ groups }: { groups: TediSetup["items"][] }) {
	return (
		<Collection>
			{groups.map((items) => {
				const first = items[0]!;
				const skill = first.href.startsWith("/skills/");
				const app = first.href.startsWith("/apps/");
				// The checklist contract has no owner title; use the service's explanatory text.
				const title = skill
					? (items
							.map(
								(item) =>
									item.detail.match(
										/^(?:Required by |Prerequisite declared by )(.+);/s,
									)?.[1],
							)
							.find(Boolean) ?? "Skill requirements")
					: app && items.length > 1
						? "App tools"
						: first.label;
				const missing = items.filter((item) => item.state === "missing").length;
				const needsYou = items.filter(
					(item) => item.state === "needs_you",
				).length;
				return (
					<li
						key={first.href}
						className="grid min-w-0 gap-2 break-words px-4 py-3"
					>
						<Text>{title}</Text>
						<div className="flex flex-wrap gap-2">
							{missing > 0 && (
								<Badge variant="destructive">{missing} missing</Badge>
							)}
							{needsYou > 0 && (
								<Badge variant="warning">{needsYou} need you</Badge>
							)}
						</div>
						<Text role="label" tone="secondary">
							{items.some((item) => item.kind === "build")
								? "Review this skill’s unregistered tools with its maintainer."
								: first.detail}
						</Text>
						<Link
							href={first.href}
							className="inline-flex min-h-11 items-center"
							aria-label={`${skill ? "Review skill" : app ? "Review app tools" : "Review setup"}: ${title}`}
						>
							{skill
								? "Review skill"
								: app
									? "Review app tools"
									: "Review setup"}
						</Link>
						{items.map((item) => (
							<ConnectionCapabilities
								key={item.id}
								capabilities={item.capabilities}
							/>
						))}
						<Collapsible>
							<CollapsibleTrigger>
								View {items.length}{" "}
								{items.length === 1 ? "requirement" : "requirements"} in
								diagnostics
							</CollapsibleTrigger>
							<CollapsibleContent>
								<SetupItems items={items} />
							</CollapsibleContent>
						</Collapsible>
					</li>
				);
			})}
		</Collection>
	);
}

export function SetupChecklist({ setup }: { setup: TediSetup }) {
	const outstanding = setup.items.filter((item) => item.state !== "ready");
	const ready = setup.items.filter((item) => item.state === "ready");
	// Keep exact destinations (including credential scope and instance) separate.
	const byDestination = new Map<string, TediSetup["items"]>();
	for (const item of outstanding) {
		const group = byDestination.get(item.href) ?? [];
		group.push(item);
		byDestination.set(item.href, group);
	}
	const groups = [...byDestination.values()];
	return (
		<div className="grid gap-3">
			{setup.items.length === 0 ? (
				<Text>No setup requirements are configured.</Text>
			) : outstanding.length > 0 ? (
				<>
					<Text>
						{outstanding.length}{" "}
						{outstanding.length === 1 ? "requirement" : "requirements"} to
						resolve across {groups.length} setup{" "}
						{groups.length === 1 ? "group" : "groups"}.
					</Text>
					<SetupGroups groups={groups.slice(0, 3)} />
					{groups.length > 3 && (
						<Collapsible>
							<CollapsibleTrigger>
								{groups.length - 3} more setup{" "}
								{groups.length === 4 ? "group" : "groups"}
							</CollapsibleTrigger>
							<CollapsibleContent>
								<SetupGroups groups={groups.slice(3)} />
							</CollapsibleContent>
						</Collapsible>
					)}
				</>
			) : (
				<Text>All declared setup requirements are ready.</Text>
			)}
			{ready.length > 0 && (
				<Collapsible>
					<CollapsibleTrigger>
						{ready.length} ready{" "}
						{ready.length === 1 ? "requirement" : "requirements"}
					</CollapsibleTrigger>
					<CollapsibleContent>
						<SetupItems items={ready} />
					</CollapsibleContent>
				</Collapsible>
			)}
			<Text role="label" tone="secondary">
				Checked{" "}
				<time dateTime={setup.observedAt}>
					{new Date(setup.observedAt).toLocaleString()}
				</time>
				. Setup readiness does not grant execution permission or confirm service
				health.
			</Text>
		</div>
	);
}

export function TediSetupChecklist({ tediId }: { tediId: string }) {
	const query = useQuery(tediSetupQueryOptions(tediId));
	return (
		<PageSection id="setup" className="scroll-mt-6">
			<SectionHeader>
				<SectionHeading>
					<SectionTitle>Setup</SectionTitle>
					<SectionDescription>
						Configured apps, tools, and skills.
					</SectionDescription>
				</SectionHeading>
				<Button
					variant="outline"
					size="sm"
					onClick={() => void query.refetch()}
					disabled={query.isFetching}
				>
					Check again
				</Button>
			</SectionHeader>
			{query.isPending ? (
				<ListSkeleton rows={3} />
			) : query.isError ? (
				<Alert variant="destructive">
					<AlertTitle>Setup is unavailable</AlertTitle>
					<AlertDescription>
						The configured requirements could not be checked. Try again to
						refresh the checklist.
					</AlertDescription>
				</Alert>
			) : (
				<SetupChecklist setup={query.data} />
			)}
		</PageSection>
	);
}
