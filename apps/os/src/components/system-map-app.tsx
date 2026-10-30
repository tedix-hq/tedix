import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { SystemMapConfig } from "@tedix/api-contract/schemas/os-system-map";
import { LoadError } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import {
	Collapsible,
	CollapsibleDefaultTrigger,
	CollapsibleDefaultContent,
} from "@/components/kumo/collapsible";
import { Link } from "@/components/kumo/link";
import {
	Collection,
	PageSection,
	SectionDescription,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";
import { Text } from "@/components/kumo/text";
import { ListSkeleton } from "@/components/list-skeleton";
import {
	activeWorkspacesQueryOptions,
	connectionsOverviewQueryOptions,
	skillCatalogQueryOptions,
	tediRosterQueryOptions,
} from "@/lib/os-query-options";
import {
	buildSystemMap,
	validateSystemMap,
	type SystemMap,
	type SystemMapFinding,
	type SystemMapNode,
	type SystemMapSources,
} from "@/lib/system-map";

const LIMIT = 100;
const CONNECTIONS_INPUT = {
	scope: "organization" as const,
	q: "",
	status: "all" as const,
	limit: LIMIT,
	offset: 0,
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CONNECTION_STATE: Record<
	NonNullable<SystemMapNode["state"]>,
	{ label: string; variant: "success" | "warning" | "destructive" | "outline" }
> = {
	present: { label: "Connected", variant: "success" },
	expired: { label: "Needs reconnecting", variant: "warning" },
	missing: { label: "Not connected", variant: "destructive" },
	restricted: { label: "Restricted", variant: "warning" },
	unknown: { label: "Not checked", variant: "outline" },
};

function nodeHref(node: SystemMapNode) {
	const id = encodeURIComponent(node.id.slice(node.id.indexOf(":") + 1));
	switch (node.kind) {
		case "tedi":
			return `/team/${id}`;
		case "skill":
			return `/skills/${id}`;
		case "connection":
			return "/admin/connections";
		case "workspace":
			return `/workspaces`;
	}
}

function describeRef(ref: string, noun: string) {
	return UUID.test(ref) ? `a ${noun}` : `the ${noun} “${ref}”`;
}

/** Plain-language sentence for one validation finding; never shows raw ids. */
export function describeFinding(finding: SystemMapFinding): string {
	if (finding.kind === "orphan_node") {
		const { node } = finding;
		return node.kind === "tedi"
			? `${node.label} has no skills yet.`
			: node.kind === "skill"
				? `${node.label} is not used by any tedi.`
				: node.kind === "connection"
					? `${node.label} is not needed by any skill.`
					: `${node.label} is not linked to a tedi.`;
	}
	const { edge, present, missing, missingRef } = finding;
	const who = present?.label ?? "Something";
	if (edge.kind === "uses" && missing === "to")
		return `${who} lists ${describeRef(missingRef, "skill")}, which no longer exists.`;
	if (edge.kind === "uses")
		return `${who} belongs to ${describeRef(missingRef, "tedi")}, who is not on the team.`;
	if (edge.kind === "needs")
		return `${who} needs a connection that no longer exists.`;
	return `${who} points at a ${missing === "to" ? "workspace" : "tedi"} that no longer exists.`;
}

function ConnectionStateBadge({ node }: { node: SystemMapNode }) {
	const state = CONNECTION_STATE[node.state ?? "unknown"];
	return <Badge variant={state.variant}>{state.label}</Badge>;
}

function TediRow({ tedi, map }: { tedi: SystemMapNode; map: SystemMap }) {
	const byId = useMemo(
		() => new Map(map.nodes.map((n) => [n.id, n])),
		[map.nodes],
	);
	const targets = (from: string, kind: string) =>
		map.edges
			.filter((e) => e.from === from && e.kind === kind)
			.flatMap((e) => byId.get(e.to) ?? []);
	const skills = targets(tedi.id, "uses");
	const workspaces = targets(tedi.id, "owns");
	const connectionCount = new Set(
		skills.flatMap((s) => targets(s.id, "needs").map((c) => c.id)),
	).size;
	return (
		<li className="px-2 py-1" data-testid="system-map-tedi">
			<Collapsible>
				<CollapsibleDefaultTrigger className="w-full justify-between">
					<span className="font-medium text-kumo-default">{tedi.label}</span>
					<span className="text-kumo-subtle">
						{skills.length} {skills.length === 1 ? "skill" : "skills"} ·{" "}
						{connectionCount}{" "}
						{connectionCount === 1 ? "connection" : "connections"}
					</span>
				</CollapsibleDefaultTrigger>
				<CollapsibleDefaultContent>
					<div className="grid gap-3 px-2 py-3">
						<Link href={nodeHref(tedi)}>Open {tedi.label}</Link>
						{skills.length === 0 ? (
							<Text tone="secondary">No skills yet.</Text>
						) : (
							<ul className="grid gap-3">
								{skills.map((skill) => {
									const connections = targets(skill.id, "needs");
									return (
										<li key={skill.id} className="grid gap-1">
											<Link href={nodeHref(skill)}>{skill.label}</Link>
											{connections.length === 0 ? (
												<Text role="label" tone="secondary">
													Needs no connection.
												</Text>
											) : (
												<ul className="grid gap-1 pl-4">
													{connections.map((connection) => (
														<li
															key={connection.id}
															className="flex flex-wrap items-center gap-2"
														>
															<Link href={nodeHref(connection)}>
																{connection.label}
															</Link>
															<ConnectionStateBadge node={connection} />
														</li>
													))}
												</ul>
											)}
										</li>
									);
								})}
							</ul>
						)}
						{workspaces.length > 0 && (
							<div className="grid gap-1">
								<Text role="label" tone="secondary">
									Private workspaces
								</Text>
								<ul className="grid gap-1 pl-4">
									{workspaces.map((workspace) => (
										<li key={workspace.id}>
											<Link href={nodeHref(workspace)}>{workspace.label}</Link>
										</li>
									))}
								</ul>
							</div>
						)}
					</div>
				</CollapsibleDefaultContent>
			</Collapsible>
		</li>
	);
}

/** The rendered map: pure over its sources, so it is testable without a network. */
export function SystemMapView({
	sources,
	config,
}: {
	sources: SystemMapSources;
	config?: Pick<SystemMapConfig, "showSharedWorkspaces">;
}) {
	const map = useMemo(() => {
		const workspaces = config?.showSharedWorkspaces
			? sources.workspaces
			: sources.workspaces.filter((w) => w.visibility === "private");
		return buildSystemMap({ ...sources, workspaces });
	}, [sources, config?.showSharedWorkspaces]);
	const findings = useMemo(() => validateSystemMap(map), [map]);
	const tedis = map.nodes.filter((n) => n.kind === "tedi");
	return (
		<div className="grid gap-6">
			<PageSection>
				<SectionHeader>
					<SectionHeading>
						<SectionTitle>How your team is wired</SectionTitle>
						<SectionDescription>
							Each tedi with the skills it uses and the connections those skills
							need. Read only.
						</SectionDescription>
					</SectionHeading>
				</SectionHeader>
				{tedis.length === 0 ? (
					<Text>No tedis yet. Add one from Team to see how it is wired.</Text>
				) : (
					<Collection>
						{tedis.map((tedi) => (
							<TediRow key={tedi.id} tedi={tedi} map={map} />
						))}
					</Collection>
				)}
			</PageSection>
			<PageSection>
				<SectionHeader>
					<SectionHeading>
						<SectionTitle>Problems</SectionTitle>
						<SectionDescription>
							Links that point at something missing, and items nothing uses.
						</SectionDescription>
					</SectionHeading>
				</SectionHeader>
				{findings.length === 0 ? (
					<Text>Everything is linked to something real.</Text>
				) : (
					<Collection>
						{findings.map((finding, index) => (
							<li
								key={index}
								className="flex flex-wrap items-center gap-2 px-4 py-3"
								data-testid="system-map-finding"
							>
								<Badge
									variant={
										finding.kind === "dangling_edge" ? "destructive" : "outline"
									}
								>
									{finding.kind === "dangling_edge" ? "Broken link" : "Unused"}
								</Badge>
								<Text>{describeFinding(finding)}</Text>
							</li>
						))}
					</Collection>
				)}
			</PageSection>
		</div>
	);
}

export function SystemMapApp({ config }: { config: SystemMapConfig }) {
	const tedis = useQuery(tediRosterQueryOptions(LIMIT));
	const skills = useQuery(skillCatalogQueryOptions(LIMIT));
	const connections = useQuery(
		connectionsOverviewQueryOptions(CONNECTIONS_INPUT),
	);
	const workspaces = useQuery(activeWorkspacesQueryOptions());

	const sources = useMemo<SystemMapSources | null>(() => {
		if (!tedis.data || !skills.data || !connections.data || !workspaces.data)
			return null;
		return {
			tedis: tedis.data.data.map((t) => ({
				id: t.id,
				name: t.name,
				displayName: t.displayName,
				ownerUserId: t.ownerUserId,
				installedSkills: t.installedSkills,
			})),
			skills: skills.data.entries.map((s) => ({
				id: s.id,
				title: s.title,
				slug: s.slug,
				tediId: s.tediId,
				appId: s.appId,
			})),
			connections: connections.data.rows.map((row) => ({
				id: row.connectionInstanceId ?? row.provider.appId,
				name: row.instanceLabel ?? row.provider.name,
				accountState: row.accountState,
				referenceAppIds: row.references.map((r) => r.appId),
			})),
			workspaces: workspaces.data.items.map((w) => ({
				id: w.id,
				name: w.name,
				visibility: w.visibility,
				ownerUserId: w.ownerUserId,
			})),
		};
	}, [tedis.data, skills.data, connections.data, workspaces.data]);

	if (
		tedis.isError ||
		skills.isError ||
		connections.isError ||
		workspaces.isError
	)
		return (
			<LoadError
				title="The system map is unavailable"
				error={
					tedis.error ?? skills.error ?? connections.error ?? workspaces.error
				}
				onRetry={() => {
					void tedis.refetch();
					void skills.refetch();
					void connections.refetch();
					void workspaces.refetch();
				}}
				retrying={
					tedis.isFetching ||
					skills.isFetching ||
					connections.isFetching ||
					workspaces.isFetching
				}
				help="Some of your team’s setup could not be read. Reload to try again."
			/>
		);
	if (!sources) return <ListSkeleton rows={4} />;
	return <SystemMapView sources={sources} config={config} />;
}
