import * as z from "zod";
import { type JsonValue, JsonValueSchema } from "./common";

/** Structured JSON object bounded for Worker validation and D1 persistence. */
export const BoundedJsonObjectSchema = z
	.record(z.string().max(200), JsonValueSchema)
	.superRefine((value, context) => {
		let keys = 0,
			nodes = 0;
		const depths = new WeakMap<object, number>([[value, 0]]);
		try {
			const json = JSON.stringify(value, function (key, child) {
				const depth = (depths.get(this) ?? 0) + 1;
				if (++nodes > 2_048 || depth > 8 || key.length > 200) throw new Error();
				if (key && !Array.isArray(this) && ++keys > 256) throw new Error();
				if (child && typeof child === "object") depths.set(child, depth);
				if (
					child !== null &&
					!["object", "string", "boolean", "number"].includes(typeof child)
				)
					throw new Error();
				if (typeof child === "number" && !Number.isFinite(child))
					throw new Error();
				return child;
			});
			if (new TextEncoder().encode(json).byteLength > 32_768) throw new Error();
		} catch {
			context.addIssue({
				code: "custom",
				message: "JSON exceeds input budget",
			});
		}
	}) as z.ZodType<Record<string, JsonValue>>;
