import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Switch } from "@/components/kumo/switch";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import { osQuery } from "@/lib/os-query-options";
import { useOsOperationalContext } from "@/lib/use-os-preferences";

const actionType = "notion_page_update";

export function NotionAutoApproval() {
	const client = useQueryClient();
	const context = useOsOperationalContext();
	const options = osQuery.mcpGovernance.listActionTypeOptIns.queryOptions();
	const settings = useQuery({ ...options, retry: false });
	const save = useMutation({
		mutationFn: (enabled: boolean) =>
			osApi.mcpGovernance.setActionTypeOptIn({ actionType, enabled }),
		onSettled: () => client.invalidateQueries({ queryKey: options.queryKey }),
	});
	const canChange = ["owner", "admin"].includes(
		context.data?.authority.role ?? "",
	);
	const enabled =
		settings.data?.data.some((entry) => entry.actionType === actionType) ??
		false;
	return (
		<div className="grid gap-1 border-b border-kumo-hairline px-4 py-3">
			<div className="flex items-start gap-2">
				<span className="min-w-0 flex-1 font-medium text-kumo-default type-tedix-control">
					Approve safe Notion page edits automatically
				</span>
				<Switch
					aria-label="Approve safe Notion page edits automatically"
					checked={enabled}
					disabled={
						!canChange ||
						settings.isPending ||
						settings.isError ||
						save.isPending
					}
					onCheckedChange={(next) => save.mutate(next)}
					size="sm"
				/>
			</div>
			<Text as="p" className="m-0" role="label" tone="secondary">
				For this organization, agents may update page properties, add content,
				and make bounded text edits in connected Notion pages without asking.
				Full page replacements and deletion still require approval.
			</Text>
			{settings.isError || save.isError ? (
				<Text as="p" className="m-0" role="label" tone="error">
					{settings.isError
						? "Couldn't load this setting."
						: "Couldn't change this setting."}
				</Text>
			) : null}
		</div>
	);
}
