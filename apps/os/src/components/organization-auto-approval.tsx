import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { Input } from "@/components/kumo/input";
import { Switch } from "@/components/kumo/switch";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import { osQuery } from "@/lib/os-query-options";

type Change = Parameters<
	typeof osApi.mcpGovernance.setOrganizationAutoApproval
>[0];

/**
 * What runs without asking in this organization: the everyday groups of
 * Tedix operations (on by default) and single tools the organization added
 * or set to always ask. Critical actions always ask; the API refuses them.
 */
export function OrganizationAutoApproval({
	canChange,
}: {
	canChange: boolean;
}) {
	const client = useQueryClient();
	const settings = useQuery(
		osQuery.mcpGovernance.getOrganizationAutoApproval.queryOptions(),
	);
	const [toolName, setToolName] = useState("");
	const change = useMutation({
		mutationFn: (input: Change) =>
			osApi.mcpGovernance.setOrganizationAutoApproval(input),
		onSuccess: (data) => {
			client.setQueryData(
				osQuery.mcpGovernance.getOrganizationAutoApproval.queryKey(),
				data,
			);
			setToolName("");
		},
	});
	const addTool = (mode: "auto" | "ask") => (event?: FormEvent) => {
		event?.preventDefault();
		const name = toolName.trim();
		if (name) change.mutate({ kind: "tool", toolName: name, mode });
	};
	const data = settings.data;
	return (
		<section
			aria-label="Runs without asking"
			className="grid gap-2 border-t border-kumo-hairline px-4 py-3"
		>
			<Text as="h3" role="section" weight="semibold" tone="strong">
				Runs without asking
			</Text>
			<Text as="p" className="m-0" role="label" tone="secondary">
				Everyday changes inside your organization run without an approval card.
				Turn a group off to be asked again. Payments, messages, publishing,
				deleting and access changes always ask.
			</Text>
			{settings.isPending ? (
				<Text as="p" className="m-0" role="label" tone="secondary">
					Loading…
				</Text>
			) : settings.isError || !data ? (
				<Text as="p" className="m-0" role="label" tone="error">
					These settings could not be loaded.
				</Text>
			) : (
				<>
					<ul aria-label="Default groups" className="m-0 grid list-none p-0">
						{data.groups.map((group) => (
							<li
								key={group.id}
								className="flex min-w-0 items-center gap-2 border-b border-kumo-hairline py-2 last:border-b-0"
							>
								<span className="min-w-0 flex-1 text-kumo-default type-tedix-control">
									{group.label}
								</span>
								{canChange ? (
									<Switch
										size="sm"
										aria-label={`${group.label} run without asking`}
										checked={group.enabled}
										disabled={change.isPending}
										onCheckedChange={(enabled) =>
											change.mutate({
												kind: "group",
												groupId: group.id,
												enabled,
											})
										}
									/>
								) : (
									<Badge variant={group.enabled ? "success" : "secondary"}>
										{group.enabled ? "On" : "Off"}
									</Badge>
								)}
							</li>
						))}
					</ul>
					<ToolList
						title="Also runs without asking"
						tools={data.addedTools}
						canChange={canChange}
						disabled={change.isPending}
						onReset={(name) =>
							change.mutate({ kind: "tool", toolName: name, mode: "default" })
						}
					/>
					<ToolList
						title="Always asks"
						tools={data.removedTools}
						canChange={canChange}
						disabled={change.isPending}
						onReset={(name) =>
							change.mutate({ kind: "tool", toolName: name, mode: "default" })
						}
					/>
					{canChange ? (
						<form
							className="flex min-w-0 flex-wrap items-end gap-2"
							onSubmit={addTool("auto")}
						>
							<div className="grid min-w-48 flex-1 gap-1">
								<label
									className="text-kumo-subtle type-tedix-caption"
									htmlFor="auto-approval-tool"
								>
									Tool name, for example request_os_workspace_file_upload
								</label>
								<Input
									id="auto-approval-tool"
									value={toolName}
									onChange={(event) => setToolName(event.target.value)}
								/>
							</div>
							<Button
								size="sm"
								type="submit"
								disabled={!toolName.trim()}
								loading={change.isPending}
							>
								Run without asking
							</Button>
							<Button
								size="sm"
								variant="secondary"
								type="button"
								disabled={!toolName.trim() || change.isPending}
								onClick={() => addTool("ask")()}
							>
								Always ask
							</Button>
						</form>
					) : null}
					{change.error ? (
						<Text as="p" className="m-0" role="label" tone="error">
							Couldn't save this change. {(change.error as Error).message}
						</Text>
					) : null}
				</>
			)}
		</section>
	);
}

function ToolList({
	title,
	tools,
	canChange,
	disabled,
	onReset,
}: {
	title: string;
	tools: string[];
	canChange: boolean;
	disabled: boolean;
	onReset: (name: string) => void;
}) {
	if (tools.length === 0) return null;
	return (
		<div className="grid gap-1">
			<Text as="h4" className="m-0" role="label" tone="secondary">
				{title}
			</Text>
			<ul aria-label={title} className="m-0 flex list-none flex-wrap gap-1 p-0">
				{tools.map((name) => (
					<li key={name} className="flex items-center gap-1">
						<Badge variant="outline">{name}</Badge>
						{canChange ? (
							<Button
								size="sm"
								variant="ghost"
								disabled={disabled}
								aria-label={`Reset ${name} to the default`}
								onClick={() => onReset(name)}
							>
								Reset
							</Button>
						) : null}
					</li>
				))}
			</ul>
		</div>
	);
}
