import type { WorkFleetControlTower } from "@tedix/api-contract/schemas/work-fleet";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { Link } from "@/components/kumo/link";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import {
	Collection,
	PageSection,
	SectionActions,
	SectionDescription,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";
import { Skeleton } from "@/components/kumo/skeleton";
import { Surface } from "@/components/kumo/surface";
import { Text } from "@/components/kumo/text";
import { absoluteTime } from "@/lib/time";

const attentionCopy: Record<
	WorkFleetControlTower["attention"]["actions"][number]["key"],
	{ label: string; rationale: string; href?: string }
> = {
	exhausted_budgets: {
		label: "Review exhausted budgets",
		rationale:
			"These budgets have no remaining allowance. Check the affected work before changing a limit.",
		href: "/work/capacity?view=budgets&exhausted=true",
	},
	saturated_resources: {
		label: "Review occupied resources",
		rationale:
			"Other work is using these resources. Check who holds them before starting overlapping work.",
		href: "/work/capacity?saturated=true",
	},
	stale_attempt_leases: {
		label: "Check work with missed updates",
		rationale:
			"These executions have not renewed their reservations. Open the activity record to check their state.",
		href: "/work/attempts?view=active",
	},
	rejected_admissions: {
		label: "Review work that could not start",
		rationale: "Check the recorded reason before trying again.",
	},
	overdue_interactions: {
		label: "Review overdue requests",
		rationale:
			"Open organization requests include overdue answers or handoffs. Check the due date and who can respond.",
		href: "/work/interactions?view=audit&state=open",
	},
	approval_backlog: {
		label: "Review pending decisions",
		rationale: "Decisions are waiting for their designated approvers.",
	},
	interaction_backlog: {
		label: "Review open requests",
		rationale: "Work may be waiting for an answer, input or handoff.",
		href: "/work/interactions?view=audit&state=open",
	},
};

export function WorkAttentionSummary({
	snapshot,
	pending = false,
	error = false,
	refreshing = false,
	onRefresh,
}: {
	snapshot?: Pick<WorkFleetControlTower, "observedAt" | "attention">;
	pending?: boolean;
	error?: boolean;
	refreshing?: boolean;
	onRefresh: () => void;
}) {
	return (
		<PageSection aria-label="Work attention">
			<SectionHeader>
				<SectionHeading>
					<SectionTitle>Needs attention</SectionTitle>
					<SectionDescription>
						Across your organization. Open a record to see who can act.
					</SectionDescription>
				</SectionHeading>
				<SectionActions>
					<Link href="/work/interactions">My requests</Link>
					<Button
						variant="secondary"
						size="sm"
						disabled={refreshing}
						onClick={onRefresh}
					>
						{refreshing ? "Refreshing…" : "Refresh"}
					</Button>
				</SectionActions>
			</SectionHeader>
			{error ? (
				<Alert>
					<AlertTitle>Attention refresh unavailable</AlertTitle>
					<AlertDescription>
						{snapshot
							? "Showing the last observed snapshot. Refresh to try again."
							: "Refresh to load the current attention snapshot."}
					</AlertDescription>
				</Alert>
			) : null}
			{snapshot ? (
				<>
					<Text as="p" role="label" tone="secondary">
						Updated{" "}
						<time dateTime={snapshot.observedAt}>
							{absoluteTime(snapshot.observedAt)}
						</time>
					</Text>
					{snapshot.attention.actions.length ? (
						<Collection aria-label="Attention actions">
							{snapshot.attention.actions.map((action) => (
								<Surface
									key={action.key}
									render={<li />}
									className="grid gap-1 rounded-none border-0 p-3"
								>
									<Text
										as="p"
										role="body"
										className="m-0 flex flex-wrap items-center gap-2"
									>
										<Badge
											variant={
												action.severity === "critical"
													? "destructive"
													: "secondary"
											}
										>
											{action.severity === "critical"
												? "Check first"
												: "Review"}
										</Badge>
										<Link
											variant="record"
											title={action.label}
											href={attentionCopy[action.key].href ?? action.href}
										>
											{attentionCopy[action.key].label}
										</Link>
										<Badge variant="outline">{action.count}</Badge>
									</Text>
									<Text as="p" role="body" tone="secondary" className="m-0">
										{attentionCopy[action.key].rationale}
									</Text>
								</Surface>
							))}
						</Collection>
					) : (
						<Text as="p" role="body" tone="secondary">
							No organization-wide blockers were reported. Individual work may
							still need review.
						</Text>
					)}
				</>
			) : pending ? (
				<Skeleton className="h-24 w-full" aria-label="Loading work attention" />
			) : null}
		</PageSection>
	);
}
