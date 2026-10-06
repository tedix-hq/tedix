import { useStateValue } from "@json-render/react";
import { useWidgetOpenExternal } from "../../lib/widget-host-hooks";
import { safeTrackedHref, type UtmParams } from "../../lib/utm";

export interface AnswerBlockSource {
	title: string;
	url: string;
	snippet?: string | null;
}

interface AnswerBlockProps {
	answer: string;
	query?: string | null;
	sources?: AnswerBlockSource[] | null;
}

export function AnswerBlockComponent({
	answer,
	query,
	sources,
}: AnswerBlockProps) {
	const utmParams = useStateValue<UtmParams>("/_utmParams");
	const openExternal = useWidgetOpenExternal(utmParams);
	return (
		<div className="space-y-4">
			{/* AI Answer */}
			<div className="rounded-xl bg-info/10 p-5 dark:bg-info/20">
				{query && (
					<div className="mb-3 flex items-center gap-2">
						<span className="rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground">
							{query}
						</span>
					</div>
				)}
				<h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-info">
					Answer
				</h2>
				<div className="whitespace-pre-wrap text-foreground leading-relaxed">
					{answer}
				</div>
			</div>

			{/* Sources */}
			{sources && sources.length > 0 && (
				<div className="space-y-2">
					<h3 className="text-sm font-semibold text-foreground">
						Sources ({sources.length})
					</h3>
					<div className="flex flex-col gap-2">
						{sources.map((source, i) => (
							<a
								key={source.url || i}
								href={safeTrackedHref(source.url, utmParams)}
								target="_blank"
								rel="noopener noreferrer"
								onClick={(e) => {
									e.preventDefault();
									openExternal(source.url);
								}}
								className="group flex items-start gap-2 rounded-lg border border-border p-3 transition-colors hover:bg-muted/50"
							>
								<span className="flex-shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
									{i + 1}
								</span>
								<div className="min-w-0 flex-1">
									<p className="text-sm font-medium text-primary group-hover:underline">
										{source.title}
									</p>
									{source.snippet && (
										<p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">
											{source.snippet}
										</p>
									)}
								</div>
							</a>
						))}
					</div>
				</div>
			)}
		</div>
	);
}
