import type { AnyFieldApi } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useOsOperationalContext } from "@/lib/use-os-preferences";
import {
	projectPortfolioQueryOptions,
	workCaseListQueryOptions,
	workItemListQueryOptions,
} from "@/lib/os-query-options";
import {
	OperationPicker,
	useWorkPrincipalNames,
} from "./work-operations-shared";

type Option = { value: string; label: string };

/** A TanStack form field that stores the chosen id but shows only names. */
export function FormPicker({
	field,
	label,
	options,
	onSearch,
	selectedLabel,
	disabled,
}: {
	field: AnyFieldApi;
	label: string;
	options: Option[];
	onSearch?: (text: string) => void;
	selectedLabel?: string;
	disabled?: boolean;
}) {
	return (
		<div className={disabled ? "pointer-events-none opacity-60" : undefined}>
			<OperationPicker
				label={label}
				options={options}
				value={(field.state.value as string) ?? ""}
				onSelect={(id) => field.handleChange(id)}
				onSearch={onSearch}
				selectedLabel={selectedLabel}
			/>
		</div>
	);
}

/** Work Items by title; typing searches the organization. */
export function useWorkItemOptions() {
	const [search, setSearch] = useState("");
	const text = search.trim();
	const items = useQuery(
		workItemListQueryOptions({
			limit: 20,
			...(text.length >= 2 ? { titleContains: text } : {}),
		}),
	);
	const options = (items.data?.data ?? []).map((item) => ({
		value: item.id,
		label: item.title,
	}));
	const versions = new Map(
		(items.data?.data ?? []).map((item) => [item.id, item.version] as const),
	);
	return { options, onSearch: setSearch, versions };
}

/** Projects by name. */
export function useProjectOptions(): Option[] {
	const portfolio = useQuery(projectPortfolioQueryOptions());
	return useMemo(
		() =>
			(portfolio.data?.data ?? [])
				.map((row) => ({ value: row.project.id, label: row.project.name }))
				.sort((a, b) => a.label.localeCompare(b.label)),
		[portfolio.data],
	);
}

/** Epics by title. */
export function useEpicOptions(): Option[] {
	const cases = useQuery(workCaseListQueryOptions());
	return (cases.data?.data ?? []).map((row) => ({
		value: row.id,
		label: row.title,
	}));
}

/** People, tedis or agents by name, for the given principal kind. */
export function usePrincipalOptions(type: string): Option[] {
	const context = useOsOperationalContext();
	const names = useWorkPrincipalNames(context.data?.organization?.id);
	return useMemo(() => {
		const seen = new Set<string>();
		const out: Option[] = [];
		for (const [key, label] of names) {
			if (!key.startsWith(`${type}:`)) continue;
			// Members are keyed by two ids with one name; list each person once.
			const id = key.slice(type.length + 1);
			if (seen.has(`${label}`) && type === "user") continue;
			seen.add(label);
			out.push({ value: id, label });
		}
		return out.sort((a, b) => a.label.localeCompare(b.label));
	}, [names, type]);
}
