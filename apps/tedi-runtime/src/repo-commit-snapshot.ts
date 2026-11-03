import { sha256Hex } from "@tedix/worker-kit/crypto";
import type { RepoCommitExactTreeValidation } from "@tedix/api-contract/schemas/repo-commit-write";
import type { ComputerWorkspaceScope } from "./computer-workspace-scope";

const REPO_SNAPSHOT_LIMITS = {
	paths: 40,
	depth: 32,
	fileBytes: 65536,
	selectedBytes: 1048576,
} as const;
export interface RepoSnapshotInput {
	owner: string;
	repo: string;
	baseSha: string;
	sourceScope?: ComputerWorkspaceScope;
	changes: Array<{ path: string; content: string | null }>;
}
export interface RepoSnapshotManifest {
	version: "v1";
	owner: string;
	repo: string;
	baseSha: string;
	orderedChangesDigest: string;
	files: Array<{ path: string; digest: string | null; bytes: number }>;
}
export async function repoSnapshotManifest(
	input: RepoSnapshotInput,
): Promise<RepoSnapshotManifest> {
	if (
		!/^[a-f0-9]{40}$/.test(input.baseSha) ||
		!/^[A-Za-z0-9_.-]+$/.test(input.owner) ||
		!/^[A-Za-z0-9_.-]+$/.test(input.repo)
	)
		throw new Error("invalid_snapshot_repository");
	if (
		!input.changes.length ||
		input.changes.length > REPO_SNAPSHOT_LIMITS.paths
	)
		throw new Error("snapshot_path_limit");
	const seen = new Set<string>();
	let bytes = 0;
	const files = [];
	for (const c of input.changes) {
		const parts = c.path.split("/");
		if (
			c.path.length > 1024 ||
			parts.length > REPO_SNAPSHOT_LIMITS.depth ||
			parts.some((p) => !p || p === "." || p === ".." || p === ".git") ||
			c.path.includes("\\") ||
			Array.from(c.path).some((character) => character.charCodeAt(0) < 32) ||
			c.path.startsWith("-") ||
			seen.has(c.path)
		)
			throw new Error("invalid_snapshot_path");
		seen.add(c.path);
		if (c.content !== null && c.content.length > REPO_SNAPSHOT_LIMITS.fileBytes)
			throw new Error("snapshot_content_limit");
		if (c.content !== null && !c.content.isWellFormed())
			throw new Error("invalid_snapshot_utf8");
		const size =
			c.content === null ? 0 : new TextEncoder().encode(c.content).byteLength;
		bytes += size;
		if (
			size > REPO_SNAPSHOT_LIMITS.fileBytes ||
			bytes > REPO_SNAPSHOT_LIMITS.selectedBytes
		)
			throw new Error("snapshot_content_limit");
		files.push({
			path: c.path,
			digest: c.content === null ? null : await sha256Hex(c.content),
			bytes: size,
		});
	}
	return {
		version: "v1",
		owner: input.owner,
		repo: input.repo,
		baseSha: input.baseSha,
		orderedChangesDigest: await sha256Hex(JSON.stringify(files)),
		files,
	};
}

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

// Runs inside the already authorized native process. It never obtains credentials,
// fetches, installs, or moves a remote ref. Native Git owns only temporary objects.
export const REPO_SNAPSHOT_SCRIPT = String.raw`
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), cp = require("node:child_process"), crypto = require("node:crypto");
const i = JSON.parse(process.argv[1]), source = fs.realpathSync(process.cwd()), started = Date.now();
const digest = b => crypto.createHash("sha256").update(b).digest("hex");
const gitEnv = {...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))), GIT_CONFIG_NOSYSTEM:"1", GIT_CONFIG_GLOBAL:"/dev/null", GIT_CONFIG_COUNT:"0", GIT_ATTR_NOSYSTEM:"1", GIT_TERMINAL_PROMPT:"0"};
let temporary, checkout, sourceFd;
function refuse(message) { throw new Error(message); }
function run(command, args, options = {}) {
 const r = cp.spawnSync(command, args, {cwd: source, env:gitEnv, encoding: "utf8", timeout: Math.max(1, Math.min(30000, started + 360000 - Date.now())), maxBuffer: 4194304, ...options});
 if (r.error || r.signal || r.status !== 0) refuse("snapshot_command_failed");
 return r.stdout;
}
function git(args, options) { const cwd=options?.cwd || source; return run("git", ["-c","safe.directory="+cwd,"-c","core.worktree="+cwd,"-c","core.hooksPath=/dev/null",...args], options); }
function within(p, root) { return p === root || p.startsWith(root + path.sep); }
function fdPath(fd) {
 if (process.platform !== "linux") refuse("snapshot_directory_anchor_unavailable");
 const p = "/proc/self/fd/" + fd;
 if (!fs.statSync(p).isDirectory()) refuse("snapshot_directory_anchor_unavailable");
 return p;
}
function pinnedDirectory(relative, root = sourceFd) {
 let parent = root, owned = false;
 try {
  for (const component of relative.split(path.sep).filter(Boolean)) {
   if (component === "." || component === "..") refuse("snapshot_invalid_directory");
   const next = fs.openSync(path.join(fdPath(parent),component),fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
   if (owned) fs.closeSync(parent);
   parent = next; owned = true;
  }
  return parent;
 } catch (e) { if (owned) fs.closeSync(parent); throw e; }
}
try {
 sourceFd = fs.openSync(".",fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
 fdPath(sourceFd);
 if (i.version !== "v1" || !/^[a-f0-9]{40}$/.test(i.baseSha) || i.files.length > 40) refuse("invalid_snapshot_manifest");
 if (digest(JSON.stringify(i.files)) !== i.orderedChangesDigest) refuse("snapshot_manifest_mismatch");
 const origin = new URL(git(["config", "--get", "remote.origin.url"]).trim());
 if (origin.protocol !== "https:" || origin.hostname !== "github.com" || origin.username || origin.password || origin.search || origin.hash || origin.port || origin.pathname.replace(/\.git$/, "").toLowerCase() !== ("/" + i.owner + "/" + i.repo).toLowerCase()) refuse("snapshot_origin_mismatch");
 if (git(["rev-parse", "HEAD"]).trim() !== i.baseSha) refuse("snapshot_base_mismatch");
 const baseEntries = git(["ls-tree", "-rlz", i.baseSha]).split("\0").filter(Boolean);
 if (baseEntries.length > 12000) refuse("snapshot_tree_entry_limit");
 let baseBytes = 0;
 for (const entry of baseEntries) {
  const m = /^(\d+) (\w+) ([a-f0-9]{40})\s+([0-9-]+)\t/.exec(entry);
  if (!m || m[2] !== "blob") refuse("snapshot_unsupported_tree_entry");
  const size = Number(m[4]); baseBytes += size;
  if (!Number.isSafeInteger(size) || size > 8388608 || baseBytes > 1073741824) refuse("snapshot_tree_byte_limit");
 }
 temporary = fs.mkdtempSync(path.join(os.tmpdir(), "tedix-exact-tree-"));
 const index = path.join(temporary, "index"), env = {...gitEnv, GIT_INDEX_FILE: index};
 git(["read-tree", i.baseSha], {env});
 for (const f of i.files) {
  const components = f.path.split("/");
  if (components.length > 32 || components.some(p => !p || p === "." || p === ".." || p === ".git") || f.path.length > 1024 || /[\x00-\x1f\\]/.test(f.path)) refuse("invalid_snapshot_path");
  if (f.path.startsWith("scripts/") || /(^|\/)(package\.json|bun\.lock|bun\.lockb)$/.test(f.path)) refuse("snapshot_recipe_change_requires_review");
  if (f.digest === null) { git(["update-index", "--force-remove", "--", f.path], {env}); continue; }
  const parentPath=path.dirname(f.path), parentFd=pinnedDirectory(parentPath === "." ? "" : parentPath);
  let fd;
  let bytes;
  try {
   const filename = path.join(fdPath(parentFd),path.basename(f.path));
   fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
   const before = fs.fstatSync(fd), buffer = Buffer.alloc(65537); let size = 0, read;
   if (!before.isFile() || before.size > 65536) refuse("snapshot_source_unavailable");
   while (size < buffer.length && (read = fs.readSync(fd, buffer, size, buffer.length - size, null)) > 0) size += read;
   const after = fs.fstatSync(fd);
   if (size > 65536 || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) refuse("snapshot_source_mismatch");
   bytes = buffer.subarray(0,size);
  } finally { if(fd !== undefined)fs.closeSync(fd); if(parentFd !== sourceFd)fs.closeSync(parentFd); }
  if (bytes.length !== f.bytes || digest(bytes) !== f.digest) refuse("snapshot_source_mismatch");
  const oid = git(["hash-object", "-w", "--stdin"], {input: bytes}).trim();
  git(["update-index", "--add", "--cacheinfo", "100644," + oid + "," + f.path], {env});
 }
 const tree = git(["write-tree"], {env}).trim();
 const entries = git(["ls-tree", "-rlz", tree]).split("\0").filter(Boolean);
 if (entries.length > 12000) refuse("snapshot_tree_entry_limit");
 let total = 0; const links = new Map();
 for (const entry of entries) {
  const m = /^(\d+) (\w+) ([a-f0-9]{40})\s+([0-9-]+)\t([\s\S]+)$/.exec(entry);
  if (!m || m[2] !== "blob") refuse("snapshot_unsupported_tree_entry");
  const size = Number(m[4]); total += size;
  if (!Number.isSafeInteger(size) || size > 8388608 || total > 1073741824) refuse("snapshot_tree_byte_limit");
  if (m[1] === "120000") {
   const target = git(["cat-file", "blob", m[3]]);
   if (path.posix.isAbsolute(target) || target.includes("\0")) refuse("snapshot_symlink_escape");
   links.set(m[5], target);
  }
 }
 function resolveComponents(parts, allLinks) {
  const done = []; let remaining = [...parts], expansions = 0;
  while (remaining.length) {
   const part = remaining.shift();
   if (!part || part === ".") continue;
   if (part === "..") { if (!done.length) refuse("snapshot_symlink_escape"); done.pop(); continue; }
   const candidate = [...done, part].join("/");
   if (allLinks.has(candidate)) {
    if (++expansions > 32) refuse("snapshot_symlink_cycle");
    remaining = [...allLinks.get(candidate).split("/"), ...remaining];
   } else done.push(part);
  }
 }
 for (const p of links.keys()) resolveComponents(p.split("/"), links);
 if (Date.now() - started > 30000) refuse("snapshot_preparation_timeout");
 const commitEnv = {...gitEnv, GIT_AUTHOR_NAME: "Tedix check", GIT_AUTHOR_EMAIL: "check@example.invalid", GIT_COMMITTER_NAME: "Tedix check", GIT_COMMITTER_EMAIL: "check@example.invalid", GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z"};
 const commit = git(["commit-tree", tree, "-p", i.baseSha], {env: commitEnv, input: "Isolated repository validation\n"}).trim();
 checkout = path.join(temporary, "checkout");
 git(["-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", checkout, commit]);
 function verifyRawTree() {
  const root = fs.openSync(checkout,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
  try { for (const entry of entries) {
   if (Date.now()-started>330000)refuse("snapshot_verification_timeout");
   const m=/^(\d+) (\w+) ([a-f0-9]{40})\s+([0-9-]+)\t([\s\S]+)$/.exec(entry), size=Number(m[4]), relative=m[5], dirname=path.dirname(relative);
   const parent=pinnedDirectory(dirname === "." ? "" : dirname,root);
   try {
    const filename=path.join(fdPath(parent),path.basename(relative)), stat=fs.lstatSync(filename), hash=crypto.createHash("sha1").update("blob "+size+"\0");
    if (m[1] === "120000") {
     if(!stat.isSymbolicLink())refuse("snapshot_raw_tree_mismatch");
     const target=fs.readlinkSync(filename,{encoding:"buffer"});if(target.length!==size)refuse("snapshot_raw_tree_mismatch");hash.update(target);
    } else {
     if(!stat.isFile()||stat.size!==size||((stat.mode&73)!==0)!==(m[1]==="100755"))refuse("snapshot_raw_tree_mismatch");
     const fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
     try {
      const before=fs.fstatSync(fd),buffer=Buffer.alloc(65536);let total=0,read;
      if(before.ino!==stat.ino||before.dev!==stat.dev||before.size!==size)refuse("snapshot_raw_tree_mismatch");
      while((read=fs.readSync(fd,buffer,0,buffer.length,null))>0){total+=read;if(total>size)refuse("snapshot_raw_tree_mismatch");hash.update(buffer.subarray(0,read));}
      const after=fs.fstatSync(fd);if(total!==size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)refuse("snapshot_raw_tree_mismatch");
     }finally{fs.closeSync(fd);}
    }
    if(hash.digest("hex")!==m[3])refuse("snapshot_raw_tree_mismatch");
   }finally{if(parent!==root)fs.closeSync(parent);}
  }}finally{fs.closeSync(root);}
 }
 verifyRawTree();
 // No symlink to source node_modules: workspace package links would lead back
 // to mutable source. Bound each read/write while copying, including growth.
 const dependencySource = path.join(source, "node_modules"), dependencies = crypto.createHash("sha256");
 if (fs.existsSync(path.join(checkout, "package.json"))) {
  if (!fs.existsSync(dependencySource)) refuse("snapshot_dependencies_unavailable");
  let count = 0, bytes = total;
  const dependencyLinks = new Map(links);
  function copyDependencies(dir, dest, relative = path.relative(source,dir)) {
   if (Date.now() - started > 30000) refuse("snapshot_preparation_timeout");
   const dirFd = pinnedDirectory(relative), anchored = fdPath(dirFd);
   if (fs.existsSync(dest)) {fs.closeSync(dirFd);refuse("snapshot_dependency_destination_exists");}
   fs.mkdirSync(dest, {recursive: true});
   const directory = fs.opendirSync(anchored);
   try { let ent;
   while ((ent = directory.readSync()) !== null) {
    if (Date.now() - started > 30000) refuse("snapshot_preparation_timeout");
    if (++count > 120000) refuse("snapshot_dependency_entry_limit");
    const p = path.join(anchored, ent.name), logical = path.join(relative,ent.name), out = path.join(dest, ent.name), stat = fs.lstatSync(p);
    if (stat.isSymbolicLink()) {
     const target = fs.readlinkSync(p), resolved = path.resolve(checkout, path.dirname(logical), target);
     if (path.isAbsolute(target) || !within(resolved, checkout)) refuse("snapshot_dependency_link_escape");
     dependencyLinks.set(logical.split(path.sep).join("/"), target);
     dependencies.update(JSON.stringify([logical, "link", target]) + "\n");
     fs.symlinkSync(target, out);
    } else if (stat.isDirectory()) copyDependencies(p, out, logical);
    else if (stat.isFile()) {
     if (stat.size + bytes > 1073741824) refuse("snapshot_dependency_byte_limit");
     const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW), output = fs.openSync(out, "wx", stat.mode & 511);
     try {
      const before = fs.fstatSync(fd);
      if (!before.isFile() || before.ino !== stat.ino || before.dev !== stat.dev) refuse("snapshot_dependency_changed");
      const buffer = Buffer.alloc(65536), fileHash = crypto.createHash("sha256"); let size = 0, read;
      while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
       if (Date.now() - started > 30000) refuse("snapshot_preparation_timeout");
       bytes += read; size += read;
       if (bytes > 1073741824 || size > before.size) refuse("snapshot_dependency_byte_limit");
       fs.writeSync(output, buffer, 0, read);
       fileHash.update(buffer.subarray(0,read));
      }
      const after = fs.fstatSync(fd);
      if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) refuse("snapshot_dependency_changed");
      dependencies.update(JSON.stringify([logical, "file", before.mode & 511, fileHash.digest("hex")]) + "\n");
     } finally { fs.closeSync(fd); fs.closeSync(output); }
    }
    else refuse("snapshot_dependency_entry_type");
   }
   } finally { directory.closeSync(); fs.closeSync(dirFd); }
  }
  copyDependencies(dependencySource, path.join(checkout, "node_modules"));
  for (const entry of entries) {
   const file = entry.slice(entry.indexOf("\t") + 1);
   if (!file.endsWith("/package.json")) continue;
   const relative = path.posix.join(path.posix.dirname(file), "node_modules");
   if (fs.existsSync(path.join(source,relative))) copyDependencies(path.join(source,relative),path.join(checkout,relative));
  }
  for (const p of dependencyLinks.keys()) resolveComponents(p.split("/"), dependencyLinks);
 }
 if (Date.now() - started > 30000) refuse("snapshot_preparation_timeout");
 const recipe = digest(JSON.stringify(["v1", i.baseSha, tree, "full", "bun scripts/ci/preflight-gates.mjs --files", i.files.map(f => f.path), dependencies.digest("hex")]));
 const gate = cp.spawnSync("bun", ["scripts/ci/preflight-gates.mjs", "--files", ...i.files.map(f => f.path)], {cwd: checkout, encoding: "utf8", timeout: Math.max(1,Math.min(300000, started + 330000 - Date.now())), maxBuffer: 4194304, env: {...gitEnv, TEDIX_PUSH_TRAIN_RANGES:"[]"}});
 const output = (gate.stdout || "") + (gate.stderr || "");
 process.stdout.write(output);
 if (gate.error || gate.signal || gate.status !== 0 || /skipped \(tool missing\)|skipped .+: tool missing|skipped \(script missing\)/.test(output)) refuse("snapshot_gate_not_complete");
 verifyRawTree();
 if (git(["rev-parse", "HEAD^{tree}"], {cwd: checkout}).trim() !== tree) refuse("snapshot_changed_during_gate");
 console.log("\nTEDIX_EXACT_TREE " + JSON.stringify({version: "v1", baseSha: i.baseSha, resultTreeSha: tree, orderedChangesDigest: i.orderedChangesDigest, gateRecipeDigest: recipe}));
} catch (e) {
 console.error("exact_tree_check_refused:" + e.message); process.exitCode = 1;
} finally {
 if (sourceFd !== undefined) fs.closeSync(sourceFd);
 if (checkout) { try { git(["worktree", "remove", "--force", checkout]); } catch { process.exitCode = 1; } }
 if (temporary) fs.rmSync(temporary, {recursive: true, force: true});
}
`;

export function repoSnapshotCommand(manifest: RepoSnapshotManifest): string {
	const payload = JSON.stringify(manifest);
	if (new TextEncoder().encode(payload).byteLength > 65536)
		throw new Error("snapshot_manifest_byte_limit");
	return `bun -e ${quote(REPO_SNAPSHOT_SCRIPT)} ${quote(payload)}`;
}

export function readRepoSnapshotResult(
	stdout: string,
	manifest: RepoSnapshotManifest,
): Omit<
	RepoCommitExactTreeValidation,
	"processId" | "terminalEvidenceRef" | "exitCode"
> | null {
	const line = stdout.trimEnd().split("\n").at(-1);
	if (!line?.startsWith("TEDIX_EXACT_TREE ")) return null;
	try {
		const result = JSON.parse(line.slice(17));
		if (
			result.version !== "v1" ||
			result.baseSha !== manifest.baseSha ||
			result.orderedChangesDigest !== manifest.orderedChangesDigest ||
			!/^[a-f0-9]{40}$/.test(result.resultTreeSha) ||
			!/^[a-f0-9]{64}$/.test(result.gateRecipeDigest)
		)
			return null;
		return result;
	} catch {
		return null;
	}
}
