import { ShieldCheck } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import type { DelegationProfile } from "@tedix/api-contract/contracts/earned-delegation";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge, type BadgeVariant } from "@/components/kumo/badge";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/kumo/empty";
import { MetricGrid, MetricItem } from "@/components/kumo/metric-grid";
import {
	PageSection,
	SectionDescription,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";
import { Surface } from "@/components/kumo/surface";
import { Text } from "@/components/kumo/text";
import { ListSkeleton } from "@/components/list-skeleton";
import { formatCount, humanize, sentenceCase } from "@/lib/format";
import { errorMessage, isAuthorizationError } from "@/lib/orpc-error";
import { earnedDelegationProfileQueryOptions } from "@/lib/os-query-options";
import { absoluteTime, relativeTime } from "@/lib/time";

type Entrustment = DelegationProfile["entrustments"][number];
type ValidatedExperience = DelegationProfile["validatedExperience"];
type DelegationYield = DelegationProfile["delegationYield"];

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Profile-level evidence gaps that are visible WITHOUT re-running the server's
 * readiness evaluation. This surface never declares readiness — the server
 * still owns activity, version, risk scope, evidence policy, and independent
 * verification.
 */
export function deriveObservedPromotionGaps(
	profile: DelegationProfile,
): string[] {
	const blockers: string[] = [];
	if (!profile.activeRole) {
		blockers.push(
			"Assign a role track before considering career-stage movement.",
		);
	}
	if (profile.validatedExperience.creditedOpportunities === 0) {
		blockers.push(
			"No independently verified, non-trivial held-out work has earned experience yet.",
		);
	}
	if (profile.validatedExperience.standing === "contested") {
		blockers.push(
			"Resolve negative evidence through independently verified remediation.",
		);
	}
	if (profile.validatedExperience.standing === "blocked") {
		blockers.push(
			"A policy violation blocks promotion until an owner resolves and recertifies it.",
		);
	}
	if (profile.validatedExperience.truncated) {
		blockers.push(
			"The evidence window is truncated; review the full ledger before promotion.",
		);
	}
	if (
		profile.entrustments.every((entry) => entry.effectiveStatus !== "active")
	) {
		blockers.push(
			"No active task-specific entrustment demonstrates earned operating scope.",
		);
	}
	return blockers;
}

/**
 * Effective status ranked so what CURRENTLY authorizes work reads first, then
 * what was narrowed, then what lapsed. Ties break on activity name so two
 * identical profiles always render in the same order.
 */
export const ENTRUSTMENT_STATUS_RANK: Record<
	Entrustment["effectiveStatus"],
	number
> = { active: 0, restricted: 1, expired: 2, revoked: 3 };

export function sortEntrustments(
	entrustments: readonly Entrustment[],
): Entrustment[] {
	return [...entrustments].sort(
		(a, b) =>
			ENTRUSTMENT_STATUS_RANK[a.effectiveStatus] -
				ENTRUSTMENT_STATUS_RANK[b.effectiveStatus] ||
			a.activity.name.localeCompare(b.activity.name),
	);
}

export const ENTRUSTMENT_LEVEL_LABELS: Record<Entrustment["level"], string> = {
	observe: "Observe",
	recommend: "Recommend",
	execute_preapproved: "Execute pre-approved",
	execute_reviewed: "Execute with review",
	autonomous: "Autonomous",
	delegate: "May delegate",
};

export const ENTRUSTMENT_STATUS_VARIANTS: Record<
	Entrustment["effectiveStatus"],
	BadgeVariant
> = {
	active: "success",
	restricted: "warning",
	expired: "outline",
	revoked: "error",
};

export function standingVariant(
	standing: ValidatedExperience["standing"],
): BadgeVariant {
	if (standing === "blocked") return "error";
	if (standing === "contested") return "warning";
	return "success";
}

/**
 * Minor units → the currency's own display, never a hardcoded symbol or a
 * blind /100 (JPY has no minor unit, KWD has three). Falls back to naming the
 * unit honestly when the runtime has no data for the code.
 */
export function formatMinorUnits(amount: number, currency: string): string {
	try {
		const formatter = new Intl.NumberFormat("en-US", {
			style: "currency",
			currency,
			currencyDisplay: "narrowSymbol",
		});
		const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
		return formatter.format(amount / 10 ** digits);
	} catch {
		return `${formatCount(amount)} ${currency} minor units`;
	}
}

// ---------------------------------------------------------------------------
// Presentational subcomponents (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Descriptive career progress. The bar is a plain div width — points explain
 * evidence breadth and authorize nothing, so the caption says exactly that
 * rather than letting a filled bar imply a granted power.
 */
export function ValidatedExperienceMeter({
	experience,
}: {
	experience: ValidatedExperience;
}) {
	const filled = Math.max(
		0,
		Math.min(100, Math.round((experience.points / experience.maxPoints) * 100)),
	);
	return (
		<Surface className="grid gap-1.5 px-3 py-2.5">
			<span className="flex flex-wrap items-baseline justify-between gap-2">
				<Text
					as="span"
					role="body"
					tone="strong"
					weight="semibold"
					className="tabular-nums"
				>
					{formatCount(experience.points)}
					<span className="font-normal text-kumo-subtle">
						{" / "}
						{formatCount(experience.maxPoints)} validated experience
					</span>
				</Text>
				<Badge variant={standingVariant(experience.standing)}>
					{sentenceCase(experience.standing)}
				</Badge>
			</span>
			<span
				aria-hidden
				className="h-1.5 overflow-hidden rounded-full bg-kumo-fill"
			>
				<span
					data-filled={filled}
					className="block h-full rounded-full bg-kumo-info"
					style={{ width: `${filled}%` }}
				/>
			</span>
			<Text as="span" role="label" tone="secondary">
				Descriptive only — points explain evidence breadth and never grant
				authority.
				{experience.truncated ? " The evidence window is truncated." : ""}
			</Text>
		</Surface>
	);
}

/**
 * Expiry and next-review are FUTURE instants, so they are rendered absolutely.
 * `relativeTime` is a past-tense dialect — its "just now" cutoff swallows every
 * negative delta, which rendered a review a month out as "just now" and told an
 * operator that a live grant was already due.
 */
export function EntrustmentRow({ entrustment }: { entrustment: Entrustment }) {
	const scope = entrustment.scope;
	const activity = entrustment.activity;
	return (
		<Surface
			data-status={entrustment.effectiveStatus}
			className="grid min-w-0 gap-1 px-3 py-2.5"
			render={<li />}
		>
			<span className="flex flex-wrap items-center gap-1.5">
				<Badge
					variant={ENTRUSTMENT_STATUS_VARIANTS[entrustment.effectiveStatus]}
				>
					{sentenceCase(entrustment.effectiveStatus)}
				</Badge>
				<Badge variant="outline">
					{ENTRUSTMENT_LEVEL_LABELS[entrustment.level]}
				</Badge>
			</span>
			<Text
				as="strong"
				role="body"
				tone="strong"
				weight="medium"
				className="truncate"
			>
				{activity.name}
			</Text>
			<Text as="span" role="label" tone="secondary">
				{activity.taskFamily} · {humanize(activity.riskLevel)} risk ·{" "}
				{formatCount(scope.actions.length)}{" "}
				{scope.actions.length === 1 ? "scoped action" : "scoped actions"} ·{" "}
				{scope.environments.join(", ")}
			</Text>
			<Text as="span" role="label" tone="secondary">
				{entrustment.expiresAt ? (
					<>
						Expires{" "}
						<time dateTime={entrustment.expiresAt}>
							{absoluteTime(entrustment.expiresAt)}
						</time>
					</>
				) : (
					"No expiry recorded"
				)}
				{" · next review "}
				<time dateTime={entrustment.nextReviewAt}>
					{absoluteTime(entrustment.nextReviewAt)}
				</time>
				{" · spend "}
				{scope.spendPermission === "policy_bound"
					? `policy-bound (${scope.budgetPolicyId})`
					: "none"}
			</Text>
			<details className="text-kumo-subtle text-xs">
				<summary className="cursor-pointer text-kumo-default">
					Exact authority scope
				</summary>
				<dl className="m-0 mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
					<dt>Actions</dt>
					<dd className="m-0 break-words">{scope.actions.join(", ")}</dd>
					<dt>Tools</dt>
					<dd className="m-0 break-words">
						{scope.toolIds.length > 0 ? scope.toolIds.join(", ") : "None"}
					</dd>
					<dt>Environments</dt>
					<dd className="m-0">{scope.environments.join(", ")}</dd>
					<dt>Constraints</dt>
					<dd className="m-0 break-all">
						{Object.keys(scope.constraints).length > 0
							? JSON.stringify(scope.constraints)
							: "None"}
					</dd>
				</dl>
			</details>
		</Surface>
	);
}

export function DelegationYieldPanel({
	delegationYield,
}: {
	delegationYield: DelegationYield;
}) {
	return (
		<Surface className="grid gap-2 px-3 py-2.5">
			<span className="flex flex-wrap items-center justify-between gap-2">
				<Text as="span" role="body" tone="strong" weight="medium">
					Verified value per owner review hour
				</Text>
				<Badge variant="outline">
					{sentenceCase(delegationYield.measurementStatus)}
				</Badge>
			</span>
			{delegationYield.valueByCurrency.length === 0 ? (
				<Text as="span" role="label" tone="secondary">
					Not measured yet — certification must record organizational value and
					owner review time before a yield exists.
				</Text>
			) : (
				<ul className="m-0 grid list-none gap-1 p-0">
					{delegationYield.valueByCurrency.map((value) => (
						<Text as="li" role="label" tone="secondary" key={value.currency}>
							<span className="font-medium text-kumo-strong tabular-nums">
								{value.valuePerOwnerReviewHourMinorUnits === null
									? "Rate withheld until the cohort completes"
									: `${formatMinorUnits(
											value.valuePerOwnerReviewHourMinorUnits,
											value.currency,
										)}/h`}
							</span>
							{" · "}
							{formatMinorUnits(
								value.verifiedValueMinorUnits,
								value.currency,
							)}{" "}
							across {formatCount(value.ownerReviewMinutes)} review min
						</Text>
					))}
				</ul>
			)}
			<Text as="span" role="label" tone="secondary" className="tabular-nums">
				{formatCount(delegationYield.valueCertifiedOpportunities)}/
				{formatCount(delegationYield.issuedOpportunities)} issued work items
				value-certified · {formatCount(delegationYield.reviewedOpportunities)}{" "}
				reviewed · {formatCount(delegationYield.observedOpportunities)}{" "}
				canonical eval runs · provisional
				{delegationYield.truncated ? " · evidence window truncated" : ""}
			</Text>
			{delegationYield.limitations.length > 0 && (
				<details className="text-kumo-subtle text-xs">
					<summary className="cursor-pointer text-kumo-default">
						Metric limitations
					</summary>
					<ul className="m-0 mt-1.5 list-disc pl-4">
						{delegationYield.limitations.map((limitation) => (
							<li key={limitation}>{limitation}</li>
						))}
					</ul>
				</details>
			)}
		</Surface>
	);
}

export function PromotionGaps({ gaps }: { gaps: readonly string[] }) {
	if (gaps.length === 0) {
		return (
			<Alert variant="info">
				<AlertTitle>Readiness not assessed</AlertTitle>
				<AlertDescription>
					No profile-level gap is visible from this evidence. The server must
					still evaluate the exact activity, version, risk scope, evidence
					policy, and independent verification. This surface never declares
					readiness.
				</AlertDescription>
			</Alert>
		);
	}
	return (
		<Alert variant="warning">
			<AlertTitle>
				{formatCount(gaps.length)} observed evidence{" "}
				{gaps.length === 1 ? "gap" : "gaps"}
			</AlertTitle>
			<AlertDescription>
				<ul className="m-0 list-disc pl-4">
					{gaps.map((gap) => (
						<li key={gap}>{gap}</li>
					))}
				</ul>
			</AlertDescription>
		</Alert>
	);
}

export function EntrustmentsEmpty() {
	return (
		<Empty appearance="quiet">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<ShieldCheck size={20} />
				</EmptyMedia>
				<EmptyTitle>No entrustments granted</EmptyTitle>
				<EmptyDescription>
					This tedi holds no task-specific authority. A role title and a career
					stage authorize nothing by themselves — only an applied entrustment
					grant does.
				</EmptyDescription>
			</EmptyHeader>
		</Empty>
	);
}

/** The whole earned-authority body, given an already-loaded profile. */
export function EarnedAuthorityPanel({
	profile,
}: {
	profile: DelegationProfile;
}) {
	const experience = profile.validatedExperience;
	const entrustments = sortEntrustments(profile.entrustments);
	const active = entrustments.filter(
		(entry) => entry.effectiveStatus === "active",
	).length;
	const gaps = deriveObservedPromotionGaps(profile);
	return (
		<>
			<MetricGrid
				appearance="bounded"
				aria-label="Earned authority summary"
				columns={4}
			>
				<MetricItem
					label="career stage"
					emphasis="dialog"
					value={
						profile.activeRole
							? sentenceCase(profile.activeRole.careerStage)
							: "Unassigned"
					}
					description={profile.activeRole?.roleName ?? "No role track"}
				/>
				<MetricItem
					label="active entrustments"
					emphasis="dialog"
					value={formatCount(active)}
					description={`${formatCount(entrustments.length)} on record`}
				/>
				<MetricItem
					label="credited work"
					emphasis="dialog"
					value={formatCount(experience.creditedOpportunities)}
					description={`${formatCount(experience.negativeOpportunities)} negative`}
				/>
				<MetricItem
					label="task families"
					emphasis="dialog"
					value={formatCount(experience.taskFamilies.length)}
					description={`${formatCount(experience.observationsEvaluated)} observations`}
				/>
			</MetricGrid>

			<ValidatedExperienceMeter experience={experience} />
			<DelegationYieldPanel delegationYield={profile.delegationYield} />

			<div className="grid min-w-0 gap-1.5">
				<Text as="span" role="label" tone="secondary">
					Task-specific authority · what this tedi may actually do
				</Text>
				{entrustments.length === 0 ? (
					<EntrustmentsEmpty />
				) : (
					<ul className="m-0 grid list-none gap-1.5 p-0">
						{entrustments.map((entrustment) => (
							<EntrustmentRow key={entrustment.id} entrustment={entrustment} />
						))}
					</ul>
				)}
			</div>

			<PromotionGaps gaps={gaps} />

			{profile.roleHistory.length > 1 && (
				<Surface className="px-3 py-2" render={<details />}>
					<summary className="cursor-pointer text-kumo-default text-xs">
						{formatCount(profile.roleHistory.length)} role assignments on record
					</summary>
					<ul className="m-0 mt-2 grid list-none gap-1 border-kumo-hairline border-t p-0 pt-2">
						{profile.roleHistory.map((role) => (
							<Text as="li" role="label" tone="secondary" key={role.id}>
								<span className="text-kumo-default">{role.roleName}</span>
								{" · "}
								{sentenceCase(role.careerStage)} · {humanize(role.status)} ·
								assigned{" "}
								<time
									dateTime={role.assignedAt}
									title={absoluteTime(role.assignedAt)}
								>
									{relativeTime(role.assignedAt)}
								</time>
							</Text>
						))}
					</ul>
				</Surface>
			)}
		</>
	);
}

// ---------------------------------------------------------------------------
// Section component
// ---------------------------------------------------------------------------

/**
 * Earned authority for one tedi, from the canonical earned-delegation profile.
 *
 * Read-only by construction: every governing verb on `earnedDelegation.*`
 * (grant, restrict, revoke, promote) sits on the `settings:manage` /
 * `earned-delegation:govern` plane and is deliberately not reachable here —
 * the OS shows the evidence, the governance path grants the authority.
 */
export function TediAuthority({ tediId }: { tediId: string }) {
	const profile = useQuery({
		...earnedDelegationProfileQueryOptions(tediId),
		staleTime: 60_000,
	});

	const refused = isAuthorizationError(profile.error);

	return (
		<PageSection>
			<SectionHeader>
				<SectionHeading>
					<SectionTitle>Earned authority</SectionTitle>
					<SectionDescription>
						Delegation evidence and the limits this digital worker has earned.
					</SectionDescription>
				</SectionHeading>
				{profile.data ? (
					<Badge variant="secondary">{profile.data.entrustments.length}</Badge>
				) : null}
			</SectionHeader>
			{profile.isPending && <ListSkeleton rows={2} />}
			{profile.isError && (
				<Alert variant={refused ? "warning" : "destructive"}>
					<AlertTitle>
						{refused
							? "Earned-authority evidence is not readable with your access"
							: "Earned-authority evidence is unavailable"}
					</AlertTitle>
					<AlertDescription>
						{refused
							? "The delegation-profile read was refused for this principal. No authority is inferred from a refused read."
							: errorMessage(profile.error)}
					</AlertDescription>
				</Alert>
			)}
			{profile.data && <EarnedAuthorityPanel profile={profile.data} />}
		</PageSection>
	);
}
