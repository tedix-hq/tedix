import { env } from "cloudflare:workers";
import { abortAllDurableObjects } from "cloudflare:test";
import { getWorkspace } from "@cloudflare/computer";
import { expect, it, vi } from "vite-plus/test";
import {
	ScopedComputerWorkspace,
	computerWorkspaceScope,
} from "../src/computer-workspace-scope";
import type { TediComputerWorkspaceDO } from "../src/computer-workspace-do";

const bindings = env as unknown as {
	TEDI_COMPUTER_WORKSPACE: DurableObjectNamespace<TediComputerWorkspaceDO>;
};

async function open(name: string, scope: string) {
	const stub = bindings.TEDI_COMPUTER_WORKSPACE.getByName(name);
	await stub.initialize({ ownerId: "owner-test", tediId: "tedi-test", scope });
	return getWorkspace(stub as unknown as Parameters<typeof getWorkspace>[0]);
}

it("isolates identical absolute paths across concurrent workspace RPC clients", async () => {
	const name = crypto.randomUUID();
	using a = await open(`${name}:a`, "conversation-a");
	using b = await open(`${name}:b`, "conversation-b");
	await Promise.all([
		a.fs.mkdir("/workspace/repo", { recursive: true }),
		b.fs.mkdir("/workspace/repo", { recursive: true }),
	]);
	await Promise.all([
		a.fs.writeFile("/workspace/repo/notes.txt", "conversation A"),
		b.fs.writeFile("/workspace/repo/notes.txt", "conversation B"),
	]);
	expect(await a.fs.readFile("/workspace/repo/notes.txt", "utf8")).toBe(
		"conversation A",
	);
	expect(await b.fs.readFile("/workspace/repo/notes.txt", "utf8")).toBe(
		"conversation B",
	);
	await b.fs.rm("/workspace/repo", { recursive: true });
	expect(await a.fs.readFile("/workspace/repo/notes.txt", "utf8")).toBe(
		"conversation A",
	);
});

it("preserves scoped files and immutable identity across DO restart", async () => {
	const name = crypto.randomUUID();
	{
		using first = await open(name, "persistent-conversation");
		await first.fs.writeFile("/workspace/note.txt", "survives restart");
	}
	await abortAllDurableObjects();
	using recovered = await open(name, "persistent-conversation");
	expect(await recovered.fs.readFile("/workspace/note.txt", "utf8")).toBe(
		"survives restart",
	);
	const stub = bindings.TEDI_COMPUTER_WORKSPACE.getByName(name);
	await expect(
		(async () =>
			await stub.initialize({
				ownerId: "owner-test",
				tediId: "other-tedi",
				scope: "persistent-conversation",
			}))(),
	).rejects.toThrow("identity cannot change");
	await expect(
		(async () =>
			await stub.initialize({
				ownerId: "owner-test",
				tediId: "tedi-test",
				scope: "other-conversation",
			}))(),
	).rejects.toThrow("identity cannot change");
});

it("routes the Worker shell callback to the same isolated filesystem", async () => {
	const name = crypto.randomUUID();
	using a = await open(`${name}:a`, "shell-a");
	using b = await open(`${name}:b`, "shell-b");
	await a.fs.writeFile("/workspace/input.txt", "alpha");
	await b.fs.writeFile("/workspace/input.txt", "beta");
	const [left, right] = await Promise.all([
		a.runtime.exec("cat /workspace/input.txt > /workspace/output.txt", {
			backend: "isolate",
		}),
		b.runtime.exec("cat /workspace/input.txt > /workspace/output.txt", {
			backend: "isolate",
		}),
	]);
	const results = await Promise.all([left.result(), right.result()]);
	expect(results.map((result) => result.exitCode)).toEqual([0, 0]);
	expect(await a.fs.readFile("/workspace/output.txt", "utf8")).toBe("alpha");
	expect(await b.fs.readFile("/workspace/output.txt", "utf8")).toBe("beta");
}, 30_000);

it("keeps returned streams and execution handles usable after client disposal", async () => {
	const client = await open(crypto.randomUUID(), "transferred-handles");
	await client.fs.writeFile("/workspace/input.txt", "transfer survives");
	const stream = await client.fs.readFile("/workspace/input.txt");
	const handle = await client.runtime.exec("cat /workspace/input.txt", {
		backend: "isolate",
		encoding: "utf8",
	});
	client[Symbol.dispose]();
	expect(await new Response(stream).text()).toBe("transfer survives");
	const result = await handle.result();
	expect(result.exitCode).toBe(0);
	expect(result.stdout).toBe("transfer survives");
}, 30_000);

it("keeps native Git operations confined to their workspace storage", async () => {
	const name = crypto.randomUUID();
	using a = await open(`${name}:a`, "git-a");
	using b = await open(`${name}:b`, "git-b");
	await a.fs.mkdir("/workspace/repo", { recursive: true });
	await b.fs.mkdir("/workspace/repo", { recursive: true });
	const initialized = await a.git.cli({
		argv: ["init"],
		cwd: "/workspace/repo",
	});
	expect(initialized.exitCode).toBe(0);
	await a.fs.writeFile("/workspace/repo/only-a.txt", "native git");
	const added = await a.git.cli({
		argv: ["add", "only-a.txt"],
		cwd: "/workspace/repo",
	});
	expect(added.exitCode).toBe(0);
	const files = await a.git.cli({ argv: ["ls-files"], cwd: "/workspace/repo" });
	expect(files.stdout).toContain("only-a.txt");
	await expect(
		(async () => await b.fs.stat("/workspace/repo/.git"))(),
	).rejects.toThrow("no such path");
});

it("uses the production scoped adapter for native tools, shell and Code Mode files", async () => {
	const owner = crypto.randomUUID();
	const scoped = (sessionKey: string) =>
		new ScopedComputerWorkspace(
			bindings.TEDI_COMPUTER_WORKSPACE,
			computerWorkspaceScope({ sessionKey }),
			owner,
			async () => "tedi-test",
		);
	const a = scoped("chat/a");
	const b = scoped("chat:a");
	expect(a.id).not.toBe(b.id);
	await a.workspace.writeFile("input.txt", "scope A");
	await b.workspace.writeFile("input.txt", "scope B");
	const options = {
		toolCallId: "native-test",
		messages: [],
		context: undefined,
	};
	const tools = a.tools();
	const output = await tools.exec!.execute!(
		{ command: "cat /workspace/input.txt > /workspace/result.txt" } as never,
		options,
	);
	expect(structuredClone(output)).toMatchObject({ exitCode: 0 });
	expect(await a.workspace.readFile("result.txt")).toBe("scope A");
	expect(await b.workspace.readFile("result.txt")).toBeNull();
	const read = await tools.read!.execute!(
		{ path: "/workspace/input.txt" } as never,
		options,
	);
	expect(read).toMatchObject({ content: expect.stringContaining("scope A") });
	const reconstructed = scoped("chat/a");
	expect(reconstructed.snapshotPrefix).toBe(a.snapshotPrefix);
	expect(reconstructed.snapshotPrefix).not.toBe(b.snapshotPrefix);
	expect(await reconstructed.workspace.readFile("result.txt")).toBe("scope A");
}, 30_000);

it("supports native git -C local operations through the Worker shell", async () => {
	using client = await open(crypto.randomUUID(), "git-global-cwd");
	using execution = await client.runtime.exec(
		"mkdir -p /workspace/localgit && git init /workspace/localgit && git -C /workspace/localgit status",
		{ backend: "isolate", encoding: "utf8" },
	);
	const result = await execution.result();
	expect(result.exitCode).toBe(0);
	expect(result.stderr).toBe("");
	expect(result.stdout).toContain("Initialized empty Git repository");
}, 30_000);

it("rejects shell Git network verbs at the native host boundary", async () => {
	const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
		throw new Error("Git network policy was bypassed");
	});
	try {
		using client = await open(crypto.randomUUID(), "git-network-policy");
		for (const command of [
			"git clone https://git.invalid/repo.git /workspace/repo",
			"git fetch origin",
			"git push origin main",
			"git pull origin main",
			"git -C /workspace fetch origin",
			"git -C /workspace push origin main",
		]) {
			using execution = await client.runtime.exec(command, {
				backend: "isolate",
				encoding: "utf8",
			});
			const result = await execution.result();
			expect(result.exitCode).toBe(126);
			expect(result.stderr).toContain("subcommand_not_allowed");
		}
		expect(fetch).not.toHaveBeenCalled();
	} finally {
		fetch.mockRestore();
	}
}, 30_000);

it("clones through the typed workspace-owner RPC into only the selected scope", async () => {
	// A self-contained Git pack generated from a one-file fixture repository.
	const commit = "0c2b7e7b306ef579f7051b08f1b88a105d6c0973";
	const packfile = Uint8Array.from(
		atob(
			"UEFDSwAAAAIAAAADmAp4nJXLQQoCMQxA0X1PkQsoSWraKYi48h7tmOCAZaRmYI7vQi/g7i/e96EKnIykzFxP3GxqsSBHuqesGVWURSxaizWHuvljHXBbdt+Gwtm+cdW99tdTj65vvwDlqbAkQoIDJsQwr70v7vr/GX4ufAA6AzQspQJ4nDM0MDAzMVEIcnV08XXVy01hSKk+Wi5wwUKCo9xpf9nUqgUHX3sJAgDM3Az0PXicS87Jz0tNUUiqLEkt5gIAI1oEx3BGwim9hWMAdOCxXVrkdbded/vr",
		),
		(character) => character.charCodeAt(0),
	);
	const packet = (text: string) =>
		(new TextEncoder().encode(text).length + 4).toString(16).padStart(4, "0") +
		text;
	const advertisement =
		packet("# service=git-upload-pack\n") +
		"0000" +
		packet(`${commit} HEAD\0side-band-64k symref=HEAD:refs/heads/main\n`) +
		packet(`${commit} refs/heads/main\n`) +
		"0000";
	const requests: string[] = [];
	const fetch = vi
		.spyOn(globalThis, "fetch")
		.mockImplementation(async (input) => {
			const url =
				typeof input === "string"
					? input
					: input instanceof URL
						? input.href
						: input.url;
			requests.push(url);
			if (
				url ===
				"https://git.example.test/repo.git/info/refs?service=git-upload-pack"
			) {
				return new Response(advertisement, {
					headers: {
						"content-type": "application/x-git-upload-pack-advertisement",
					},
				});
			}
			if (url === "https://git.example.test/repo.git/git-upload-pack") {
				return new Response(
					new Blob([
						packet("NAK\n"),
						(packfile.length + 5).toString(16).padStart(4, "0"),
						new Uint8Array([1]),
						packfile,
						"0000",
					]),
					{
						headers: { "content-type": "application/x-git-upload-pack-result" },
					},
				);
			}
			throw new Error(`Unexpected fixture request: ${url}`);
		});
	try {
		const owner = crypto.randomUUID();
		const a = new ScopedComputerWorkspace(
			bindings.TEDI_COMPUTER_WORKSPACE,
			computerWorkspaceScope({ sessionKey: "clone-a" }),
			owner,
			async () => "tedi-test",
		);
		const b = new ScopedComputerWorkspace(
			bindings.TEDI_COMPUTER_WORKSPACE,
			computerWorkspaceScope({ sessionKey: "clone-b" }),
			owner,
			async () => "tedi-test",
		);
		await a.git.clone({
			url: "https://git.example.test/repo.git",
			dir: "/workspace/repo",
			ref: "main",
			depth: 0,
		});
		expect(await a.workspace.readFile("repo/README.md")).toBe("cloned bytes\n");
		expect(await b.workspace.readFile("repo/README.md")).toBeNull();
		expect(requests).toHaveLength(2);
	} finally {
		fetch.mockRestore();
	}
}, 30_000);

it("parses quoted network command names as text and rejects actual unavailable commands", async () => {
	const scoped = new ScopedComputerWorkspace(
		bindings.TEDI_COMPUTER_WORKSPACE,
		computerWorkspaceScope({ sessionKey: "shell-parser" }),
		crypto.randomUUID(),
		async () => "tedi-test",
	);
	const tools = scoped.tools();
	const quoted = await tools.exec!.execute!(
		{ command: "printf '%s\\n' 'example; curl is a command name'" },
		{ toolCallId: "quoted", messages: [], context: undefined },
	);
	expect(quoted).toMatchObject({
		exitCode: 0,
		stdout: "example; curl is a command name\n",
	});
	const unavailable = await tools.exec!.execute!(
		{ command: "curl https://example.com" },
		{ toolCallId: "unavailable", messages: [], context: undefined },
	);
	expect(unavailable).toMatchObject({ exitCode: 1 });
});

it("keeps Code Mode environment metadata outside immutable scratch identity", async () => {
	const owner = crypto.randomUUID();
	const scope = { kind: "conversation" as const, key: "code-binding" };
	const native = new ScopedComputerWorkspace(
		bindings.TEDI_COMPUTER_WORKSPACE,
		scope,
		owner,
		async () => "tedi-test",
	);
	const bound = new ScopedComputerWorkspace(
		bindings.TEDI_COMPUTER_WORKSPACE,
		{ ...scope, environment: null } as typeof scope,
		owner,
		async () => "tedi-test",
	);
	await native.workspace.writeFile("/workspace/binding.txt", "native");
	expect(await bound.workspace.readFile("/workspace/binding.txt")).toBe(
		"native",
	);
	await bound.workspace.writeFile("/workspace/binding.txt", "code");
	expect(await native.workspace.readFile("/workspace/binding.txt")).toBe(
		"code",
	);
});

it("guards owner-side rollback across RPC clients and a workspace restart", async () => {
	const name = crypto.randomUUID();
	const stub = bindings.TEDI_COMPUTER_WORKSPACE.getByName(name);
	await stub.initialize({
		ownerId: "owner-test",
		tediId: "tedi-test",
		scope: "guarded-undo",
	});
	let previousContent: string | null;
	{
		using client = await getWorkspace(
			stub as unknown as Parameters<typeof getWorkspace>[0],
		);
		await client.fs.mkdir("/workspace/undo", { recursive: true });
		await client.fs.writeFile("/workspace/undo/note.txt", "prior");
		const receipt = await stub.writeReversibleFile("undo/note.txt", "approved");
		previousContent = receipt.previousContent;
		expect(previousContent).toBe("prior");
		await client.fs.writeFile("/workspace/undo/note.txt", "newer");
		await expect(
			(async () =>
				await stub.restoreFile("undo/note.txt", "approved", previousContent))(),
		).rejects.toThrow("workspace_rollback_conflict");
		expect(await client.fs.readFile("/workspace/undo/note.txt", "utf8")).toBe(
			"newer",
		);
		await client.fs.writeFile("/workspace/undo/note.txt", "approved");
	}
	await abortAllDurableObjects();
	const recovered = bindings.TEDI_COMPUTER_WORKSPACE.getByName(name);
	await recovered.restoreFile("undo/note.txt", "approved", previousContent!);
	using restarted = await getWorkspace(
		recovered as unknown as Parameters<typeof getWorkspace>[0],
	);
	expect(await restarted.fs.readFile("/workspace/undo/note.txt", "utf8")).toBe(
		"prior",
	);
});
