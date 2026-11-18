import { Button } from "@/components/kumo/button";
import { Text } from "@/components/kumo/text";
import { relativeTime } from "@/lib/time";
import { useWorkspaceAutoApprovals } from "@/lib/workspace-auto-approvals";

/**
 * The workspace's "Always approve" rules, each with a way to turn it off.
 * They arrive over the open workspace chat; without it there is nothing to
 * show or change here.
 */
export function WorkspaceAutoApprovalRules({
	workspaceId,
}: {
	workspaceId: string;
}) {
	const published = useWorkspaceAutoApprovals(workspaceId);
	return (
		<section
			aria-labelledby="workspace-auto-approval-title"
			className="grid min-w-0 gap-2 border-b border-kumo-hairline px-4 py-3"
			data-testid="workspace-auto-approval-rules"
		>
			<Text as="h3" id="workspace-auto-approval-title" role="label">
				Always approved in this workspace
			</Text>
			{!published ? (
				<Text as="p" className="m-0" role="caption" tone="secondary">
					Open this workspace's chat to see and change these rules.
				</Text>
			) : published.rules.length === 0 ? (
				<Text as="p" className="m-0" role="caption" tone="secondary">
					Nothing. Every change the agent proposes waits for you. Use "Always
					approve" on a proposal to skip asking for that kind of change.
				</Text>
			) : (
				<ul className="m-0 grid list-none gap-2 p-0">
					{published.rules.map((rule) => (
						<li
							className="flex min-w-0 items-center justify-between gap-3"
							key={rule.kind}
						>
							<span className="grid min-w-0 gap-0.5">
								<Text as="span" role="body">
									{rule.label.charAt(0).toUpperCase() + rule.label.slice(1)}
								</Text>
								<Text as="span" role="caption" tone="secondary">
									Turned on {relativeTime(rule.enabledAt)}
								</Text>
							</span>
							<Button
								aria-label={`Turn off always approving ${rule.label}`}
								disabled={!published.setRule}
								onClick={() => published.setRule?.(rule.kind, false)}
								size="sm"
								variant="outline"
							>
								Turn off
							</Button>
						</li>
					))}
				</ul>
			)}
			<Text as="p" className="m-0" role="caption" tone="secondary">
				Deleting, sharing and anything outside this workspace always wait for
				you.
			</Text>
		</section>
	);
}
