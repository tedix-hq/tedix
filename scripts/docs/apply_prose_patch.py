"""Apply a bounded Markdown patch after checking source, prose and code integrity."""
import hashlib
import json
import pathlib
import re
import sys

from measure_docs import measure


def blob(data):
    return hashlib.sha1(("blob " + str(len(data)) + "\0").encode() + data).hexdigest()


def fences(value):
    blocks, fence, body = [], None, ""
    for line in value.splitlines(keepends=True):
        marker = re.match(r"^\s*(`{3,}|~{3,})", line)
        if fence is None and marker:
            fence, body = marker.group(1)[0], line
        elif fence:
            body += line
            if marker and marker.group(1)[0] == fence:
                blocks.append(body)
                fence, body = None, ""
    if fence:
        blocks.append(body)
    return blocks


def metadata(value):
    found = re.match(r"\A---\s*\n.*?\n---(?:\n|$)", value, re.S)
    return found.group(0) if found else ""


def candidate(source, payload):
    if not isinstance(payload, dict) or payload.get("version") != 1:
        raise ValueError("Expected a version-1 patch object")
    if set(payload) != {"version", "path", "beforeBlobSha", "afterBlobSha", "before", "patches"}:
        raise ValueError("Unexpected patch fields")
    for field in ("beforeBlobSha", "afterBlobSha"):
        if not isinstance(payload[field], str) or not re.fullmatch(r"[a-f0-9]{40}", payload[field]):
            raise ValueError("Expected an exact Git blob hash")
    patches = payload["patches"]
    if not isinstance(patches, list) or not 1 <= len(patches) <= 8:
        raise ValueError("Expected one to eight patches")
    result, total = source, 0
    for patch in patches:
        if not isinstance(patch, dict) or set(patch) != {"old", "new"}:
            raise ValueError("Expected exact old/new text")
        old, new = patch["old"], patch["new"]
        if not isinstance(old, str) or not isinstance(new, str) or not old or old == new:
            raise ValueError("Invalid text patch")
        total += len(new)
        if len(old) > 2500 or len(new) > 1400 or total > 4500 or "\0" in new:
            raise ValueError("Patch exceeds its bounds")
        if result.count(old) != 1:
            raise ValueError("Patch must identify one exact current span")
        result = result.replace(old, new, 1)
    if fences(source) != fences(result):
        raise ValueError("Code blocks must stay unchanged")
    if sorted(re.findall(r"`+[^`]*`+", source)) != sorted(re.findall(r"`+[^`]*`+", result)):
        raise ValueError("Inline code must stay unchanged")
    links = r"!?\[[^\]]*\]\(([^\n]*?)\)"
    if sorted(re.findall(links, source)) != sorted(re.findall(links, result)):
        raise ValueError("Link targets must stay unchanged")
    shape = lambda value: re.sub(r"^(title|description|summary):[^\n]*$", r"\1: <text>", metadata(value), flags=re.M)
    if shape(source) != shape(result):
        raise ValueError("Structural metadata must stay unchanged")
    if metadata(source) != metadata(result):
        for line in metadata(result).splitlines():
            field = re.match(r"^(title|description|summary):\s*(.*)$", line)
            if field:
                value = json.loads(field.group(2))
                if not isinstance(value, str) or any(x in value for x in ("\r", "\n", "\0")):
                    raise ValueError("Metadata text must be a one-line JSON string")
    return result


def apply(payload, root):
    if not isinstance(payload, dict) or not isinstance(payload.get("path"), str):
        raise ValueError("Missing relative Markdown path")
    relative = pathlib.PurePosixPath(payload["path"])
    if relative.is_absolute() or ".." in relative.parts or "\\" in payload["path"]:
        raise ValueError("Path must stay inside the working directory")
    root = pathlib.Path(root).resolve()
    path = root.joinpath(*relative.parts)
    if path.is_symlink() or path.suffix != ".md" or not path.is_file():
        raise ValueError("Expected an existing Markdown file")
    path.resolve().relative_to(root)
    original = path.read_bytes()
    if blob(original) != payload.get("beforeBlobSha"):
        raise ValueError("Frozen source changed")
    source = original.decode("utf-8")
    after = candidate(source, payload)
    if blob(after.encode()) != payload["afterBlobSha"]:
        raise ValueError("Validated candidate changed")
    before_metrics, after_metrics = measure(source), measure(after)
    expected = payload["before"]
    if not isinstance(expected, dict) or set(expected) != {"jargon", "averageWords", "over25Percent"}:
        raise ValueError("Missing frozen metrics")
    if any(before_metrics[key] != value for key, value in expected.items()):
        raise ValueError("Measured baseline changed")
    if after_metrics["jargon"] >= before_metrics["jargon"]:
        raise ValueError("No measured jargon improvement")
    if after_metrics["averageWords"] > 20 and after_metrics["averageWords"] >= before_metrics["averageWords"]:
        raise ValueError("No measured sentence improvement")
    current = source
    for patch in payload["patches"]:
        # Re-read the exact current bytes immediately before each replacement.
        if path.read_bytes() != current.encode():
            raise ValueError("Source changed before patch")
        if current.count(patch["old"]) != 1:
            raise ValueError("Current patch span is not unique")
        current = current.replace(patch["old"], patch["new"], 1)
        path.write_bytes(current.encode())
    if path.read_bytes() != after.encode():
        raise ValueError("Written candidate does not match validation")
    return {"path": payload["path"], "before": before_metrics, "after": after_metrics}


if __name__ == "__main__":
    payload = json.load(sys.stdin)
    print("DOCS_METRICS_JSON: " + json.dumps(apply(payload, pathlib.Path.cwd())))
