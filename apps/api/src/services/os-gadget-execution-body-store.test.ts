import { describe, expect, it } from "vite-plus/test";
import {
	readGadgetExecutionBody,
	storeGadgetExecutionBody,
} from "./os-gadget-execution-body-store";

describe("gadget execution bodies", () => {
	it("round trips exact strings, rejects cross-tenant reads and refuses missing or corrupted storage", async () => {
		const objects = new Map<string, ArrayBuffer>();
		const bucket = {
			put: async (key: string, bytes: ArrayBuffer) => {
				objects.set(key, bytes);
			},
			get: async (key: string) => {
				const value = objects.get(key);
				return value ? { arrayBuffer: async () => value } : null;
			},
		};
		const row = {
			organizationId: "org-a",
			input: '{"text":"Grüße 🌍"}\n',
			output: "",
			bodyR2Key: null,
			bodyBytes: null,
		};
		const pointer = await storeGadgetExecutionBody(bucket, row);
		const cleared = { ...row, input: null, output: null, ...pointer };
		expect(await readGadgetExecutionBody(cleared, bucket)).toMatchObject({
			input: row.input,
			output: row.output,
		});
		await expect(
			readGadgetExecutionBody({ ...cleared, organizationId: "org-b" }, bucket),
		).rejects.toThrow("organization");
		await expect(
			readGadgetExecutionBody(
				{ ...cleared, bodyBytes: pointer.bodyBytes + 1 },
				bucket,
			),
		).rejects.toThrow("integrity");
		const other = await storeGadgetExecutionBody(bucket, {
			...row,
			input: row.input.replace("Grüße", "Grüßa"),
		});
		objects.set(pointer.bodyR2Key, objects.get(other.bodyR2Key)!);
		await expect(readGadgetExecutionBody(cleared, bucket)).rejects.toThrow(
			"integrity",
		);
		objects.delete(pointer.bodyR2Key);
		await expect(readGadgetExecutionBody(cleared, bucket)).rejects.toThrow(
			"missing",
		);
		await expect(
			storeGadgetExecutionBody({ ...bucket, get: async () => null }, row),
		).rejects.toThrow("missing");
	});
});
