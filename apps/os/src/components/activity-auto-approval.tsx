import {
	BookOpen,
	CaretRight,
	Lightning,
	ListChecks,
	ShieldCheck,
	Trash,
	UserCircleCheck,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import criticalActions from "@tedix/api-contract/assets/critical-actions.v1.json";
import type { OsApprovalRule } from "@tedix/api-contract/contracts/os-approval-rules";
import type { ApprovalRequest } from "@tedix/api-contract/contracts/tedi-approvals";
import { type ReactNode, useState } from "react";
import { isAutomaticApproval } from "@/components/activity-history";
import { TenantToolPolicies } from "@/components/tenant-tool-policies";
import { ProviderIdentityProfiles } from "@/components/provider-identity-profiles";
import { LegacyActionGrants } from "@/components/legacy-action-grants";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/kumo/collapsible";
import { Empty } from "@/components/kumo/empty";
import { Link } from "@/components/kumo/link";
import { Switch } from "@/components/kumo/switch";
import { Text } from "@/components/kumo/text";
import {
	appLabel,
	plainApprovalTitle,
	plainToolTitle,
} from "@/lib/approval-titles";
import { osApi } from "@/lib/api";
import { approvalRulesQueryOptions, osQueryKeys } from "@/lib/os-query-options";
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

/**
 * One saved rule. The switch turns it on or off; a rule that is off can be
 * deleted after one confirmation (the API only deletes a disabled rule, so a
 * live rule can never vanish in one click). Both writes are audited server-side.
 */
function SavedRuleRow({
	rule,
	canChange,
}: {
	rule: OsApprovalRule;
	canChange: boolean;
}) {
	const queryClient = useQueryClient();
	const [confirmDelete, setConfirmDelete] = useState(false);
	const refresh = () =>
		queryClient.invalidateQueries({ queryKey: osQueryKeys.approvalRules() });
	const toggle = useMutation({
		mutationFn: (enabled: boolean) =>
			osApi.osApprovalRules.setEnabled({ ruleId: rule.id, enabled }),
		onSettled: refresh,
	});
	const remove = useMutation({
		mutationFn: () => osApi.osApprovalRules.delete({ ruleId: rule.id }),
		onSettled: refresh,
	});
	const title = sanitizeUntrustedText(savedRuleTitle(rule));
	const error = toggle.error ?? remove.error;
	return (
		<li className="grid min-w-0 gap-1 border-b border-kumo-hairline px-4 py-2.5 last:border-b-0">
			<div className="flex min-w-0 items-start gap-2">
				<span className="min-w-0 flex-1 break-words font-medium text-kumo-default type-tedix-control">
					Always approve: {title}
				</span>
				{canChange ? (
					<Switch
						className="mt-0.5 shrink-0"
						size="sm"
						aria-label={`Always approve ${title}`}
						checked={rule.enabled}
						disabled={toggle.isPending || remove.isPending}
						onCheckedChange={(next) => {
							setConfirmDelete(false);
							toggle.mutate(next);
						}}
					/>
				) : (
					<Badge
						className="shrink-0"
						variant={rule.enabled ? "success" : "secondary"}
					>
						{rule.enabled ? "On" : "Off"}
					</Badge>
				)}
			</div>
			<Text as="span" role="label" tone="secondary">
				{rule.enabled
					? "On: this rule can approve matching requests."
					: "Off: this rule won't approve requests."}{" "}
				Added{" "}
				<time dateTime={rule.createdAt} title={absoluteTime(rule.createdAt)}>
					{relativeTime(rule.createdAt)}
				</time>
				{rule.createdByKind === "tedi" ? " by a tedi" : ""}
			</Text>
			{canChange && !rule.enabled ? (
				confirmDelete ? (
					<div
						className="flex flex-wrap items-center gap-2"
						role="group"
						aria-label="Confirm delete"
					>
						<Text as="span" role="label" tone="secondary">
							Delete this rule? Past approvals keep a record of it.
						</Text>
						<Button
							size="sm"
							variant="destructive"
							loading={remove.isPending}
							onClick={() => remove.mutate()}
						>
							Delete
						</Button>
						<Button
							size="sm"
							variant="ghost"
							disabled={remove.isPending}
							onClick={() => setConfirmDelete(false)}
						>
							Cancel
						</Button>
					</div>
				) : (
					<Button
						className="-ml-2 w-fit"
						size="sm"
						variant="ghost"
						onClick={() => setConfirmDelete(true)}
					>
						<Trash size={14} /> Delete rule
					</Button>
				)
			) : null}
			{error ? (
				<Text as="p" className="m-0" role="label" tone="error">
					{toggle.error
						? "Couldn't change this rule."
						: "Couldn't delete this rule."}{" "}
					{(error as Error).message}
				</Text>
			) : null}
		</li>
	);
}

const sectionHeading =
	"m-0 px-4 pb-1 pt-3 text-kumo-subtle type-tedix-caption font-semibold";

export function ActivityAutoApproval({ canChange }: { canChange: boolean }) {
	const rules = useQuery(approvalRulesQueryOptions());
	const savedRules = rules.data?.items ?? [];
	return (
		<div className="grid min-w-0">
			<h3 className={sectionHeading}>Saved approvals</h3>
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
						<SavedRuleRow key={rule.id} rule={rule} canChange={canChange} />
					))}
				</ul>
			)}

			<TenantToolPolicies canChange={canChange} />
			<ProviderIdentityProfiles canChange={canChange} />
			<Collapsible className="border-t border-kumo-hairline px-2 py-2">
				<CollapsibleTrigger className="group/disclosure">
					<CaretRight
						aria-hidden
						size={12}
						className="transition-transform group-data-[panel-open]/disclosure:rotate-90 motion-reduce:transition-none"
					/>
					How approvals work
				</CollapsibleTrigger>
				<CollapsibleContent>
					<ul
						aria-label="How approvals work"
						className="m-0 grid list-none p-0"
					>
						<PolicyRow
							icon={<BookOpen size={14} />}
							mode="Usually automatic"
							title="Reading information"
							tone="success"
						>
							<Text as="p" className="m-0" role="label" tone="secondary">
								Reads usually run without asking, when the agent has access.
								Connection permissions and other safeguards still apply.
							</Text>
						</PolicyRow>
						<PolicyRow
							icon={<Lightning size={14} />}
							mode="May run automatically"
							title="Small changes"
							tone="secondary"
						>
							<Text as="p" className="m-0" role="label" tone="secondary">
								Some changes can run without asking when a rule and the required
								permissions allow them. See History for what happened.
							</Text>
						</PolicyRow>
						<PolicyRow
							icon={<UserCircleCheck size={14} />}
							mode="Needs a person"
							title="Sensitive actions"
							tone="warning"
						>
							<Text as="p" className="m-0" role="label" tone="secondary">
								These actions require a person to approve them:
							</Text>
							<Chips items={personOnlyClasses()} />
						</PolicyRow>
						<PolicyRow
							icon={<ShieldCheck size={14} />}
							mode="Needs review"
							title="Other changes"
							tone="warning"
						>
							<Text as="p" className="m-0" role="label" tone="secondary">
								Some other changes need a decision. Access and other checks can
								also prevent an action from running.
							</Text>
						</PolicyRow>
					</ul>
				</CollapsibleContent>
			</Collapsible>
			<Collapsible className="border-t border-kumo-hairline px-2 py-2">
				<CollapsibleTrigger className="group/disclosure">
					<CaretRight
						aria-hidden
						size={12}
						className="transition-transform group-data-[panel-open]/disclosure:rotate-90 motion-reduce:transition-none"
					/>
					Older action approvals
				</CollapsibleTrigger>
				<CollapsibleContent>
					<LegacyActionGrants canChange={canChange} />
				</CollapsibleContent>
			</Collapsible>
			<div className="grid gap-1 border-t border-kumo-hairline px-4 py-3">
				<Text as="p" className="m-0" role="label" tone="secondary">
					{canChange
						? "You can also save an approval from a decision card. Turn a saved approval off before deleting it."
						: "Owners and admins with approval rights can change these. You can see them."}
				</Text>
				<Link className="type-tedix-label" href="/team">
					Per-tedi limits: Team → tedi → Settings
				</Link>
			</div>
		</div>
	);
}
