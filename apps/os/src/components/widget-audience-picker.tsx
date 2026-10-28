import { useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { osQuery } from "@/lib/os-query-options";
import { LoadError } from "@/components/kumo/alert";
import { Combobox } from "@/components/kumo/combobox";
import { Pagination } from "@/components/kumo/pagination";
export type AudiencePerson = { value: string; label: string };
export function WidgetAudiencePicker({
	label,
	installationId,
	selected,
	onChange,
}: {
	label: string;
	installationId: string;
	selected: string[];
	onChange: (ids: string[]) => void;
}) {
	const [search, setSearch] = useState("");
	const [offset, setOffset] = useState(0);
	const query = useQuery(
		osQuery.tedis.listWidgetContacts.queryOptions({
			input: {
				kind: "people",
				installationId,
				search: search.trim() || undefined,
				offset,
				limit: 50,
			},
		}),
	);
	const ids = [...new Set(selected)].sort();
	const batches = Array.from(
		{ length: Math.ceil(ids.length / 100) },
		(_, index) => ids.slice(index * 100, (index + 1) * 100),
	);
	const saved = useQueries({
		queries: batches.map((hostUserIds) =>
			osQuery.tedis.listWidgetContacts.queryOptions({
				input: {
					kind: "people",
					installationId,
					hostUserIds,
					offset: 0,
					limit: 100,
				},
			}),
		),
	});
	const people = new Map(
		[
			...saved.flatMap((page) => page.data?.people ?? []),
			...(query.data?.people ?? []),
		].map((person) => [person.hostUserId, person]),
	);
	const option = (id: string): AudiencePerson => {
		const person = people.get(id);
		return {
			value: id,
			label: person
				? [person.name, person.email, `ID ${id}`].filter(Boolean).join(" · ")
				: `User ${id}`,
		};
	};
	const value = selected.map(option);
	// Selected values may be outside this search page. Keep them as values without
	// treating an incomplete response or failed lookup as a policy removal.
	const options = (query.data?.people ?? []).map((person) =>
		option(person.hostUserId),
	);
	return (
		<section className="grid gap-2">
			<Combobox
				multiple
				items={options}
				value={value}
				inputValue={search}
				filter={null}
				onInputValueChange={(text) => {
					setSearch(text);
					setOffset(0);
				}}
				onValueChange={(items) =>
					onChange((items as AudiencePerson[]).map((person) => person.value))
				}
				isItemEqualToValue={(a: AudiencePerson, b: AudiencePerson) =>
					a.value === b.value
				}
				label={label}
			>
				<Combobox.TriggerMultipleWithInput
					placeholder="Search people by name, email or ID…"
					renderItem={(person: AudiencePerson) => (
						<Combobox.Chip key={person.value}>{person.label}</Combobox.Chip>
					)}
				/>
				<Combobox.Content>
					<Combobox.Empty>
						{query.isPending
							? "Loading people…"
							: query.isError
								? "People could not be loaded."
								: "No matching people in this company."}
					</Combobox.Empty>
					<Combobox.List>
						{(person: AudiencePerson) => (
							<Combobox.Item key={person.value} value={person}>
								{person.label}
							</Combobox.Item>
						)}
					</Combobox.List>
					{(offset > 0 || query.data?.nextOffset != null) && (
						<Pagination
							className="px-2 py-1"
							page={offset / 50 + 1}
							perPage={50}
							totalCount={query.data?.total ?? 0}
							setPage={(page) => setOffset((page - 1) * 50)}
							labels={{ navigation: `${label} pages` }}
						>
							<Pagination.Controls controls="simple" />
						</Pagination>
					)}
				</Combobox.Content>
			</Combobox>
			{(query.isError || saved.some((page) => page.isError)) && (
				<LoadError
					title="Some names are unavailable"
					error={query.error ?? saved.find((page) => page.isError)?.error}
					onRetry={() => {
						void query.refetch();
						for (const page of saved) void page.refetch();
					}}
					retrying={query.isFetching || saved.some((page) => page.isFetching)}
					help="Your selected user IDs are preserved."
				/>
			)}
		</section>
	);
}
