import { describe, it, expect, vi } from "vite-plus/test";
import { DEFAULT_ATTENTION_LAYOUT } from "@tedix/api-contract/schemas/attention-layout";
import { buildAttentionWebMcpTools } from "./attention-webmcp-tools";
describe("Attention browser tools", () => {
	it("uses the current controller, validates writes, and returns errors without throwing", async () => {
		const save = vi.fn().mockResolvedValue({});
		let layout = DEFAULT_ATTENTION_LAYOUT;
		const [read, update] = buildAttentionWebMcpTools(() => ({ layout, save }));
		layout = { ...layout, focusToday: "Supply" };
		expect(JSON.stringify(await read!.execute({}))).toContain("Supply");
		expect((await update!.execute({ widgets: ["unknown"] })).isError).toBe(
			true,
		);
		expect(save).not.toHaveBeenCalled();
		await update!.execute({ ...layout, hiddenColumns: ["done"] });
		expect(save).toHaveBeenCalledWith({ ...layout, hiddenColumns: ["done"] });
		save.mockRejectedValueOnce(new Error("Conflict"));
		expect((await update!.execute(layout)).isError).toBe(true);
	});
});
