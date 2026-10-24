import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
	blocksFromRichText,
	markdownDocument,
} from "@tedix/api-contract/utils/os-document";
import { DocumentEditor } from "../src/components/output-editor-document";
import { OutputContentView } from "../src/components/output-content";
import type { DocumentContent } from "../src/lib/output-models";
import "../src/styles.css";
import "../src/components/output-editor.css";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") ?? "light";
const view = params.get("view") ?? "edit";
const empty = params.has("empty");
document.documentElement.classList.toggle("dark", theme === "dark");
document.documentElement.dataset.mode = theme;
document.documentElement.dataset.theme = "tedix";

const SAMPLE = `# Quarterly operating plan

This plan sets out what the team commits to this quarter, who owns each outcome, and how progress is checked every Friday.

## Goals

1. Ship the self-serve onboarding flow.
2. Cut first-response time on support tickets to under two hours.
3. Close the books within five working days of month end.

## Owners and checkpoints

| Outcome | Owner | Checkpoint |
| --- | --- | --- |
| Onboarding | Product | Weekly demo |
| Support | Operations | Daily queue review |
| Close | Finance | Month-end checklist |

> Decisions that change scope go to the weekly review, not to chat.

### Risks

- Hiring for the support rota may slip by two weeks.
- The billing migration overlaps with the close.

## Appendix

\`\`\`
owner: finance
cadence: monthly
\`\`\`
`;

function initial(): DocumentContent {
	const richText = empty
		? { type: "doc" as const, content: [{ type: "paragraph" }] }
		: markdownDocument(SAMPLE);
	return {
		kind: "document",
		richText,
		blocks: blocksFromRichText(richText),
	} as DocumentContent;
}

function Fixture() {
	const [value, setValue] = useState<DocumentContent>(initial);
	return (
		<main
			className="flex h-dvh min-w-0 flex-col bg-kumo-base text-kumo-default"
			data-fixture-view={view}
		>
			{view === "read" ? (
				<div className="min-h-0 flex-1 overflow-auto p-4">
					<OutputContentView content={value} onEdit={() => {}} />
				</div>
			) : (
				<div className="min-h-0 flex-1 overflow-auto">
					<DocumentEditor value={value} onChange={setValue} />
				</div>
			)}
			<output className="sr-only" data-document-text>
				{value.blocks.length}
			</output>
		</main>
	);
}

createRoot(document.getElementById("root")!).render(<Fixture />);
