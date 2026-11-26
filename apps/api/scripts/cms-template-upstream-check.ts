// Manual run of the weekly upstream-template check's comparison half: reads each
// native starter's committed UPSTREAM.md and compares its recorded upstream
// commit against emdash-cms/emdash main. No database or Work filing.
import { readFile } from "node:fs/promises";
import { checkCmsTemplateUpstreamState } from "../src/services/cms-template-upstream";

const state = await checkCmsTemplateUpstreamState({
	readUpstreamFile: async (slug) => {
		try {
			return await readFile(
				new URL(`../../cms/templates/${slug}/UPSTREAM.md`, import.meta.url),
				"utf8",
			);
		} catch {
			return null;
		}
	},
});
console.log(
	JSON.stringify(
		{
			upstreamRevision: state.upstreamRevision,
			findings: state.findings,
			missing: state.missing,
		},
		null,
		2,
	),
);
