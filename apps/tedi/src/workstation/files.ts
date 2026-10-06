import { WorkstationDispatchUnknownError } from "./computer-body";
import type { WorkstationRuntimeBody } from "./computer-body";
import { WORKSTATION_DIR } from "./paths";
export const COMPUTER_FILE_OPERATIONS = [
	"read",
	"read_file",
	"write",
	"reversible_write",
	"guarded_restore",
	"edit",
	"delete",
	"ls",
	"find",
	"grep",
] as const;
type FilesSandbox = Pick<
	WorkstationRuntimeBody,
	"exec" | "writeFile" | "deleteFile"
>;
const MAX_BYTES = 262144;
const encode = (value: string) => new TextEncoder().encode(value);
const FILE_SCRIPT = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const input = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
fs.unlinkSync(process.argv[1]);
const root = input.root;
const realRoot = fs.realpathSync(root);
const maxBytes = 262144;
const bounded = (value, fallback, min, max) => { const n = value === undefined ? fallback : value; if (!Number.isInteger(n) || n < min || n > max) throw Error('Invalid pagination'); return n; };
function checked(p) {
 const resolved = path.resolve(p);
 if (resolved !== root && !resolved.startsWith(root + '/')) throw Error('Path is outside computer root');
 const exists = p => { try { fs.lstatSync(p); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
 let existing = resolved;
 while (!exists(existing)) { const parent = path.dirname(existing); if (parent === existing) throw Error('Missing root'); existing = parent; }
 const real = fs.realpathSync(existing);
 if (real !== realRoot && !real.startsWith(realRoot + '/')) throw Error('Symlink escapes computer root');
 return resolved;
}
function glob(pattern) {
 let expression = '^';
 for (let i = 0; i < pattern.length; i++) {
  const char = pattern[i];
  if (char === '*' && pattern[i + 1] === '*') {
   i++;
   if (pattern[i + 1] === '/') { i++; expression += '(?:.*/)?'; } else expression += '.*';
  } else if (char === '*') expression += '[^/]*';
  else if (char === '?') expression += '[^/]';
  else expression += char.replace(/[.*+?^\x24{}()|[\]\\]/g, '\\$&');
 }
 return new RegExp(expression + '$');
}
function *lines(p, start = 0) {
 const fd = fs.openSync(p, 'r');
 const chunk = Buffer.alloc(16384);
 let position = start, lineStart = start, parts = [], length = 0;
 try {
  while (true) {
   const size = fs.readSync(fd, chunk, 0, chunk.length, position);
   if (!size) break;
   let cursor = 0;
   while (cursor < size) {
    const newline = chunk.indexOf(10, cursor);
    const end = newline < 0 || newline >= size ? size : newline;
    const part = chunk.subarray(cursor, end);
    length += part.length;
    if (length <= maxBytes) parts.push(Buffer.from(part));
    if (end === size) break;
    yield { text: length > maxBytes ? null : Buffer.concat(parts).toString('utf8'), start: lineStart, next: position + end + 1 };
    parts = []; length = 0; lineStart = position + end + 1; cursor = end + 1;
   }
   position += size;
  }
  if (length) yield { text: length > maxBytes ? null : Buffer.concat(parts).toString('utf8'), start: lineStart, next: position };
 } finally { fs.closeSync(fd); }
}
try {
 const p = checked(input.path || root);
 const originalOperation = input.operation;
 let receipt;
 if (input.operation === 'reversible_write') {
  if (typeof input.content !== 'string' || input.content.length > 250000 || Buffer.byteLength(input.content) > maxBytes) throw Error('Invalid reversible write content');
  if (fs.existsSync(p) && fs.statSync(p).size > maxBytes) throw Error('Existing file exceeds reversible write limit');
  const previousContent = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  if (previousContent !== null && previousContent.length > 250000) throw Error('Existing file exceeds reversible write limit');
  receipt = { previousContent };
  if (Buffer.byteLength(JSON.stringify({ok:true,operation:originalOperation,path:p,bytes:Buffer.byteLength(input.content),...receipt})) > maxBytes) throw Error('Reversible write receipt exceeds file-tool output limit');
  input.operation = 'write';
 } else if (input.operation === 'guarded_restore') {
  if (typeof input.expectedContent !== 'string' || input.expectedContent.length > 250000 || Buffer.byteLength(input.expectedContent) > maxBytes ||
      (input.previousContent !== null && (typeof input.previousContent !== 'string' || input.previousContent.length > 250000 || Buffer.byteLength(input.previousContent) > maxBytes))) throw Error('Invalid reversible workspace receipt');
  if (fs.existsSync(p) && fs.statSync(p).size > maxBytes) throw Error('workspace_rollback_conflict: file changed after the approved write');
  const current = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  if (current !== input.expectedContent) throw Error('workspace_rollback_conflict: file changed after the approved write');
  input.operation = input.previousContent === null ? 'delete' : 'write';
  input.content = input.previousContent;
 }
 let result = {};
 if(input.operation==='find'||input.operation==='grep') {
  const limit = bounded(input.limit,200,1,1000), offset = bounded(input.offset,0,0,Number.MAX_SAFE_INTEGER);
  const context = bounded(input.context,0,0,10);
  const matches = []; let visited = 0, seen = 0, truncated = false, scanLimited = false;
  const excludes = input.exclude === undefined ? [] : input.exclude;
  if (!Array.isArray(excludes) || excludes.some(e => typeof e !== 'string')) throw Error('exclude must be glob strings');
  const excluded = excludes.map(glob), include = input.include ? glob(input.include) : null;
  const pattern = input.operation === 'find' ? glob(input.pattern || '**') : null;
  if (input.operation === 'grep' && typeof input.query !== 'string') throw Error('query is required');
  const query = input.regex ? new RegExp(input.query,input.ignoreCase ? 'i' : '') : null;
  const isMatch = text => query ? query.test(text) : (input.ignoreCase ? text.toLowerCase().includes(input.query.toLowerCase()) : text.includes(input.query));
  function accept(match) { if (seen++ < offset) return; if (matches.length === limit) { truncated = true; return; } matches.push(match); }
  function scan(full) {
   const previous = [], pending = [];
   let lineNumber = 0;
   for (const entry of lines(full)) {
    lineNumber++;
    if (entry.text === null) { scanLimited = true; continue; }
    const line = { line: lineNumber, text: entry.text, isMatch: isMatch(entry.text) };
    for (const match of pending) if (lineNumber <= match.line + context) match.context.push(line);
    while (pending.length && lineNumber >= pending[0].line + context) pending.shift();
    if (line.isMatch && !truncated) {
     const match = { path: full, line: lineNumber, text: entry.text };
     if (context) match.context = [...previous, line];
     const count = matches.length; accept(match);
     if (context && matches.length > count) pending.push(match);
    }
    previous.push(line); if (previous.length > context) previous.shift();
    if (truncated && !pending.length) break;
   }
  }
  function walk(dir) {
   for (const entry of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
    if (truncated) return;
    if (++visited > 10000) { scanLimited = true; return; }
    const full = path.join(dir,entry.name), relative = path.relative(p,full);
    if (excluded.some(g=>g.test(relative) || (entry.isDirectory() && g.test(relative + '/')))) continue;
    if (entry.isSymbolicLink()) continue;
    if (pattern && pattern.test(relative)) accept({path:full,type:entry.isDirectory()?'dir':'file'});
    if (entry.isDirectory()) { walk(full); continue; }
    if (input.operation === 'grep' && (!include || include.test(relative))) scan(full);
   }
  }
  if (fs.statSync(p).isDirectory()) walk(p);
  else if (input.operation === 'grep') scan(p);
  else throw Error('Find path must be a directory');
  result = input.operation === 'find' ? {pattern:input.pattern,count:matches.length,entries:matches} : {query:input.query,count:matches.length,matches};
  if (truncated) result.nextOffset = offset + matches.length;
  result.truncated = truncated || scanLimited;
  if (scanLimited) result.scanLimited = true;
 } else if(input.operation==='delete'){if(p===root)throw Error('Cannot delete computer root');fs.rmSync(p,{recursive:input.recursive===true});result={deleted:true}; } else if(input.operation==='read_file') {
  if (!fs.existsSync(p)) result={content:null};
  else { if(fs.statSync(p).size>maxBytes)throw Error('File exceeds 256 KiB file-tool limit; use exec for streaming');const bytes=fs.readFileSync(p);if(bytes.length>maxBytes)throw Error('File exceeds 256 KiB file-tool limit');result={content:bytes.toString('utf8')}; }
 } else if(input.operation==='read') {
  const offset=bounded(input.offset,1,1,Number.MAX_SAFE_INTEGER), byteOffset=bounded(input.byteOffset,0,0,Number.MAX_SAFE_INTEGER), limit=Math.min(bounded(input.limit,2000,1,Number.MAX_SAFE_INTEGER),2000);
  if(byteOffset>0&&input.offset===undefined)throw Error('offset is required when byteOffset is greater than zero');
  const size=fs.statSync(p).size;if(byteOffset>0&&byteOffset>=size)throw Error('Byte continuation is beyond end of file');
  const content=[];let current=byteOffset>0?offset:1,bytes=0,truncated=false,nextByteOffset;
  for(const line of lines(p,byteOffset)) {if(current<offset){current++;continue;}if(content.length>=limit){truncated=true;nextByteOffset=line.start;break;}if(line.text===null)throw Error('Line exceeds the 256 KiB read cap; use exec for streaming');const length=Buffer.byteLength(line.text)+(content.length?1:0);if(bytes+length>maxBytes-4096){if(!content.length)throw Error('Line exceeds the bounded read output');truncated=true;nextByteOffset=line.start;break;}content.push(line.text);bytes+=length;current++;}
  if(!content.length&&size>0&&offset>current-1)throw Error('Line offset is beyond end of file');
  result={content:content.join('\n'),startLine:size===0?1:offset,endLine:size===0?0:offset+content.length-1,totalLines:truncated?null:current-1,truncated,...(truncated?{nextOffset:offset+content.length,nextByteOffset}:{})};
 } else if(input.operation==='write'||input.operation==='edit') {
  let content;
  if(input.operation==='write'){if(typeof input.content!=='string'||Buffer.byteLength(input.content)>maxBytes)throw Error('content must be text within 256 KiB');content=input.content;result={bytes:Buffer.byteLength(content)};}
  else {if(fs.statSync(p).size>maxBytes)throw Error('File exceeds 256 KiB file-tool limit; use exec for streaming');const original=fs.readFileSync(p,'utf8');if(Buffer.byteLength(original)>maxBytes)throw Error('File exceeds 256 KiB file-tool limit');if(!Array.isArray(input.edits)||!input.edits.length)throw Error('edits must be nonempty');const edits=input.edits.map(e=>{if(!e||typeof e.oldText!=='string'||!e.oldText||typeof e.newText!=='string')throw Error('Invalid edit');const start=original.indexOf(e.oldText);if(start<0||original.indexOf(e.oldText,start+1)>=0)throw Error('Edit text must match exactly once');return {start,end:start+e.oldText.length,text:e.newText};}).sort((a,b)=>a.start-b.start);for(let i=1;i<edits.length;i++)if(edits[i].start<edits[i-1].end)throw Error('Edits overlap');content=original;for(const e of edits.reverse())content=content.slice(0,e.start)+e.text+content.slice(e.end);if(Buffer.byteLength(content)>maxBytes)throw Error('Edited file exceeds 256 KiB');result={edits:edits.length};}
  let ancestor=p;while(!fs.existsSync(ancestor))ancestor=path.dirname(ancestor);const nativePath=path.join(fs.realpathSync(ancestor),path.relative(ancestor,p));
  const mode=fs.existsSync(nativePath)?fs.statSync(nativePath).mode&511:null,parent=path.dirname(nativePath),temporary=path.join(parent,'.tedix-file-'+require('node:crypto').randomUUID());fs.mkdirSync(parent,{recursive:true});
  try {fs.writeFileSync(temporary,content,{flag:'wx'});if(mode!==null)fs.chmodSync(temporary,mode);fs.renameSync(temporary,nativePath);}finally{fs.rmSync(temporary,{force:true});}
 } else if(input.operation==='ls') {
  const entries=fs.readdirSync(p).sort((a,b)=>a.localeCompare(b)),offset=bounded(input.offset,0,0,1000000),limit=bounded(input.limit,200,1,1000);
  const page=entries.slice(offset,offset+limit).map(name=>{const st=fs.lstatSync(path.join(p,name));return {name,size:st.size,mtime:st.mtimeMs,isFile:st.isFile(),isDirectory:st.isDirectory(),isSymbolicLink:st.isSymbolicLink()};});const truncated=offset+limit<entries.length;result={entries:page,count:page.length,truncated,...(truncated?{nextOffset:offset+limit}:{})};
 } else throw Error('Invalid file operation');
 const output={ok:true,operation:originalOperation,path:p,...result,...receipt};const encoded=JSON.stringify(output);if(Buffer.byteLength(encoded)>maxBytes)throw Error('Result exceeds 256 KiB; narrow the operation');process.stdout.write(encoded);
} catch(error) { process.stdout.write(JSON.stringify({ok:false,error:error.message}));process.exitCode=1; }
`;

async function runJson(
	sandbox: FilesSandbox,
	script: string,
	input: Record<string, unknown>,
	execute?: (argv: readonly [string, ...string[]]) => Promise<{
		id: string;
		process: Awaited<ReturnType<FilesSandbox["exec"]>>;
	}>,
): Promise<Record<string, unknown>> {
	const request = JSON.stringify({ ...input, root: WORKSTATION_DIR });
	if (encode(request).length > 524288)
		throw Error("File request exceeds 512 KiB");
	const requestPath = `/tmp/tedix-file-request-${crypto.randomUUID()}.json`;
	let preserveRequest = false;
	try {
		await sandbox.writeFile(requestPath, request);
		const argv = ["node", "-e", script, requestPath] as const;
		const admitted = execute ? await execute(argv) : null;
		const process =
			admitted?.process ?? (await sandbox.exec(argv, { timeout: 30000 }));
		const output = await process
			.output({
				encoding: "utf8",
				maxBytes: MAX_BYTES,
			})
			.catch((error: unknown) => {
				if (admitted) throw new WorkstationDispatchUnknownError(admitted.id);
				throw error;
			});
		if (output.timedOut || output.signal !== undefined || output.truncated)
			throw Error("File operation returned incomplete output");
		const result: unknown = JSON.parse(output.stdout);
		if (!result || typeof result !== "object" || Array.isArray(result))
			throw Error("Invalid file operation output");
		const record = result as Record<string, unknown>;
		if (output.exitCode !== 0 && record.ok !== false)
			throw Error("File operation failed");
		return record;
	} catch (error) {
		preserveRequest = error instanceof WorkstationDispatchUnknownError;
		throw error;
	} finally {
		if (!preserveRequest)
			await sandbox.deleteFile(requestPath).catch(() => undefined);
	}
}
/** The supplied executor owns the checkout lock for the entire file transaction. */
export async function workstationFiles(
	body: Record<string, unknown>,
	sandbox: FilesSandbox,
	execute?: (argv: readonly [string, ...string[]]) => Promise<{
		id: string;
		process: Awaited<ReturnType<FilesSandbox["exec"]>>;
	}>,
): Promise<Record<string, unknown>> {
	try {
		if (
			!COMPUTER_FILE_OPERATIONS.includes(
				body.operation as (typeof COMPUTER_FILE_OPERATIONS)[number],
			)
		)
			throw Error("Invalid file operation");
		return await runJson(sandbox, FILE_SCRIPT, body, execute);
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
			...(error instanceof WorkstationDispatchUnknownError
				? { executionId: error.executionId, observation: error.observation }
				: {}),
		};
	}
}
