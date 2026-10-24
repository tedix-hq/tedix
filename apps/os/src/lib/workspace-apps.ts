import type { CardReviewConfig } from "@tedix/api-contract/schemas/os-card-review";
import type {
	OsGadget,
	OsGadgetManifest,
	OsOutput,
} from "@tedix/api-contract/schemas/os-workspaces";
import {
	cardSheetsForSource,
	cardsFromSheet,
	type ReviewCard,
	reviewQueue,
	scoredCards,
	type SheetBody,
} from "@tedix/api-contract/utils/card-review";

/**
 * How a workspace app introduces itself on its card in the Resources pane:
 * the manifest's one-line purpose wins (it is versioned with the app), then
 * the record's description, then a purpose derived from the app's settings.
 */
export function appPurpose(
	gadget: Pick<OsGadget, "description">,
	manifest: OsGadgetManifest | null | undefined,
	cardReview: CardReviewConfig | null,
): string | null {
	const declared = manifest?.description?.trim() || gadget.description?.trim();
	if (declared) return declared;
	if (cardReview) {
		const labels = [...new Set(cardReview.sources.map((s) => s.label))];
		return `Decide on today's ${joinWithAnd(labels)} cards`;
	}
	return null;
}

function joinWithAnd(items: readonly string[]): string {
	if (items.length <= 1) return items[0] ?? "";
	return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** What kind of app an entry selects, in words a person reading the card understands. */
export function appKindLabel(
	manifest: OsGadgetManifest | null | undefined,
): string | null {
	const entry = manifest?.entry.trim() ?? "";
	if (entry.startsWith("tedix:app/")) return "Built-in app";
	if (entry.startsWith("ui://")) return "Interactive app";
	if (manifest?.skillSlug || /^[a-z0-9][a-z0-9-]*$/.test(entry))
		return "Runs a skill";
	return null;
}

/**
 * The open cards a Card review app would show right now, without per-viewer
 * snoozes or skips: the count for the app's status line and the next card for
 * its preview.
 */
export function cardReviewSummary(
	config: CardReviewConfig,
	outputLists: readonly (
		| readonly Pick<
				OsOutput,
				"id" | "title" | "kind" | "status" | "createdAt"
		  >[]
		| undefined
	)[],
	sheets: ReadonlyMap<string, SheetBody>,
): { waiting: number; next: ReviewCard | null } | null {
	const cards: ReviewCard[] = [];
	for (const [sourceIndex, source] of config.sources.entries()) {
		const items = outputLists[sourceIndex];
		if (!items) return null;
		for (const sheet of cardSheetsForSource(source, items)) {
			const body = sheets.get(sheet.id);
			if (!body) return null;
			const result = cardsFromSheet({
				source,
				sourceIndex,
				outputId: sheet.id,
				sheetTitle: sheet.title,
				runCreatedAt: sheet.createdAt,
				body,
			});
			if ("cards" in result) cards.push(...result.cards);
		}
	}
	const queue = reviewQueue(scoredCards(cards, config.sources), {
		channel: null,
		snoozes: {},
		skipped: [],
		now: new Date(0),
	});
	return { waiting: queue.length, next: queue[0] ?? null };
}

export function cardsWaitingLabel(waiting: number): string {
	if (waiting === 0) return "No cards waiting";
	return waiting === 1 ? "1 card waiting" : `${waiting} cards waiting`;
}

/** What a built-in app shows and what a person can do in it, for its README. */
const BUILTIN_APP_GUIDE: Record<
	string,
	{ shows: readonly string[]; interactions: readonly string[] }
> = {
	"card-review": {
		shows: [
			"A factory's card sheets, one card at a time: who and where, what happened, what Tedix suggests and any draft.",
		],
		interactions: [
			"**Useful**, **Not useful**, **Do it**, **Snooze** and **Skip** write the verdict into the card sheet's own cells.",
			"Swipe on a phone; on a keyboard use ←/→, D, S, K, the number keys for reasons and Z to undo.",
		],
	},
	"decision-deck": {
		shows: ["Decisions that need you, one card at a time."],
		interactions: ["Decide each card; the choice is recorded on its Work."],
	},
	"activity-feed": {
		shows: ["Updates from your organization's Work, newest first."],
		interactions: ["Open an update to see its Work, or react to it."],
	},
	office: {
		shows: [
			"Your live activity, reply outcomes, the leaderboard and your notebook.",
		],
		interactions: ["Read only; filters change what you see, not the data."],
	},
	agents: {
		shows: ["Agent sessions with their state, harness and project."],
		interactions: [
			"Filter by state, harness or project; counts follow the filters.",
		],
	},
	"outbound-review": {
		shows: ["Outbound drafts with their status, filtered and searchable."],
		interactions: [
			"Review a draft, give feedback, approve it or send it. Settings never grant permission to send.",
		],
	},
	"personal-read-consent": {
		shows: ["One read-only consent button covering several personal accounts."],
		interactions: [
			"The workspace owner clicks once; each account can be revoked under Resources.",
		],
	},
	"system-map": {
		shows: ["How your tedis, skills and connections are wired."],
		interactions: ["Read only."],
	},
};

function codeList(values: readonly string[]): string {
	return values.map((value) => `\`${value}\``).join(", ");
}

/**
 * A plain-language README for a workspace app, generated from its current
 * manifest so it never drifts from what the app is: what it shows, what a
 * person can do in it, what it connects to, where its code lives, and the
 * author's notes.
 */
export function workspaceAppReadme(input: {
	name: string;
	description?: string | null;
	manifest: OsGadgetManifest | null | undefined;
}): string {
	const { manifest } = input;
	const entry = manifest?.entry.trim() ?? "";
	const purpose =
		manifest?.description?.trim() || input.description?.trim() || null;
	const builtin = entry.startsWith("tedix:app/");
	const guide = builtin
		? BUILTIN_APP_GUIDE[entry.slice("tedix:app/".length)]
		: undefined;
	const widget = entry.startsWith("ui://");
	const skill =
		manifest?.skillSlug ??
		(appKindLabel(manifest) === "Runs a skill" ? entry : null);
	const lines: string[] = [`# ${input.name}`, ""];
	if (purpose) lines.push(purpose, "");

	lines.push("## What it shows");
	if (guide) for (const item of guide.shows) lines.push(`- ${item}`);
	else if (widget)
		lines.push("- An interactive view rendered in a sandboxed frame.");
	else if (skill)
		lines.push("- The runs of its skill and what each run produced.");
	else lines.push("- Not described yet. Add a `description` to manifest.json.");
	lines.push("");

	lines.push("## Interactions");
	if (guide) for (const item of guide.interactions) lines.push(`- ${item}`);
	else if (widget)
		lines.push(
			"- Controls inside the view call the app's tools; a follow-up can go to the workspace chat.",
		);
	else if (skill)
		lines.push(
			"- Start a run from **Runs**; each run is recorded with its result.",
		);
	else lines.push("- None declared.");
	lines.push("");

	const grants = manifest?.resourceGrants ?? [];
	const capabilities = manifest?.capabilities ?? [];
	lines.push("## Connections");
	if (grants.length === 0 && capabilities.length === 0)
		lines.push("- Uses no external resources.");
	for (const grant of grants)
		lines.push(
			`- \`${grant.slot}\`: may ${codeList(grant.operations)} on the resource attached for it.`,
		);
	if (capabilities.length > 0)
		lines.push(`- Tedix tools: ${codeList(capabilities)}.`);
	lines.push("");

	lines.push("## Code");
	if (builtin)
		lines.push(
			`- Built into Tedix (\`${entry}\`). Its settings are in manifest.json.`,
		);
	else if (widget)
		lines.push(
			`- Client: the view at \`${entry}\`, served by its connected app.`,
		);
	else if (entry && !skill) lines.push(`- Entry: \`${entry}\`.`);
	if (skill) lines.push(`- Server: the governed skill \`${skill}\`.`);
	lines.push("");

	lines.push("## Notes");
	lines.push(manifest?.notes?.trim() || "None yet.");
	return `${lines.join("\n")}\n`;
}
