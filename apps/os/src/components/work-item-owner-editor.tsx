import type { WorkItem } from "@tedix/api-contract/schemas/work-items";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/kumo/button";
import {
	Collapsible,
	CollapsibleDefaultTrigger,
	CollapsibleDefaultContent,
} from "@/components/kumo/collapsible";
import {
	Select,
	SelectTrigger,
	SelectValue,
	SelectContent,
	SelectItem,
} from "@/components/kumo/select";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import { osQuery } from "@/lib/os-query-options";
import { useOsOperationalContext } from "@/lib/use-os-preferences";
import { usePrincipalOptions } from "./work-form-pickers";

export function WorkItemOwnerEditor({ item }: { item: WorkItem }) {
	const role = useOsOperationalContext().data?.authority?.role;
	const people = usePrincipalOptions("user");
	const tedis = usePrincipalOptions("tedi");
	const options = [
		...people.map(({ value, label }) => ({ value: `user:${value}`, label })),
		...tedis.map(({ value, label }) => ({
			value: `tedi:${value}`,
			label: `${label} (tedi)`,
		})),
	];
	const [owner, setOwner] = useState("");
	const client = useQueryClient();
	const save = useMutation({
		mutationFn: () => {
			const separator = owner.indexOf(":");
			return osApi.workItems.updateSpecification({
				id: item.id,
				expectedWorkItemVersion: item.version,
				accountableOwnerType: owner.slice(0, separator) as "user" | "tedi",
				accountableOwnerId: owner.slice(separator + 1),
			});
		},
		onSuccess: () =>
			client.invalidateQueries({
				queryKey: osQuery.workItems.key({ type: "query" }),
			}),
	});
	if (role !== "owner" && role !== "admin") return null;
	return (
		<Collapsible>
			<CollapsibleDefaultTrigger>
				{item.accountableOwnerId ? "Change owner" : "Set owner"}
			</CollapsibleDefaultTrigger>
			<CollapsibleDefaultContent>
				<form
					className="grid gap-2 py-2"
					onSubmit={(event) => {
						event.preventDefault();
						if (owner && !save.isPending) save.mutate();
					}}
				>
					<Select
						value={owner}
						items={Object.fromEntries(
							options.map(({ value, label }) => [value, label]),
						)}
						onValueChange={(value) => setOwner(value ?? "")}
						disabled={save.isPending}
					>
						<SelectTrigger aria-label="Accountable owner">
							<SelectValue placeholder="Choose a person or tedi" />
						</SelectTrigger>
						<SelectContent>
							{options.map(({ value, label }) => (
								<SelectItem key={value} value={value}>
									{label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Button type="submit" size="sm" disabled={!owner || save.isPending}>
						{save.isPending ? "Saving…" : "Save owner"}
					</Button>
					{save.error ? (
						<Text tone="error" role="label">
							{save.error.message}
						</Text>
					) : null}
					{save.isSuccess ? <Text aria-live="polite">Owner saved.</Text> : null}
				</form>
			</CollapsibleDefaultContent>
		</Collapsible>
	);
}
