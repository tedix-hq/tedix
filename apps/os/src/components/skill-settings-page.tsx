import { useQuery } from "@tanstack/react-query";
import { Link as RouterLink, useParams } from "@tanstack/react-router";
import type {
	SkillEntry,
	SkillUser,
} from "@tedix/api-contract/schemas/cognitive";
import { useMemo } from "react";
import { DetailUnavailable } from "@/components/detail-unavailable";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	Collapsible,
	CollapsibleDefaultContent,
	CollapsibleDefaultTrigger,
} from "@/components/kumo/collapsible";
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
import { SkillInputsList } from "@/components/skill-inputs-list";
import { SkillSchedulePage } from "@/components/skill-schedule-page";
import {
	installedAppEligibilityQueryOptions,
	skillDetailQueryOptions,
} from "@/lib/os-query-options";
import {
	type InstalledAppStatus,
	type SkillConnection,
	type SkillConnectionStatus,
	deriveSkillConnections,
} from "@/lib/skill-connections";
import { useTediNames } from "@/lib/use-tedi-names";

const STATUS: Record<
	SkillConnectionStatus,
	{ label: string; variant: "success" | "warning" | "outline"; help?: string }
> = {
	ready: { label: "Ready", variant: "success" },
	setup_needed: {
		label: "Needs setup",
		variant: "warning",
		help: "Finish setting up this app, or runs that call it will fail.",
	},
	plan_upgrade: {
		label: "Needs a plan upgrade",
		variant: "warning",
		help: "This app is not included in the current plan.",
	},
	built_in: { label: "Built in", variant: "outline" },
	no_app: {
		label: "No app found",
		variant: "warning",
		help: "No installed app matches this connection. Install or connect the app, then save the skill again.",
	},
	unknown: { label: "Not checked", variant: "outline" },
};

/**
 * How a skill is set up to run: when it runs on its own, which tedi owns it,
 * which connections it may call and what a run can be given.
 */
export function SkillSettingsPage() {
	const { skillId } = useParams({ from: "/_session/_tenant/skills/$skillId" });
	const detail = useQuery(skillDetailQueryOptions(skillId));
	const skill = detail.data?.entry;
	if (detail.isPending) return <ListSkeleton rows={6} />;
	if (detail.isError || !skill)
		return (
			<DetailUnavailable
				resource="Skill"
				error={detail.error}
				onRetry={() => detail.refetch()}
				retrying={detail.isFetching}
			/>
		);
	return (
		<div className="grid min-w-0 gap-8">
			<SkillSchedulePage />
			<SkillOwnerSection skill={skill} />
			<SkillUsedBySection usedBy={detail.data?.usedBy ?? []} />
			<SkillConnectionsSection skill={skill} />
			<PageSection aria-labelledby="skill-inputs-title">
				<SectionHeader>
					<SectionHeading>
						<SectionTitle id="skill-inputs-title">Inputs</SectionTitle>
						<SectionDescription>
							What a run can be given when it starts.
						</SectionDescription>
					</SectionHeading>
				</SectionHeader>
				<SkillInputsList skill={skill} />
			</PageSection>
		</div>
	);
}

function SkillOwnerSection({ skill }: { skill: SkillEntry }) {
	const tediNames = useTediNames();
	const owner = skill.tediId ? tediNames[skill.tediId] : undefined;
	return (
		<PageSection aria-labelledby="skill-owner-title">
			<SectionHeader>
				<SectionHeading>
					<SectionTitle id="skill-owner-title">Owner</SectionTitle>
					<SectionDescription>
						The tedi this skill belongs to.
					</SectionDescription>
				</SectionHeading>
			</SectionHeader>
			{skill.tediId ? (
				<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
					<Text as="strong" role="body" className="wrap-anywhere">
						{owner ?? "A tedi"}
					</Text>
					<Button
						variant="outline"
						size="sm"
						render={
							<RouterLink
								to="/team/$tediId"
								params={{ tediId: skill.tediId }}
							/>
						}
					>
						Open tedi
					</Button>
				</div>
			) : (
				<Text role="body" tone="secondary" className="m-0">
					No single tedi owns this skill; the organization shares it. Each run
					uses the tedi chosen when it starts.
				</Text>
			)}
		</PageSection>
	);
}

/** Who depends on this skill, as each user declared it. */
function SkillUsedBySection({ usedBy }: { usedBy: readonly SkillUser[] }) {
	return (
		<PageSection aria-labelledby="skill-used-by-title">
			<SectionHeader>
				<SectionHeading>
					<SectionTitle id="skill-used-by-title">Used by</SectionTitle>
					<SectionDescription>
						What depends on this skill. Archiving it stops the ones marked below
						from working.
					</SectionDescription>
				</SectionHeading>
			</SectionHeader>
			{usedBy.length === 0 ? (
				<Text role="body" tone="secondary" className="m-0">
					Nothing has said that it uses this skill.
				</Text>
			) : (
				<ul className="m-0 grid list-none gap-2 p-0">
					{usedBy.map((user) => (
						<li
							key={user.key}
							className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1"
						>
							<Text role="body" className="wrap-anywhere">
								{user.label}
							</Text>
							{user.blocksArchive ? (
								<Badge variant="warning">Stops if archived</Badge>
							) : null}
						</li>
					))}
				</ul>
			)}
		</PageSection>
	);
}

type InstalledRead = {
	data?: readonly InstalledAppStatus[];
	isPending: boolean;
	isError: boolean;
	isFetching: boolean;
	refetch: () => Promise<unknown>;
};

/** The connections list, given the installed-apps read; rendered on its own in tests. */
export function SkillConnectionsList({
	skill,
	installed,
}: {
	skill: SkillEntry;
	installed: InstalledRead;
}) {
	const connections = useMemo(
		() => deriveSkillConnections(skill, installed.data),
		[skill, installed.data],
	);
	if (connections.length === 0)
		return (
			<Text role="body" tone="secondary" className="m-0">
				{skill.files?.["scripts/workflow.ts"]
					? "This skill calls no connected apps."
					: "This skill names no connections. A tedi following its instructions uses the apps that tedi may use."}
			</Text>
		);
	const technical = connections.flatMap((connection) => [
		`${connection.namespace}${connection.appId ? ` · app ${connection.appId}` : ""}`,
		...connection.tools.map((tool) => tool.call),
	]);
	return (
		<div className="grid min-w-0 gap-2">
			{installed.isError ? (
				<div
					role="status"
					className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1"
				>
					<Text as="span" role="label" tone="secondary">
						Could not check whether these connections are ready.
					</Text>
					<Button
						variant="outline"
						size="sm"
						disabled={installed.isFetching}
						onClick={() => void installed.refetch()}
					>
						{installed.isFetching ? "Trying again…" : "Retry"}
					</Button>
				</div>
			) : null}
			<Collection aria-label="Connections">
				{connections.map((connection) => (
					<ConnectionRow
						key={connection.namespace}
						connection={connection}
						checking={installed.isPending}
					/>
				))}
			</Collection>
			<Collapsible>
				<CollapsibleDefaultTrigger>Technical details</CollapsibleDefaultTrigger>
				<CollapsibleDefaultContent keepMounted>
					<ul className="m-0 grid min-w-0 list-none gap-0.5 px-2 pt-1 pb-2">
						{technical.map((line) => (
							<li key={line}>
								<Text
									role="label"
									tone="mono-secondary"
									className="m-0 wrap-anywhere"
								>
									{line}
								</Text>
							</li>
						))}
					</ul>
				</CollapsibleDefaultContent>
			</Collapsible>
		</div>
	);
}

function ConnectionRow({
	connection,
	checking,
}: {
	connection: SkillConnection;
	checking: boolean;
}) {
	const status = STATUS[connection.status];
	const pending = checking && connection.status === "unknown";
	return (
		<li
			data-skill-connection={connection.status}
			className="grid min-w-0 gap-1 px-4 py-3"
		>
			<span className="flex min-w-0 flex-wrap items-center gap-2">
				<Text as="strong" role="body" className="wrap-anywhere">
					{connection.label}
				</Text>
				<Badge variant={pending ? "outline" : status.variant}>
					{pending ? "Checking…" : status.label}
				</Badge>
				{connection.appId ? (
					<Button
						variant="ghost"
						size="sm"
						className="ml-auto"
						render={
							<RouterLink
								to="/apps/$appId"
								params={{ appId: connection.appId }}
							/>
						}
					>
						Open app
					</Button>
				) : null}
			</span>
			<Text
				as="span"
				role="body"
				tone="secondary"
				className="min-w-0 wrap-anywhere"
			>
				{connection.tools.length > 0
					? `Uses: ${connection.tools.map((tool) => tool.label).join(", ")}`
					: "May use any of its tools."}
			</Text>
			{status.help && !pending ? (
				<Text as="span" role="label" tone="warning">
					{status.help}
				</Text>
			) : null}
		</li>
	);
}

function SkillConnectionsSection({ skill }: { skill: SkillEntry }) {
	const installed = useQuery(installedAppEligibilityQueryOptions());
	return (
		<PageSection aria-labelledby="skill-connections-title">
			<SectionHeader>
				<SectionHeading>
					<SectionTitle id="skill-connections-title">
						Connections and tools
					</SectionTitle>
					<SectionDescription>
						The apps this skill may call when it runs, and whether each one is
						ready.
					</SectionDescription>
				</SectionHeading>
			</SectionHeader>
			<SkillConnectionsList skill={skill} installed={installed} />
		</PageSection>
	);
}
