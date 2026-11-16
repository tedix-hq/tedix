import type { SkillEntry } from "@tedix/api-contract/schemas/cognitive";
import { useMemo } from "react";
import { Badge } from "@/components/kumo/badge";
import {
	Collapsible,
	CollapsibleDefaultContent,
	CollapsibleDefaultTrigger,
} from "@/components/kumo/collapsible";
import { Collection } from "@/components/kumo/page";
import { Text } from "@/components/kumo/text";
import {
	deriveSkillAnatomy,
	inputKindPhrase,
	inputLabel,
} from "@/lib/skill-anatomy";

/** A declared value in the words a person would type or pick. */
function plainValue(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value === "string") return value.length > 0 ? value : null;
	if (typeof value === "boolean") return value ? "Yes" : "No";
	if (typeof value === "number") return String(value);
	return null;
}

/** The default and the allowed choices an input's saved definition names. */
function inputHints(inputSchema: SkillEntry["inputSchema"], name: string) {
	const properties = inputSchema?.["properties"];
	const schema =
		properties && typeof properties === "object" && !Array.isArray(properties)
			? (properties as Record<string, unknown>)[name]
			: null;
	if (!schema || typeof schema !== "object" || Array.isArray(schema))
		return { fallback: null, choices: [] as string[] };
	const record = schema as Record<string, unknown>;
	return {
		fallback: plainValue(record["default"]),
		choices: Array.isArray(record["enum"])
			? record["enum"]
					.map(plainValue)
					.filter((choice): choice is string => choice !== null)
			: [],
	};
}

/**
 * What a run can be given when it starts, laid out like the form a person
 * would fill in: a label, whether it is needed, what to enter and why. Field
 * names and types stay behind Technical details.
 */
export function SkillInputsList({
	skill,
}: {
	skill: Pick<SkillEntry, "content" | "files" | "inputSchema">;
}) {
	const inputs = useMemo(() => deriveSkillAnatomy(skill).inputs, [skill]);
	if (inputs.length === 0)
		return (
			<Text role="body" tone="secondary" className="m-0">
				This skill asks for nothing when it starts.
			</Text>
		);
	return (
		<div className="grid min-w-0 gap-2">
			<Collection aria-label="Inputs">
				{inputs.map((input) => {
					const kind = inputKindPhrase(input.type);
					const hints = inputHints(skill.inputSchema, input.name);
					const hint = [
						hints.choices.length > 0
							? `One of: ${hints.choices.join(", ")}`
							: // Without a description the kind already leads the row.
								input.description && kind
								? `Enter: ${kind.toLowerCase()}`
								: null,
						hints.fallback ? `When left empty: ${hints.fallback}` : null,
					].filter((part): part is string => part !== null);
					return (
						<li
							key={input.name}
							data-skill-input
							className="grid min-w-0 gap-1 px-4 py-3"
						>
							<span className="flex min-w-0 flex-wrap items-center gap-2">
								<Text as="strong" role="body" className="wrap-anywhere">
									{inputLabel(input.name)}
								</Text>
								<Badge variant={input.required ? "secondary" : "outline"}>
									{input.required ? "Required" : "Optional"}
								</Badge>
							</span>
							<Text
								as="span"
								role="body"
								tone="secondary"
								className="min-w-0 wrap-anywhere"
							>
								{input.description ??
									(kind
										? `${kind}. No description yet.`
										: "No description yet.")}
							</Text>
							{hint.length > 0 ? (
								<Text as="span" role="label" tone="secondary">
									{hint.join(" · ")}
								</Text>
							) : null}
						</li>
					);
				})}
			</Collection>
			<Collapsible>
				<CollapsibleDefaultTrigger>Technical details</CollapsibleDefaultTrigger>
				<CollapsibleDefaultContent keepMounted>
					<ul className="m-0 grid min-w-0 list-none gap-0.5 px-2 pt-1 pb-2">
						{inputs.map((input) => (
							<li key={input.name}>
								<Text
									role="label"
									tone="mono-secondary"
									className="m-0 wrap-anywhere"
								>
									{input.name}
									{input.type ? `: ${input.type}` : ""}
									{input.required ? " · required" : ""}
								</Text>
							</li>
						))}
					</ul>
				</CollapsibleDefaultContent>
			</Collapsible>
		</div>
	);
}
