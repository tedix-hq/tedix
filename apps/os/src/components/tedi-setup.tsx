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
				? "no requirements"
				: outstanding
					? `${outstanding} to do`
					: "ready";
	return (
		<Link href={`/team/${encodeURIComponent(tediId)}#setup`} variant="plain">
			<Badge
				variant={
					failed || outstanding
						? "warning"
						: setup?.items.length
							? "success"
							: "outline"
				}
			>
				Setup · {label}
			</Badge>
		</Link>
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
				<li key={item.id} className="grid gap-1 px-4 py-3">
					<div className="flex flex-wrap items-center gap-2">
						<Link href={item.href}>{item.label}</Link>
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
				</li>
			))}
		</Collection>
	);
}

export function SetupChecklist({ setup }: { setup: TediSetup }) {
	const outstanding = setup.items.filter((item) => item.state !== "ready");
	const ready = setup.items.filter((item) => item.state === "ready");
	return (
		<div className="grid gap-3">
			{setup.items.length === 0 ? (
				<Text>
					No setup requirements are declared in this tedi’s configuration.
				</Text>
			) : outstanding.length > 0 ? (
				<SetupItems items={outstanding} />
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
				. Configuration readiness does not grant execution permission or verify
				provider health.
			</Text>
		</div>
	);
}

export function TediSetupChecklist({ tediId }: { tediId: string }) {
	const query = useQuery(tediSetupQueryOptions(tediId));
	return (
		<PageSection id="setup" className="md:col-span-2 scroll-mt-6">
			<SectionHeader>
				<SectionHeading>
					<SectionTitle>Setup</SectionTitle>
					<SectionDescription>
						Requirements from this tedi’s configured apps, tools, and skills.
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
