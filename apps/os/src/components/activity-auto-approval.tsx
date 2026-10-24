import {
	BookOpen,
	Lightning,
	ListChecks,
	ShieldCheck,
	UserCircleCheck,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import criticalActions from "@tedix/api-contract/assets/critical-actions.v1.json";
import type { OsApprovalRule } from "@tedix/api-contract/contracts/os-approval-rules";
import type { ApprovalRequest } from "@tedix/api-contract/contracts/tedi-approvals";
import type { ReactNode } from "react";
import { isAutomaticApproval } from "@/components/activity-history";
import { Badge } from "@/components/kumo/badge";
import { Empty } from "@/components/kumo/empty";
import { Link } from "@/components/kumo/link";
import { Text } from "@/components/kumo/text";
import {
	appLabel,
	plainApprovalTitle,
	plainToolTitle,
} from "@/lib/approval-titles";
import {
	approvalHistoryQueryOptions,
	approvalRulesQueryOptions,
} from "@/lib/os-query-options";
import { absoluteTime, relativeTime } from "@/lib/time";
import { sanitizeUntrustedText } from "@/lib/untrusted-text";

/** Every action class that always waits for a person, in plain words. */
export const PERSON_ONLY_LABELS: Record<string, string> = {
	legal: "Legal commitments",
	money: "Paying or moving money",
	external_message: "Sending messages",
	public_publish: "Publishing",
	credentials: "Sign-ins and secrets",
	access_control: "Changing who has access",
	delete_data: "Deleting data",
	production_settings: "Production settings",
};

export function personOnlyClasses(): string[] {
	return criticalActions.classes.map(
		(rule) => PERSON_ONLY_LABELS[rule.id] ?? rule.id.replace(/_/g, " "),
	);
}

/** What the org's policy approved on its own lately, most frequent first. */
export function automaticCoverage(
	approvals: readonly ApprovalRequest[],
	limit = 6,
): { label: string; count: number }[] {
	const counts = new Map<string, number>();
	for (const approval of approvals) {
		if (!isAutomaticApproval(approval)) continue;
		const payload = approval.payload as Record<string, unknown>;
		const tool = typeof payload.toolName === "string" ? payload.toolName : null;
		const label = tool
			? plainApprovalTitle(tool, payload)
			: plainApprovalTitle(approval.review.summary || approval.description);
		counts.set(label, (counts.get(label) ?? 0) + 1);
	}
	return [...counts.entries()]
		.map(([label, count]) => ({ label, count }))
		.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
		.slice(0, limit);
}

/** A saved rule as one sentence: what it lets run without asking. */
export function savedRuleTitle(
	rule: Pick<OsApprovalRule, "toolSlug" | "verb" | "actionKind">,
): string {
	if (rule.toolSlug) {
		const dot = rule.toolSlug.indexOf(".");
		const app = dot > 0 ? rule.toolSlug.slice(0, dot) : null;
		const tool = dot > 0 ? rule.toolSlug.slice(dot + 1) : rule.toolSlug;
		const label = appLabel(app);
		const action = plainToolTitle(tool);
		return label && label !== "Tedix" ? `${action} in ${label}` : action;
	}
	return rule.verb
		? `Any “${rule.verb}” action`
		: `Any ${rule.actionKind.replace(/[._]/g, " ")} request`;
}

function PolicyRow({
	icon,
	title,
	mode,
	tone,
	children,
}: {
	icon: ReactNode;
	title: string;
	mode: string;
	tone: "success" | "secondary" | "warning";
	children: ReactNode;
}) {
	return (
		<li className="flex min-w-0 gap-3 border-b border-kumo-hairline px-4 py-3 last:border-b-0">
			<span
				aria-hidden
				className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-kumo-fill text-kumo-subtle"
			>
				{icon}
			</span>
			<div className="grid min-w-0 flex-1 gap-1.5">
				<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
					<span className="min-w-0 font-medium text-kumo-default type-tedix-control">
						{title}
					</span>
					<Badge variant={tone}>{mode}</Badge>
				</div>
				{children}
			</div>
		</li>
	);
}

function Chips({ items }: { items: readonly string[] }) {
	return (
		<ul className="m-0 flex min-w-0 list-none flex-wrap gap-1 p-0">
			{items.map((item) => (
				<li key={item}>
					<Badge className="max-w-full break-words" variant="outline">
						{sanitizeUntrustedText(item)}
					</Badge>
				</li>
			))}
		</ul>
	);
}

const sectionHeading =
	"m-0 px-4 pb-1 pt-3 text-kumo-subtle type-tedix-caption font-semibold";

export function ActivityAutoApproval({ canChange }: { canChange: boolean }) {
	const rules = useQuery(approvalRulesQueryOptions());
	const history = useQuery(approvalHistoryQueryOptions());
	const covered = automaticCoverage(history.data?.data ?? []);
	const savedRules = rules.data?.items ?? [];
	return (
		<div className="grid min-w-0">
			<h3 className={sectionHeading}>How actions are approved</h3>
			<ul aria-label="Approval policy" className="m-0 grid list-none p-0">
				<PolicyRow
					icon={<BookOpen size={14} />}
					mode="Always automatic"
					title="Reading data"
					tone="success"
				>
					<Text as="p" className="m-0" role="label" tone="secondary">
						Searching, listing and reading never ask. Every read is still
						logged.
					</Text>
				</PolicyRow>
				<PolicyRow
					icon={<Lightning size={14} />}
					mode="Automatic, logged"
					title="Small, low-risk changes"
					tone="secondary"
				>
					<Text as="p" className="m-0" role="label" tone="secondary">
						Low-risk changes in apps your organization trusts run without asking
						and show in History as auto-approved.
					</Text>
					{history.isPending ? null : covered.length > 0 ? (
						<>
							<Text as="p" className="m-0" role="label" tone="secondary">
								Recently covered:
							</Text>
							<Chips
								items={covered.map(({ label, count }) =>
									count > 1 ? `${label} ×${count}` : label,
								)}
							/>
						</>
					) : (
						<Text as="p" className="m-0" role="label" tone="secondary">
							Nothing was approved this way recently.
						</Text>
					)}
				</PolicyRow>
				<PolicyRow
					icon={<UserCircleCheck size={14} />}
					mode="Asks a person"
					title="Deleting, sending or paying"
					tone="warning"
				>
					<Text as="p" className="m-0" role="label" tone="secondary">
						These never run on their own, not even with a saved rule:
					</Text>
					<Chips items={personOnlyClasses()} />
				</PolicyRow>
				<PolicyRow
					icon={<ShieldCheck size={14} />}
					mode="Asks a person"
					title="Everything else"
					tone="warning"
				>
					<Text as="p" className="m-0" role="label" tone="secondary">
						Changes that are not low risk, or in apps nobody has trusted yet,
						wait in Needs review.
					</Text>
				</PolicyRow>
			</ul>

			<h3 className={sectionHeading}>Saved rules</h3>
			{rules.isPending ? (
				<Text className="m-0 px-4 py-3" role="label" tone="secondary">
					Loading saved rules…
				</Text>
			) : rules.isError ? (
				<Text className="m-0 px-4 py-3" role="label" tone="error">
					Saved rules could not be loaded.
				</Text>
			) : savedRules.length === 0 ? (
				<Empty
					appearance="inline"
					className="px-4! py-4!"
					description="Choose “Always allow” on a decision card and that exact action stops asking. It appears here."
					icon={
						<ListChecks aria-hidden className="text-kumo-subtle" size={24} />
					}
					title="No saved rules"
				/>
			) : (
				<ul aria-label="Saved rules" className="m-0 grid list-none p-0">
					{savedRules.map((rule) => (
						<li
							className="grid min-w-0 gap-0.5 border-b border-kumo-hairline px-4 py-2.5 last:border-b-0"
							key={rule.id}
						>
							<div className="flex min-w-0 items-start gap-2">
								<span className="min-w-0 flex-1 break-words font-medium text-kumo-default type-tedix-control">
									Always approve: {sanitizeUntrustedText(savedRuleTitle(rule))}
								</span>
								<Badge
									className="shrink-0"
									variant={rule.enabled ? "success" : "secondary"}
								>
									{rule.enabled ? "On" : "Off"}
								</Badge>
							</div>
							<Text as="span" role="label" tone="secondary">
								Added{" "}
								<time
									dateTime={rule.createdAt}
									title={absoluteTime(rule.createdAt)}
								>
									{relativeTime(rule.createdAt)}
								</time>
								{rule.createdByKind === "tedi" ? " by a tedi" : ""}
							</Text>
						</li>
					))}
				</ul>
			)}

			<div className="grid gap-1 border-t border-kumo-hairline px-4 py-3">
				<Text as="p" className="m-0" role="label" tone="secondary">
					{canChange
						? "You can add a rule from any decision card. Owners and admins with approval rights can change these."
						: "Owners and admins with approval rights can change these. You can see them."}
				</Text>
				<Link className="type-tedix-label" href="/team">
					Per-tedi limits: Team → tedi → Settings
				</Link>
			</div>
		</div>
	);
}
