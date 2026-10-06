import type React from "react";

function SiteDevelopmentPage() {
	return (
		<section>
			<h1>Code and deployments</h1>
			<p>
				Edit content, media, menus and site settings in EmDash. Use the content
				editor to preview and publish changes.
			</p>
			<p>
				For theme code, domains and deployments, open Sites in your Tedix
				workspace.
			</p>
			<a
				href="https://os.tedix.dev/sites"
				target="_blank"
				rel="noopener noreferrer"
			>
				Open Sites
			</a>
		</section>
	);
}

export const pages = {
	"/development": SiteDevelopmentPage,
} satisfies Record<string, React.ComponentType>;

// Search text is produced by the page-search hook; editors change the page blocks.
export function DerivedSearchText({ value }: { value: unknown }) {
	return (
		<details>
			<summary>Generated search text</summary>
			<p>
				This text is generated when page sections are saved. Edit the sections
				to update it.
			</p>
			<p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
				{typeof value === "string" && value ? value : "No search text yet."}
			</p>
		</details>
	);
}

export const fields = { "derived-search-text": DerivedSearchText };
