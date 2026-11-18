import { X } from "@phosphor-icons/react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { OsInviteSuggestion } from "@tedix/api-contract/schemas/os-collaborators";
import { type KeyboardEvent, useEffect, useState } from "react";
import { Button } from "@/components/kumo/button";
import { Text } from "@/components/kumo/text";
import { inviteSuggestionsQueryOptions } from "@/lib/os-query-options";

const SEARCH_DELAY_MS = 200;
const MIN_SEARCH_LENGTH = 2;
/** Longer text is a pasted list, not a name. */
const MAX_SEARCH_LENGTH = 100;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const INVITE_SUGGESTIONS_ID = "invite-people-suggestions";

/** What is being typed now: the text after the last comma, semicolon or line break. */
export function inviteSearchTerm(text: string): string {
	return (text.split(/[,;\n]/).at(-1) ?? "").trim();
}

/** The field's text once the name being typed has become a chip. */
export function withoutInviteSearchTerm(text: string): string {
	const cut = Math.max(
		text.lastIndexOf(","),
		text.lastIndexOf(";"),
		text.lastIndexOf("\n"),
	);
	return cut < 0 ? "" : `${text.slice(0, cut + 1)} `;
}

function suggestionLabel(person: OsInviteSuggestion): string {
	return person.name ?? person.email;
}

export function suggestionOptionId(person: OsInviteSuggestion): string {
	return `invite-suggestion-${person.userId}`;
}

/**
 * People in your organization who match what is being typed. `skip` holds the
 * ids of people already chosen or already in the workspace.
 */
export function useInviteSuggestions(text: string, skip: ReadonlySet<string>) {
	const typed = inviteSearchTerm(text);
	const [term, setTerm] = useState("");
	useEffect(() => {
		const timer = setTimeout(() => setTerm(typed), SEARCH_DELAY_MS);
		return () => clearTimeout(timer);
	}, [typed]);
	const searchable = (value: string) =>
		value.length >= MIN_SEARCH_LENGTH && value.length <= MAX_SEARCH_LENGTH;
	const searching = searchable(term) && searchable(typed);
	const query = useQuery({
		...inviteSuggestionsQueryOptions(term),
		enabled: searching,
		placeholderData: keepPreviousData,
		staleTime: 30_000,
		retry: false,
	});
	const people = searching
		? (query.data?.people ?? []).filter((person) => !skip.has(person.userId))
		: [];
	// -1 is no row. A full address is sent as typed unless a row is chosen on
	// purpose; a name has nowhere else to go, so its first match is ready.
	const [activeIndex, setActiveIndex] = useState(-1);
	const [dismissed, setDismissed] = useState(false);
	useEffect(() => {
		setActiveIndex(EMAIL_SHAPE.test(typed) ? -1 : 0);
		setDismissed(false);
	}, [typed]);
	const open = !dismissed && people.length > 0;
	const active =
		open && activeIndex >= 0
			? (people[Math.min(activeIndex, people.length - 1)] ?? null)
			: null;
	return {
		people: open ? people : [],
		active,
		/** Nobody matched a name; an address is needed instead. */
		noMatch:
			searching &&
			term === typed &&
			query.isSuccess &&
			!query.isPlaceholderData &&
			query.data.people.length === 0 &&
			!typed.includes("@"),
		/** Returns the person to add when the key chose one. */
		onKeyDown(
			event: KeyboardEvent<HTMLInputElement>,
		): OsInviteSuggestion | null {
			if (!open) return null;
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				const step = event.key === "ArrowDown" ? 1 : -1;
				const from = active ? people.indexOf(active) : step > 0 ? -1 : 0;
				setActiveIndex((from + step + people.length) % people.length);
				return null;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				setDismissed(true);
				return null;
			}
			if (event.key === "Enter" && active) {
				event.preventDefault();
				return active;
			}
			return null;
		},
	};
}

export function InviteSuggestionList(props: {
	people: readonly OsInviteSuggestion[];
	active: OsInviteSuggestion | null;
	onPick: (person: OsInviteSuggestion) => void;
}) {
	if (props.people.length === 0) return null;
	return (
		<ul
			id={INVITE_SUGGESTIONS_ID}
			role="listbox"
			aria-label="People in your organization"
			className="m-0 grid list-none rounded-md border border-kumo-line p-1"
			data-invite-suggestions
		>
			{props.people.map((person) => {
				const selected = props.active?.userId === person.userId;
				return (
					<li
						key={person.userId}
						id={suggestionOptionId(person)}
						role="option"
						aria-selected={selected}
						className={`grid min-h-9 cursor-pointer rounded px-2 py-1 hover:bg-kumo-tint${selected ? " bg-kumo-tint" : ""}`}
						// Keep the caret in the field while choosing with the mouse.
						onMouseDown={(event) => event.preventDefault()}
						onClick={() => props.onPick(person)}
					>
						<Text as="span" role="body" className="truncate">
							{suggestionLabel(person)}
						</Text>
						{person.name ? (
							<Text
								as="span"
								role="label"
								tone="secondary"
								className="truncate"
							>
								{person.email}
							</Text>
						) : null}
					</li>
				);
			})}
		</ul>
	);
}

/** The people chosen from suggestions, each removable before inviting. */
export function InviteChips(props: {
	people: readonly OsInviteSuggestion[];
	disabled?: boolean;
	onRemove: (person: OsInviteSuggestion) => void;
}) {
	if (props.people.length === 0) return null;
	return (
		<ul
			className="m-0 flex list-none flex-wrap gap-1 p-0"
			aria-label="People to invite"
			data-invite-chips
		>
			{props.people.map((person) => (
				<li key={person.userId}>
					<Button
						type="button"
						size="sm"
						variant="outline"
						disabled={props.disabled}
						aria-label={`Remove ${suggestionLabel(person)}`}
						title={person.email}
						onClick={() => props.onRemove(person)}
					>
						{suggestionLabel(person)}
						<X size={12} />
					</Button>
				</li>
			))}
		</ul>
	);
}
