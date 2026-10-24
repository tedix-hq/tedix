import { X } from "@phosphor-icons/react";
import { useEffect, useRef } from "react";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { Card, CardContent } from "@/components/kumo/card";
import { Text } from "@/components/kumo/text";
import type { ComposerSkill } from "@/lib/chat-skill-picker";

/**
 * The composer skill picker's presentation.
 *
 * Deliberately NOT a catalog: a bounded, filtered list of reachable skills
 * with a one-line summary each. The full SKILL.md stays behind `read_skill`.
 */
export function ChatSkillPicker({
	activeIndex,
	error,
	listboxId,
	loading,
	onRetry,
	onSelect,
	skills,
}: {
	/** -1 until the operator explicitly moves into the list. Enter only
	 *  confirms from a highlighted row, so plain slash text still submits. */
	activeIndex: number;
	error: boolean;
	listboxId: string;
	loading: boolean;
	onRetry: () => void;
	onSelect: (skill: ComposerSkill) => void;
	skills: readonly ComposerSkill[];
}) {
	const list = useRef<HTMLUListElement>(null);
	useEffect(() => {
		list.current?.children[activeIndex]?.scrollIntoView({ block: "nearest" });
	}, [activeIndex]);
	return (
		<Card
			data-slot="skill-picker"
			className="absolute right-0 bottom-full left-0 z-20 mb-2 max-h-[50dvh] overflow-y-auto py-1"
		>
			<CardContent className="px-1">
				{error ? (
					// A failed read is NOT an empty library. Saying "no skills" here
					// would teach the operator their org has none.
					<div
						role="alert"
						className="flex items-center justify-between gap-3 px-2 py-2"
					>
						<Text role="label" tone="secondary">
							Couldn't load skills.
						</Text>
						<Button type="button" size="sm" variant="outline" onClick={onRetry}>
							Retry
						</Button>
					</div>
				) : loading ? (
					<Text role="label" tone="secondary" className="block px-2 py-2">
						Loading skills…
					</Text>
				) : (
					<ul
						ref={list}
						id={listboxId}
						role="listbox"
						aria-label="Skills"
						className="m-0 flex list-none flex-col gap-0.5 p-0"
					>
						{skills.map((skill, index) => (
							<li key={skill.id} role="none">
								<Button
									id={`${listboxId}-option-${index}`}
									type="button"
									role="option"
									aria-selected={index === activeIndex}
									tabIndex={-1}
									variant={index === activeIndex ? "secondary" : "ghost"}
									// The composer must keep focus: a blur here swallows the
									// next Enter exactly the way a disabled send control does.
									onMouseDown={(event) => event.preventDefault()}
									onClick={() => onSelect(skill)}
									multiline
									className="w-full min-w-0 justify-start px-2 py-2 text-left"
								>
									<span className="flex w-full min-w-0 flex-col items-start gap-1">
										<span className="flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
											<Text
												role="label"
												weight="medium"
												truncate
												className="max-w-full"
											>
												{skill.title}
											</Text>
											<Badge variant="outline" className="max-w-full">
												<span className="truncate">{skill.slug}</span>
											</Badge>
										</span>
										{skill.summary ? (
											<Text
												role="label"
												tone="secondary"
												truncate
												className="w-full"
											>
												{skill.summary}
											</Text>
										) : null}
									</span>
								</Button>
							</li>
						))}
					</ul>
				)}
			</CardContent>
		</Card>
	);
}

/** The selected skills, as removable composer pills. */
export function ChatSkillPills({
	onRemove,
	skills,
}: {
	onRemove: (slug: string) => void;
	skills: ReadonlyArray<{ slug: string; title: string }>;
}) {
	if (skills.length === 0) return null;
	return (
		<div data-slot="skill-pills" className="flex flex-wrap gap-2 px-3 pt-3">
			{skills.map((skill) => (
				<Badge
					key={skill.slug}
					variant="outline"
					className="max-w-full gap-1 pr-1"
				>
					<span className="min-w-0 truncate">{skill.title}</span>
					<Button
						type="button"
						size="icon-sm"
						variant="ghost"
						aria-label={`Remove ${skill.title}`}
						onClick={() => onRemove(skill.slug)}
						icon={<X size={12} />}
					/>
				</Badge>
			))}
		</div>
	);
}
