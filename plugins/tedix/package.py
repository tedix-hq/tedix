#!/usr/bin/env python3
"""Package one Tedix identity for cloud or an explicitly trusted local host."""
import argparse
import copy
import json
import ipaddress
import re
from pathlib import Path
from urllib.parse import urlsplit
import zipfile

ROOT = Path(__file__).resolve().parent


def validate_mcp_url(url: str, *, local: bool) -> None:
    """Never embed credentials or downgrade a remote connection to plain HTTP."""
    parsed = urlsplit(url)
    local_hostname = parsed.hostname == "localhost" or bool(re.fullmatch(
        r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+localhost", parsed.hostname or ""))
    try:
        parsed.port
        loopback = local_hostname or ipaddress.ip_address(parsed.hostname or "").is_loopback
    except ValueError:
        loopback = local_hostname
        # Accessing port separately also rejects malformed/non-numeric ports.
        parsed.port
    if (not parsed.hostname or parsed.username is not None or parsed.password is not None
            or parsed.query or parsed.fragment or "\\" in url or any(character.isspace() for character in url)
            or not (parsed.scheme == "https" or (local and loopback and parsed.scheme == "http"))):
        raise ValueError("MCP URL must be HTTPS without credentials, query or fragment; explicit local packages also allow loopback HTTP")


def package_files(root: Path = ROOT, *, local: bool = False, host: str = "openai",
                  mcp_url: str | None = None, mcp_bearer_env: str | None = None) -> dict[str, bytes]:
    if host not in ("openai", "claude"):
        raise ValueError("Host must be openai or claude")
    if mcp_url is not None:
        validate_mcp_url(mcp_url, local=local)
    if mcp_bearer_env is not None and (host != "claude" or not local or mcp_url is None
            or not re.fullmatch(r"[A-Z_][A-Z0-9_]*", mcp_bearer_env)):
        raise ValueError("Bearer environment reference requires --host claude --local --mcp-url and an uppercase environment variable name")
    if host == "claude":
        manifest = json.loads((root / ".claude-plugin/plugin.json").read_text())
        # Use automatic discovery, avoiding duplicate hooks or MCP definitions.
        mcp = json.loads((root / "mcp.json").read_text())
        server = mcp["mcpServers"]["tedix"]
        server["type"] = "http"
        if mcp_url is not None:
            server["url"] = mcp_url
        if mcp_bearer_env is not None:
            server["headers"] = {"Authorization": "Bearer ${" + mcp_bearer_env + "}"}
        files = {
            ".claude-plugin/plugin.json": (json.dumps(manifest, ensure_ascii=False, indent="\t") + "\n").encode(),
            ".mcp.json": (json.dumps({"mcpServers": mcp["mcpServers"]}, indent="\t") + "\n").encode(),
        }
        paths = sorted((root / "skills").glob("*/SKILL.md"))
        paths.extend(root / "assets" / name for name in ("icon.png", "icon-dark.png", "logo.png", "logo-dark.png"))
        if local:
            hooks = json.loads((root / "hooks/hooks.json").read_text())
            for definitions in hooks["hooks"].values():
                for definition in definitions:
                    for handler in definition["hooks"]:
                        handler.pop("additionalContextLimit", None)
                        command = re.fullmatch(r'python3 "\$\{CLAUDE_PLUGIN_ROOT\}/hooks/(session_start|user_prompt_submit|decision_capture)\.py"(?: (stop|reply))?', handler["command"])
                        if command is None or (command.group(1) == "decision_capture") != (command.group(2) is not None):
                            raise ValueError("Unsupported hook command; review the Claude adapter before packaging")
                        handler["command"] = "python3"
                        handler["args"] = ["${CLAUDE_PLUGIN_ROOT}/hooks/" + command.group(1) + ".py", *([command.group(2)] if command.group(2) else [])]
            files["hooks/hooks.json"] = (json.dumps(hooks, ensure_ascii=False, indent="\t") + "\n").encode()
            paths += [root / "hooks/session_start.py", root / "hooks/user_prompt_submit.py", root / "hooks/decision_capture.py"]
        for path in sorted(paths):
            if path.is_symlink() or not path.resolve().is_relative_to(root.resolve()):
                raise ValueError(f"Package source must be a regular in-tree file: {path}")
            files[path.relative_to(root).as_posix()] = path.read_bytes()
        return files
    if mcp_url is not None:
        raise ValueError("MCP URL overrides currently apply only to --host claude")
    manifest = json.loads((root / "plugin.json").read_text())
    extension = manifest["extensions"]["com.openai"]
    extension["review"]["test_cases"] = json.loads((root / "review/cases.json").read_text())
    extension["publication"]["release_notes"] = (root / "review/release-notes.md").read_text().strip()
    files = {"plugin.json": (json.dumps(manifest, ensure_ascii=False, indent="\t") + "\n").encode()}
    paths = [root / "mcp.json"]
    paths.extend(sorted((root / "skills").glob("*/SKILL.md")))
    paths.extend(root / "assets" / name for name in ("icon.png", "icon-dark.png", "logo.png", "logo-dark.png"))
    if local:
        extension["publication"]["release_notes"] = extension["publication"]["release_notes"].replace(
            "It contains no local lifecycle hooks, credentials or\ncopied tokens.",
            "This local artifact includes opt-in context hooks and opt-in decision capture, and contains no credentials or copied tokens.")
        files["plugin.json"] = (json.dumps(manifest, ensure_ascii=False, indent="\t") + "\n").encode()
        paths += [root / ".mcp.json", root / ".claude-plugin/plugin.json"]
        paths += [root / "hooks/hooks.json", root / "hooks/session_start.py", root / "hooks/user_prompt_submit.py",
                  root / "hooks/decision_capture.py"]
        # The portable extension is authoritative. Mirror its complete overlay,
        # rather than rely on an older compatibility manifest being merged.
        compatibility = {key: copy.deepcopy(value) for key, value in manifest.items() if key not in ("$schema", "extensions")}
        compatibility.update(copy.deepcopy(extension))
        compatibility.update(skills="./skills/", mcpServers="./.mcp.json")
        files[".codex-plugin/plugin.json"] = (json.dumps(compatibility, ensure_ascii=False, indent="\t") + "\n").encode()
    for path in sorted(paths):
        if path.is_symlink() or not path.resolve().is_relative_to(root.resolve()):
            raise ValueError(f"Package source must be a regular in-tree file: {path}")
        files[path.relative_to(root).as_posix()] = path.read_bytes()
    return files


def build(destination: Path, *, local: bool = False, host: str = "openai", mcp_url: str | None = None,
          mcp_bearer_env: str | None = None) -> None:
    files = package_files(local=local, host=host, mcp_url=mcp_url, mcp_bearer_env=mcp_bearer_env)
    # Fixed timestamps, ordering and stored bytes make the digest reproducible
    # across hosts without compression-library version differences.
    with zipfile.ZipFile(destination, "x", compression=zipfile.ZIP_STORED) as archive:
        for name, contents in sorted(files.items()):
            entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry, contents)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--local", action="store_true", help="Include opt-in local hooks; review and trust in the host")
    parser.add_argument("--host", choices=("openai", "claude"), default="openai", help="Package for the host's native plugin format")
    parser.add_argument("--mcp-url", help="Explicit Claude MCP endpoint; loopback HTTP requires --local (configure the hooks' CLI profile separately)")
    parser.add_argument("--mcp-bearer-env", help="For an explicit local Claude setup, reference a bearer environment variable without embedding a token")
    parser.add_argument("destination", type=Path, help="New ZIP path (existing files are never overwritten)")
    options = parser.parse_args()
    build(options.destination, local=options.local, host=options.host, mcp_url=options.mcp_url,
          mcp_bearer_env=options.mcp_bearer_env)
    print(options.destination)
