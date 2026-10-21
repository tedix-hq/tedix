import {
	matchQuery,
	type QueryClient,
	type QueryKey,
} from "@tanstack/react-query";
import { createContext } from "react";

/** `errorShownInline`: the caller shows a failure itself, so the Deck adds no toast. */
export const OptimisticDeckDecisionContext = createContext<
	| ((
			write: () => Promise<unknown>,
			options?: { errorShownInline?: boolean },
	  ) => Promise<unknown>)
	| null
>(null);

type Row = { id?: string; request?: { id: string }; proposal?: { id: string } };
type Page = { data: Row[] };
type Inbox = Page | { pages: Page[] };
const rowId = (row: Row) => row.request?.id ?? row.proposal?.id ?? row.id;
const pagesOf = (data: Inbox) => ("pages" in data ? data.pages : [data]);
const mapPages = (
	data: Inbox,
	map: (page: Page, index: number) => Page,
): Inbox =>
	"pages" in data ? { ...data, pages: data.pages.map(map) } : map(data, 0);

/** Restore only this row, preserving concurrent decisions and fresh server rows. */
export function removeOptimisticDeckCard(
	client: QueryClient,
	keys: QueryKey[],
	id: string,
) {
	const affected = client.getQueryCache().findAll({
		predicate: (query) =>
			keys.some((queryKey) => matchQuery({ queryKey }, query)),
	});
	const undo: (() => void)[] = [];
	for (const query of affected) {
		const data = query.state.data as Inbox | undefined;
		if (!data) continue;
		const removed = pagesOf(data).flatMap((page, pageIndex) =>
			page.data.flatMap((row, index) =>
				rowId(row) === id ? [{ row, index, pageIndex }] : [],
			),
		);
		if (!removed.length) continue;
		void client.cancelQueries({ queryKey: query.queryKey, exact: true });
		client.setQueryData(
			query.queryKey,
			mapPages(data, (page) => ({
				...page,
				data: page.data.filter((row) => rowId(row) !== id),
			})),
		);
		undo.push(() =>
			client.setQueryData<Inbox>(query.queryKey, (current) => {
				if (
					!current ||
					pagesOf(current).some((page) =>
						page.data.some((row) => rowId(row) === id),
					)
				)
					return current;
				return mapPages(current, (page, pageIndex) => {
					const rows = [...page.data];
					for (const entry of removed.filter(
						(entry) => entry.pageIndex === pageIndex,
					))
						rows.splice(Math.min(entry.index, rows.length), 0, entry.row);
					return { ...page, data: rows };
				});
			}),
		);
	}
	return () => undo.forEach((restore) => restore());
}
