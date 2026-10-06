import { getCollection } from "astro:content";

export interface HubPage {
	id: string;
	href: string;
	title: string;
	description: string;
	topic: string;
	type:
		| "article"
		| "guide"
		| "tutorial"
		| "reference"
		| "troubleshooting"
		| "learning-path"
		| "video"
		| "release-note";
	date?: Date;
}

function label(value: string): string {
	return value
		.replace(/[-_]/g, " ")
		.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export async function getHubPages(): Promise<HubPage[]> {
	const entries = await getCollection("docs");
	return entries
		.filter((entry) => !["index", "readme"].includes(entry.id.toLowerCase()))
		.map((entry): HubPage => {
			const date = entry.data.date;
			const folder = entry.id.includes("/")
				? entry.id.split("/")[0]
				: "General";
			return {
				id: entry.id,
				href: `/${entry.id}/`,
				title: entry.data.title,
				description: entry.data.description ?? entry.data.summary ?? "",
				topic: entry.data.topic ?? label(folder),
				type: entry.data.resource_type ?? "article",
				date: date ? new Date(date) : undefined,
			};
		})
		.sort((a, b) => a.title.localeCompare(b.title));
}

export function getUpdates(pages: HubPage[]): HubPage[] {
	return pages
		.filter(
			(page) =>
				page.type === "release-note" &&
				page.date &&
				!Number.isNaN(page.date.getTime()),
		)
		.sort(
			(a, b) =>
				b.date!.getTime() - a.date!.getTime() || b.id.localeCompare(a.id),
		);
}
