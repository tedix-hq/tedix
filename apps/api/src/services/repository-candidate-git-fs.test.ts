import { describe, expect, it, vi } from "vite-plus/test";
import { CandidateGitMemoryFs } from "./repository-candidate-git-fs";

describe("bounded request-local candidate Git filesystem", () => {
	it("rejects oversized UTF-8 strings before allocating their encoded buffer", async () => {
		const fs = new CandidateGitMemoryFs(5);
		const encode = vi.spyOn(TextEncoder.prototype, "encode");
		try {
			await expect(
				fs.promises.writeFile("/too-large", "😀😀"),
			).rejects.toMatchObject({ code: "ENOSPC" });
			expect(encode).not.toHaveBeenCalled();
			expect(fs.storedBytes).toBe(0);
		} finally {
			encode.mockRestore();
		}
	});
	it("counts replacements and removals without retaining caller buffers", async () => {
		const fs = new CandidateGitMemoryFs(5);
		await fs.promises.mkdir("/git/objects", { recursive: true });
		const input = new Uint8Array([1, 2, 3]);
		await fs.promises.writeFile("/git/objects/a", input);
		input[0] = 9;
		expect(await fs.promises.readFile("/git/objects/a")).toEqual(
			new Uint8Array([1, 2, 3]),
		);
		await fs.promises.writeFile("/git/objects/a", "ab");
		expect(fs.storedBytes).toBe(2);
		await expect(
			fs.promises.writeFile("/git/objects/b", "1234"),
		).rejects.toMatchObject({ code: "ENOSPC" });
		expect(fs.storedBytes).toBe(2);
		await fs.promises.unlink("/git/objects/a");
		expect(fs.storedBytes).toBe(0);
	});
	it("bounds directories and rejects unsupported links", async () => {
		const fs = new CandidateGitMemoryFs(10, 3);
		await fs.promises.mkdir("/a/b", { recursive: true });
		await expect(fs.promises.mkdir("/a/b/c")).rejects.toMatchObject({
			code: "ENOSPC",
		});
		await expect(fs.promises.readlink()).rejects.toMatchObject({
			code: "ENOSYS",
		});
		await expect(fs.promises.symlink()).rejects.toMatchObject({
			code: "ENOSYS",
		});
		await expect(fs.promises.rmdir("/a")).rejects.toMatchObject({
			code: "ENOTEMPTY",
		});
	});
});
