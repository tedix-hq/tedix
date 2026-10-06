import type { NativeProcess } from "@tedix/container-runtime/sandbox";
const REPOSITORY_ROOT = "/workspace/repos";
const MAX_STATUS_BYTES = 64 * 1024;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_DIFF_BYTES = 512 * 1024;
const HELPER_TIMEOUT_MS = 5_000;
const CLEANUP_TIMEOUT_MS = 250;

export type RepositoryInspectionRequest = {
	operation: "status" | "diff" | "read";
	repositoryPath: string;
	baselineSha: string;
	path?: string;
	maxBytes?: number;
};

export type RepositoryInspectionResult = {
	kind: "git" | "file" | "symlink";
	currentSha: string;
	dataBase64: string;
	stderrBase64: string;
	exitCode: number;
	timedOut: boolean;
	truncated: boolean;
	truncationReasons: Array<
		"byte_limit" | "entry_limit" | "hunk_limit" | "line_limit" | "timeout"
	>;
	files?: Array<{
		path: string;
		status:
			| "added"
			| "deleted"
			| "modified"
			| "type_changed"
			| "unmerged"
			| "untracked"
			| "unknown";
		rawStatus: string;
		untracked: boolean;
	}>;
	entryCount?: number;
	binary?: boolean;
	skipReason?:
		| "binary"
		| "command_failed"
		| "invalid_utf8"
		| "unsupported_content_filter"
		| null;
	hunks?: RepositoryDiffHunk[];
	size?: number;
};

export type RepositoryDiffHunk = {
	header: string;
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	lines: Array<{
		kind: "addition" | "context" | "deletion" | "meta";
		content: string;
		oldLine: number | null;
		newLine: number | null;
	}>;
};

const MAX_HUNKS = 200;
const MAX_HUNK_LINES = 2_000;

export type RepositoryInspectionExecutor = (
	argv: readonly [string, ...string[]],
	options: { timeout: number },
) => Promise<NativeProcess>;

function inspectionTimeout(): Error {
	return new Error("Repository inspection timed out");
}

async function beforeDeadline<T>(
	promise: Promise<T>,
	deadline: number,
): Promise<T> {
	const remaining = deadline - Date.now();
	if (remaining <= 0) throw inspectionTimeout();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(inspectionTimeout()), remaining);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function boundedCleanup(
	operation: () => Promise<unknown>,
): Promise<void> {
	const pending = Promise.resolve()
		.then(operation)
		.catch(() => undefined);
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			pending,
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, CLEANUP_TIMEOUT_MS);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export function parseUnifiedDiff(raw: string): {
	hunks: RepositoryDiffHunk[];
	truncationReasons: Array<"hunk_limit" | "line_limit">;
} {
	const hunks: RepositoryDiffHunk[] = [];
	const truncationReasons: Array<"hunk_limit" | "line_limit"> = [];
	let current: RepositoryDiffHunk | undefined;
	let oldLine = 0;
	let newLine = 0;
	let lineCount = 0;
	for (const line of raw.split("\n")) {
		const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
		if (header) {
			if (hunks.length >= MAX_HUNKS) {
				truncationReasons.push("hunk_limit");
				break;
			}
			oldLine = Number(header[1]);
			newLine = Number(header[3]);
			current = {
				header: line,
				oldStart: oldLine,
				oldLines: Number(header[2] ?? "1"),
				newStart: newLine,
				newLines: Number(header[4] ?? "1"),
				lines: [],
			};
			hunks.push(current);
			continue;
		}
		if (!current) continue;
		if (lineCount >= MAX_HUNK_LINES) {
			truncationReasons.push("line_limit");
			break;
		}
		if (line.startsWith("+") && !line.startsWith("+++")) {
			current.lines.push({
				kind: "addition",
				content: line.slice(1),
				oldLine: null,
				newLine: newLine++,
			});
		} else if (line.startsWith("-") && !line.startsWith("---")) {
			current.lines.push({
				kind: "deletion",
				content: line.slice(1),
				oldLine: oldLine++,
				newLine: null,
			});
		} else if (line.startsWith(" ")) {
			current.lines.push({
				kind: "context",
				content: line.slice(1),
				oldLine: oldLine++,
				newLine: newLine++,
			});
		} else if (line.startsWith("\\")) {
			current.lines.push({
				kind: "meta",
				content: line,
				oldLine: null,
				newLine: null,
			});
			continue;
		} else {
			continue;
		}
		lineCount += 1;
	}
	return { hunks, truncationReasons };
}

const PYTHON_HELPER = String.raw`
import base64, errno, json, os, selectors, signal, stat, subprocess, sys, time

root, repo_path, operation, baseline, requested_path, max_bytes_raw = sys.argv[1:]
max_bytes = int(max_bytes_raw)

def fail(message):
    print(json.dumps({"error": message}, separators=(",", ":")))
    raise SystemExit(2)

def components(value, allow_empty=False):
    if allow_empty and value == "": return []
    if not value or value.startswith("/") or "\x00" in value: fail("invalid path")
    parts = value.split("/")
    if any(part in ("", ".", "..") for part in parts): fail("invalid path")
    return parts

if len(baseline) != 40 or any(ch not in "0123456789abcdef" for ch in baseline):
    fail("invalid baseline")
repo_parts = components(repo_path)
path_parts = components(requested_path, True)

flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
fd = os.open(root, flags)
try:
    for part in repo_parts:
        next_fd = os.open(part, flags, dir_fd=fd)
        os.close(fd)
        fd = next_fd
    repo_fd = fd
    fd = -1
    git_fd = os.open(".git", flags, dir_fd=repo_fd)
    # Pin the helper itself to the opened repository descriptor. Every child
    # inherits this cwd, so replacing a pathname cannot retarget later Git calls.
    os.fchdir(repo_fd)

    env = {
        "HOME": "/nonexistent",
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "LC_ALL": "C",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_EXTERNAL_DIFF": "",
        # Production Sandbox is Linux and keeps Git pinned to the opened descriptor.
        # macOS lacks a Git-readable procfs fd path; dot-git is used only by local tests
        # after the same no-follow open above.
        "GIT_DIR": "/proc/self/fd/%d" % git_fd if os.path.isdir("/proc/self/fd") else ".git",
        "GIT_NO_LAZY_FETCH": "1",
        "GIT_NO_REPLACE_OBJECTS": "1",
        "GIT_OPTIONAL_LOCKS": "0",
        "GIT_PAGER": "cat",
        "GIT_WORK_TREE": ".",
        "PAGER": "cat",
    }
    operation_deadline = time.monotonic() + 4.0

    def run(argv):
        process = subprocess.Popen(argv, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            pass_fds=(repo_fd, git_fd), close_fds=True, start_new_session=True)
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ, "stdout")
        selector.register(process.stderr, selectors.EVENT_READ, "stderr")
        output = {"stdout": bytearray(), "stderr": bytearray()}
        truncated = False
        try:
            while selector.get_map():
                if time.monotonic() >= operation_deadline:
                    os.killpg(process.pid, signal.SIGKILL); process.wait()
                    return bytes(output["stdout"]), bytes(output["stderr"]), process.returncode, True, truncated
                for key, _ in selector.select(min(0.05, max(0, operation_deadline - time.monotonic()))):
                    chunk = os.read(key.fileobj.fileno(), 65536)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    remaining = max_bytes + 1 - len(output[key.data])
                    output[key.data].extend(chunk[:max(0, remaining)])
                    if len(output[key.data]) > max_bytes:
                        truncated = True
                        os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
        return bytes(output["stdout"][:max_bytes]), bytes(output["stderr"][:max_bytes]), process.returncode, False, truncated

    common = ["git", "--literal-pathspecs", "--no-pager", "-c", "core.fsmonitor=false", "-c", "core.attributesFile=/dev/null", "-c", "color.ui=false"]
    pathspec = ["--", requested_path] if requested_path else []
    verified = run(common + ["cat-file", "-e", baseline + "^{commit}"])
    if verified[2] != 0: fail("baseline is not a local commit")
    current = run(common + ["rev-parse", "--verify", "HEAD^{commit}"])
    current_sha = current[0].strip().decode("ascii")
    if current[2] != 0 or len(current_sha) != 40 or any(ch not in "0123456789abcdef" for ch in current_sha): fail("current commit is unavailable")
    if operation in ("status", "diff"):
        filters = run(common + ["config", "--includes", "--name-only", "--get-regexp", r"^filter\..*\.(clean|process)$"])
        if filters[3]: fail("unable to inspect repository filters")
        if filters[2] == 0: fail("external content filters are unsupported")
        if filters[2] != 1: fail("unable to inspect repository filters")
    if operation == "status":
        tracked = run(common + ["diff", "--name-status", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", baseline] + pathspec)
        untracked = run(common + ["ls-files", "--others", "--exclude-standard", "-z"] + pathspec)
        tracked_tokens = tracked[0].split(b"\0")[:-1]
        untracked_tokens = untracked[0].split(b"\0")[:-1]
        tracked_pairs = list(zip(tracked_tokens[0::2], tracked_tokens[1::2]))
        selected_tracked, selected_untracked, selected_bytes = [], [], 0
        for status, path in tracked_pairs:
            record_bytes = len(status) + len(path) + 2
            if len(selected_tracked) + len(selected_untracked) >= 200 or selected_bytes + record_bytes > max_bytes: break
            selected_tracked.append((status, path)); selected_bytes += record_bytes
        for path in untracked_tokens:
            record_bytes = len(path) + 1
            if len(selected_tracked) + len(selected_untracked) >= 200 or selected_bytes + record_bytes > max_bytes: break
            selected_untracked.append(path); selected_bytes += record_bytes
        def change_status(raw):
            code = raw[:1]
            return {b"A":"added", b"D":"deleted", b"M":"modified", b"T":"type_changed", b"U":"unmerged"}.get(code, "unknown")
        try:
            files = [{"path":path.decode("utf-8"),"status":change_status(status),"rawStatus":status.decode("ascii"),"untracked":False} for status, path in selected_tracked]
            files += [{"path":path.decode("utf-8"),"status":"untracked","rawStatus":"?","untracked":True} for path in selected_untracked]
        except UnicodeDecodeError: fail("repository contains a non-UTF-8 path")
        entry_count = len(selected_tracked) + len(selected_untracked)
        entry_limited = entry_count >= 200 and entry_count < len(tracked_pairs) + len(untracked_tokens)
        byte_limited = tracked[4] or untracked[4] or (not entry_limited and (len(selected_tracked) < len(tracked_pairs) or len(selected_untracked) < len(untracked_tokens)))
        inventory_truncated = entry_limited or byte_limited
        stdout = b""
        stderr = tracked[1] + untracked[1]
        result = (stdout, stderr[:max_bytes], tracked[2] or untracked[2], tracked[3] or untracked[3], tracked[4] or untracked[4] or len(stderr) > max_bytes or inventory_truncated)
        kind = "git"
    elif operation == "diff":
        if not requested_path: fail("diff requires path")
        attributes = run(common + ["check-attr", "-z", "filter", "--", requested_path])
        if attributes[2] != 0 or attributes[3]: fail("unable to inspect repository attributes")
        attribute_parts = attributes[0].split(b"\0")
        if len(attribute_parts) < 4 or attribute_parts[1] != b"filter": fail("invalid repository attributes")
        if attribute_parts[2] not in (b"unspecified", b"unset"): fail("external content filters are unsupported")
        result = run(common + ["diff", "--no-renames", "--no-ext-diff", "--no-textconv", "--no-color", "--submodule=short", baseline, "--", requested_path])
        binary_probe = run(common + ["diff", "--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", baseline, "--", requested_path])
        binary = binary_probe[0].startswith(b"-\t-\t")
        kind = "git"
    elif operation == "read":
        if not path_parts: fail("read requires path")
        parent_fd = os.dup(repo_fd)
        try:
            for part in path_parts[:-1]:
                next_fd = os.open(part, flags, dir_fd=parent_fd)
                os.close(parent_fd); parent_fd = next_fd
            leaf = path_parts[-1]
            try:
                file_fd = os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent_fd)
            except OSError as error:
                if error.errno != errno.ELOOP: raise
                target = os.readlink(leaf, dir_fd=parent_fd).encode("utf-8", "surrogateescape")
                result = (target[:max_bytes], b"", 0, False, len(target) > max_bytes)
                kind = "symlink"
            else:
                try:
                    file_stat = os.fstat(file_fd)
                    if not stat.S_ISREG(file_stat.st_mode): fail("path is not a regular file")
                    data = os.read(file_fd, max_bytes + 1)
                    try: data.decode("utf-8")
                    except UnicodeDecodeError: binary = True
                    else: binary = b"\0" in data
                    result = (b"" if binary else data[:max_bytes], b"", 0, False, len(data) > max_bytes)
                    kind = "file"
                finally: os.close(file_fd)
        finally: os.close(parent_fd)
    else: fail("invalid operation")
    truncation_reasons = []
    if result[3]: truncation_reasons.append("timeout")
    if result[4]: truncation_reasons.append("byte_limit")
    response = {"kind":kind,"currentSha":current_sha,"dataBase64":base64.b64encode(result[0]).decode(),"stderrBase64":base64.b64encode(result[1]).decode(),"exitCode":result[2],"timedOut":result[3],"truncated":result[3] or result[4],"truncationReasons":truncation_reasons}
    if operation == "status":
        reasons = (["entry_limit"] if entry_limited else []) + (["byte_limit"] if byte_limited else []) + (["timeout"] if result[3] else [])
        response.update({"files":files,"entryCount":entry_count,"truncationReasons":reasons})
    elif operation == "diff":
        response.update({"binary":binary,"skipReason":"binary" if binary else ("command_failed" if result[2] != 0 else None)})
    elif operation == "read" and kind == "file":
        response.update({"binary":binary,"size":file_stat.st_size})
    print(json.dumps(response, separators=(",", ":")))
finally:
    if fd >= 0: os.close(fd)
    if 'git_fd' in locals(): os.close(git_fd)
    if 'repo_fd' in locals(): os.close(repo_fd)
`;

function boundedMaxBytes(value: number | undefined): number {
	if (value === undefined) return MAX_DIFF_BYTES;
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new Error("Repository inspection maxBytes is invalid");
	}
	return value;
}

export async function inspectRepositoryNative(
	exec: RepositoryInspectionExecutor,
	request: RepositoryInspectionRequest,
	root = REPOSITORY_ROOT,
): Promise<RepositoryInspectionResult> {
	const deadline = Date.now() + HELPER_TIMEOUT_MS;
	const maxBytes = boundedMaxBytes(request.maxBytes);
	const operationLimit =
		request.operation === "diff"
			? MAX_DIFF_BYTES
			: request.operation === "read"
				? MAX_FILE_BYTES
				: MAX_STATUS_BYTES;
	const effectiveMaxBytes = Math.min(maxBytes, operationLimit);
	const processPromise = exec(
		[
			"python3",
			"-I",
			"-c",
			PYTHON_HELPER,
			root,
			request.repositoryPath,
			request.operation,
			request.baselineSha,
			request.path ?? "",
			String(effectiveMaxBytes),
		],
		{ timeout: HELPER_TIMEOUT_MS },
	);
	let process: NativeProcess;
	try {
		process = await beforeDeadline(processPromise, deadline);
	} catch (error) {
		void processPromise.then((late) => late.kill(9)).catch(() => undefined);
		throw error;
	}
	let output;
	try {
		output = await beforeDeadline(
			process.output({
				encoding: "utf8",
				maxBytes: effectiveMaxBytes * 3 + 16 * 1024,
				timeout: HELPER_TIMEOUT_MS,
			}),
			deadline,
		);
	} catch (error) {
		await boundedCleanup(() => process.kill(9));
		throw error;
	}
	if (output.truncated)
		throw new Error("Repository inspection logs were truncated");
	const { exitCode, stdout } = output;
	if (exitCode !== 0 && stdout.trim() === "") {
		throw new Error("Repository inspection failed");
	}
	let parsed: (RepositoryInspectionResult & { error?: string }) | undefined;
	try {
		parsed = JSON.parse(stdout) as RepositoryInspectionResult & {
			error?: string;
		};
	} catch {
		throw new Error("Repository inspection returned an invalid envelope");
	}
	if (exitCode !== 0 || parsed.error) {
		throw new Error(parsed.error ?? "Repository inspection failed");
	}
	if (request.operation === "diff" && !parsed.binary) {
		let raw: string;
		try {
			raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
				Uint8Array.from(atob(parsed.dataBase64), (character) =>
					character.charCodeAt(0),
				),
			);
		} catch {
			parsed.skipReason = "invalid_utf8";
			return parsed;
		}
		const structured = parseUnifiedDiff(raw);
		parsed.hunks = structured.hunks;
		for (const reason of structured.truncationReasons)
			if (!parsed.truncationReasons.includes(reason))
				parsed.truncationReasons.push(reason);
		if (structured.truncationReasons.length > 0) parsed.truncated = true;
	}
	return parsed;
}
