import { createContext, Fragment, useContext, type ReactNode } from "react";
import {
	workLayouts,
	type WorkLayout,
} from "@tedix/api-contract/blueprints/work-layout";

export const WorkLayoutContext = createContext<WorkLayout>({});

const defaults = { ...workLayouts.feed, ...workLayouts.deck };

export function WorkLayoutRegion({
	region,
	slots,
}: {
	region: keyof WorkLayout;
	slots: Record<string, ReactNode>;
}) {
	const layout = useContext(WorkLayoutContext);
	return (layout[region] ?? defaults[region]).map((node) => {
		if (typeof node === "string")
			return <Fragment key={node}>{slots[node]}</Fragment>;
		return (
			<section key={node.sections.join(":")}>
				{node.title && <h3 className="mb-2 font-semibold">{node.title}</h3>}
				<div
					className={
						node.display === "columns"
							? "grid gap-3 md:grid-cols-2"
							: "grid gap-3"
					}
				>
					{node.sections.map((key) => (
						<Fragment key={key}>{slots[key]}</Fragment>
					))}
				</div>
			</section>
		);
	});
}
