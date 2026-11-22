import { z } from "zod";
import activity from "./activity/layout.json";
import decisions from "./decisions/layout.json";

export const workLayouts = { feed: activity, deck: decisions };
const group = z.strictObject({
	display: z.enum(["stack", "columns"]),
	title: z.string().trim().min(1).max(100).optional(),
	sections: z.array(z.string()).min(1).max(10),
});
const regionSchema = z
	.array(z.union([z.string(), group]))
	.min(1)
	.max(10);
export type WorkLayout = Partial<
	Record<
		keyof typeof activity | keyof typeof decisions,
		z.infer<typeof regionSchema>
	>
>;

/** Every section appears once, including the request and its approval controls. */
export function readWorkLayout(
	role: keyof typeof workLayouts,
	source?: string,
): WorkLayout {
	const defaults = workLayouts[role];
	if (source === undefined) return defaults;
	const layout: unknown = JSON.parse(source);
	if (!layout || typeof layout !== "object" || Array.isArray(layout))
		throw new Error("The layout must be an object.");
	const entries = Object.entries(layout);
	const parsed: WorkLayout = {};
	if (entries.length !== Object.keys(defaults).length)
		throw new Error("The layout must include each region.");
	for (const [region, slots] of Object.entries(defaults)) {
		const result = regionSchema.safeParse(
			Object.getOwnPropertyDescriptor(layout, region)?.value,
		);
		if (!result.success) throw new Error(`Check the sections in ${region}.`);
		const slotsInLayout = result.data.flatMap((node) =>
			typeof node === "string" ? [node] : node.sections,
		);
		if (
			slotsInLayout.length !== slots.length ||
			!slots.every((slot) => slotsInLayout.includes(slot))
		)
			throw new Error(
				`Use each section of ${region} exactly once: ${slots.join(", ")}.`,
			);
		parsed[region as keyof WorkLayout] = result.data;
	}
	return parsed;
}
