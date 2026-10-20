#!/usr/bin/env python3
"""Build a local Intel-compatible copy of an installed Electron Codex app."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import time

HERE = Path(__file__).resolve().parent
DEFAULT_OUTPUT = HERE / "dist/Codex Intel.app"
TOOL_VERSIONS = {"@electron/asar": "4.3.1", "@electron/rebuild": "4.2.1"}
COMPATIBILITY_APIS = [
    "app.showTaskManager", "app.setDebugChromePagesEnabled(false)",
    "BrowserWindow.isInputShapeSupported", "BrowserWindow.isSystemBackdropSupported",
    "BrowserWindow.isAlwaysOnTopSupported", "screen.isCursorScreenPointSupported",
    "session.setPreferredLanguages", "session.setWebsiteReportingEnabled(false)",
    "session.setPermissionPromptHandler (registration only)", "session.setOpenURLHandler (registration only)",
    "session.setWebContentsActivationHandler (registration only)",
]
LIMITATIONS = ["Owl native browser integration", "Website activity reporting", "Some system shortcuts", "Work Louder hardware integration"]


def run(args, *, cwd=None, env=None, capture=False):
    print("+", " ".join(str(a) for a in args), flush=True)
    return subprocess.run([str(a) for a in args], cwd=cwd, env=env, check=True,
                          text=True, capture_output=capture)


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def archive_json(archive, name):
    """Read only ASAR metadata before downloading build dependencies."""
    with archive.open("rb") as stream:
        _, size, _, length = struct.unpack("<4I", stream.read(16))
        entry = json.loads(stream.read(length))
        for part in name.split("/"):
            entry = entry["files"][part]
        if entry.get("unpacked"):
            return json.loads((Path(str(archive) + ".unpacked") / name).read_text())
        stream.seek(8 + size + int(entry["offset"]))
        return json.loads(stream.read(entry["size"]))


def binary_arch(path):
    return subprocess.check_output(["file", "-b", str(path)], text=True).strip()


def intel_binary(path):
    description = binary_arch(path)
    return "Mach-O" in description and "x86_64" in description


def macho_file(path):
    with path.open("rb") as stream:
        return stream.read(4) in {
            b"\xfe\xed\xfa\xce", b"\xce\xfa\xed\xfe", b"\xfe\xed\xfa\xcf", b"\xcf\xfa\xed\xfe",
            b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca", b"\xca\xfe\xba\xbf", b"\xbf\xba\xfe\xca",
        }


def find_codex(override=None):
    if override:
        path = Path(override).expanduser().resolve()
        if not intel_binary(path):
            raise ValueError("--codex must point to an Intel Mach-O Codex binary.")
        return path
    candidates = []
    command = shutil.which("codex")
    if command:
        command = Path(command).resolve()
        if intel_binary(command):
            candidates.append(command)
        for parent in list(command.parents)[:4]:
            candidates.extend(parent.glob("node_modules/@openai/codex-darwin-x64/vendor/*/bin/codex"))
    managed = Path.home() / ".codex/packages/app-server-daemon/releases"
    candidates.extend(managed.glob("*-x86_64-apple-darwin/bin/codex"))
    candidates = [path for path in set(candidates) if path.is_file() and intel_binary(path)]
    if not candidates:
        raise ValueError("Cannot locate an installed Intel Codex binary; install Codex CLI or pass --codex.")
    def version(path):
        value = subprocess.check_output([str(path), "--version"], text=True).strip()
        match = re.search(r"(\d+)\.(\d+)\.(\d+)", value)
        return tuple(map(int, match.groups())) if match else (0, 0, 0)
    return max(candidates, key=version)


def inspect(source, codex):
    contents = source / "Contents"
    archive = contents / "Resources/app.asar"
    package = archive_json(archive, "package.json")
    if package.get("name") != "openai-codex-electron":
        raise ValueError("The source must be an installed official Codex Electron app.")
    electron = package["devDependencies"]["electron"]
    if not all(part.isdigit() for part in electron.split(".")):
        raise ValueError("The source must specify an exact Electron version.")
    modules = {name: archive_json(archive, f"node_modules/{name}/package.json")["version"]
               for name in ["better-sqlite3", "node-pty"]}
    if "objc-js" in package.get("dependencies", {}):
        modules["objc-js"] = archive_json(archive, "node_modules/objc-js/package.json")["version"]
    return {"source": str(source), "source_version": package["version"],
            "source_asar_sha256": digest(archive), "electron_version": electron,
            "native_modules": modules, "codex_binary": str(codex),
            "codex_version": subprocess.check_output([str(codex), "--version"], text=True).strip(),
            "target_arch": "x86_64", "tool_versions": TOOL_VERSIONS}


def setup_dependencies(info):
    key = hashlib.sha256(json.dumps({"electron": info["electron_version"],
                                    **info["native_modules"], **TOOL_VERSIONS}, sort_keys=True).encode()).hexdigest()[:16]
    cache = HERE / ".cache" / key
    cache.mkdir(parents=True, exist_ok=True)
    marker = cache / "intel-ready.json"
    env = os.environ.copy()
    env.update({"npm_config_arch": "x64", "npm_config_target_arch": "x64"})
    env.pop("ELECTRON_RUN_AS_NODE", None)
    env.pop("ELECTRON_SKIP_BINARY_DOWNLOAD", None)
    # Electron's downloader needs this opt-in even when HTTP_PROXY is set.
    if any(env.get(key) for key in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]):
        env.setdefault("ELECTRON_GET_USE_PROXY", "1")
    if not marker.exists():
        package = {"name": "codex-intel-local-build", "version": "1.0.0", "private": True,
                   "dependencies": {"electron": info["electron_version"], **info["native_modules"], **TOOL_VERSIONS}}
        (cache / "package.json").write_text(json.dumps(package, indent=2) + "\n")
        run(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund"], cwd=cache, env=env)
        run(["node", cache / "node_modules/electron/install.js"], cwd=cache, env=env)
        run([cache / "node_modules/.bin/electron-rebuild", "--force", "--arch", "x64",
             "--version", info["electron_version"], "--which-module", ",".join(info["native_modules"])], cwd=cache, env=env)
        marker.write_text(json.dumps({"electron_version": info["electron_version"], "architecture": "x64"}, indent=2))
    return cache


def asar_action(cache, action, source, target):
    code = """
const asar = require('node:module').createRequire(process.argv[1])('@electron/asar');
const [action, source, target] = process.argv.slice(2);
(async () => {
  if (action === 'extract') asar.extractAll(source, target);
  else await asar.createPackageWithOptions(source, target, {
    unpackDir: '{node_modules/better-sqlite3,node_modules/node-pty}',
    unpack: '**/*.node'
  });
})().catch(error => { console.error(error); process.exit(1); });
"""
    run(["node", "-e", code, cache / "package.json", action, source, target])


def build(source, output, codex, info, *, dev_compat=False):
    if output.exists():
        raise FileExistsError(f"Output already exists: {output}. Choose another --output.")
    if source == output or source in output.parents:
        raise ValueError("Output must be separate from the source application.")
    cache = setup_dependencies(info)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="codex-intel-", dir=output.parent) as temporary:
        work = Path(temporary)
        app = work / output.name
        run(["ditto", cache / "node_modules/electron/dist/Electron.app", app])
        contents = app / "Contents"
        resources = contents / "Resources"
        original_resources = source / "Contents/Resources"
        (resources / "default_app.asar").unlink(missing_ok=True)
        extracted = work / "application"
        asar_action(cache, "extract", original_resources / "app.asar", extracted)
        for name in info["native_modules"]:
            folder = extracted / "node_modules" / name
            shutil.rmtree(folder)
            shutil.copytree(cache / "node_modules" / name, folder, symlinks=True)
            # Preserve compatible N-API prebuilds (objc-js can use these without recompilation).
            prebuilds = folder / "prebuilds"
            if prebuilds.exists():
                for platform in prebuilds.iterdir():
                    if platform.is_dir() and platform.name not in {"darwin-x64", "darwin-x64+arm64"}:
                        shutil.rmtree(platform)
        # Upstream may have bundled these helpers into its JS. npm modules still need them on disk.
        pending = list(info["native_modules"])
        seen = set()
        while pending:
            name = pending.pop()
            if name in seen:
                continue
            seen.add(name)
            installed = cache / "node_modules" / name
            metadata = json.loads((installed / "package.json").read_text())
            for dependency in metadata.get("dependencies", {}):
                cached = cache / "node_modules" / dependency
                if not cached.is_dir():
                    continue
                destination = extracted / "node_modules" / dependency
                if not destination.exists():
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copytree(cached, destination, symlinks=True)
                pending.append(dependency)
        # The optional Work Louder hardware SDK includes an ARM-only permission helper.
        # Remove only unsupported native payloads; its existing error handling can report availability.
        unsupported = []
        for path in (extracted / "node_modules/@worklouder").rglob("*"):
            if path.is_file() and macho_file(path) and not intel_binary(path):
                unsupported.append(str(path.relative_to(extracted)))
                path.unlink()
        info["unavailable_native_payloads"] = unsupported
        package_path = extracted / "package.json"
        package = json.loads(package_path.read_text())
        package["codexSparkleFeedUrl"] = ""
        package["codexIntelCompatibility"] = {"originalVersion": info["source_version"], "target": "x64", "automaticUpdates": False}
        package_path.write_text(json.dumps(package, ensure_ascii=False, indent=2) + "\n")
        # Keep native GUI preferences separate; use the normal Codex CLI sign-in and threads.
        original_main = package["main"]
        bootstrap = extracted / "intel-bootstrap.cjs"
        shutil.copy2(HERE / "intel-compat.cjs", extracted / "intel-compat.cjs")
        bootstrap.write_text("const path = require('node:path');\n"
                             "const { app } = require('electron');\n"
                             "process.env.CODEX_ELECTRON_USER_DATA_PATH ||= path.join(app.getPath('appData'), 'Codex Intel');\n"
                             "process.env.CODEX_CLI_PATH = path.join(process.resourcesPath, 'codex');\n"
                             f"require({json.dumps(str(HERE / 'intel-compat.cjs') if dev_compat else './intel-compat.cjs')});\n"
                             f"require({json.dumps('./' + original_main)});\n")
        package["main"] = bootstrap.name
        package_path.write_text(json.dumps(package, ensure_ascii=False, indent=2) + "\n")
        asar_action(cache, "pack", extracted, resources / "app.asar")
        for asset in original_resources.iterdir():
            if asset.is_file() and asset.name != "app.asar" and not macho_file(asset):
                shutil.copy2(asset, resources / asset.name)
        shutil.copy2(codex, resources / "codex")
        helper = codex.parent / "codex-code-mode-host"
        if helper.is_file() and intel_binary(helper):
            shutil.copy2(helper, resources / helper.name)
            (resources / helper.name).chmod(0o755)
        rg_candidates = [codex.parent.parent / "codex-path/rg", Path(shutil.which("rg") or "/missing")]
        rg = next((path for path in rg_candidates if path.is_file() and intel_binary(path)), None)
        if rg is None:
            raise ValueError("An Intel ripgrep binary is required.")
        shutil.copy2(rg, resources / "rg")
        for path in [resources / "codex", resources / "rg"]:
            path.chmod(0o755)
        plist_path = contents / "Info.plist"
        plist = plistlib.loads(plist_path.read_bytes())
        original_plist = plistlib.loads((source / "Contents/Info.plist").read_bytes())
        plist.update({"CFBundleDisplayName": "Codex Intel", "CFBundleName": "Codex Intel",
                      "CFBundleIdentifier": "org.codexintel.desktop", "CFBundleShortVersionString": info["source_version"],
                      "CFBundleVersion": original_plist["CFBundleVersion"], "NSHighResolutionCapable": True,
                      "CFBundleExecutable": "Codex Intel"})
        # Electron uses its executable name to distinguish a packaged application from development mode.
        (contents / "MacOS/Electron").rename(contents / "MacOS/Codex Intel")
        for key, value in original_plist.items():
            if key.startswith("NS") and key.endswith("UsageDescription"):
                plist[key] = value
        # Retain codex:// sign-in callback routing in the compatible local copy.
        if "CFBundleURLTypes" in original_plist:
            plist["CFBundleURLTypes"] = original_plist["CFBundleURLTypes"]
        plist_path.write_bytes(plistlib.dumps(plist))
        run(["codesign", "--force", "--deep", "--sign", "-", app])
        run(["codesign", "--verify", "--deep", "--strict", app])
        native_files = []
        for path in contents.rglob("*"):
            if path.is_file() and macho_file(path):
                description = binary_arch(path)
                if "Mach-O" in description:
                    if "x86_64" not in description:
                        raise ValueError(f"Non-Intel native binary remains: {path}")
                    native_files.append({"path": str(path.relative_to(app)), "architecture": description})
        info.update({"output": str(output), "built_at": time.strftime("%Y-%m-%d %H:%M:%S"),
                     "automatic_updates": False, "native_binaries": native_files,
                     "compatibility_apis": COMPATIBILITY_APIS, "known_limitations": LIMITATIONS,
                     "compatibility_module_sha256": digest(HERE / "intel-compat.cjs"),
                     "development_compatibility_module": dev_compat,
                     "output_asar_sha256": digest(resources / "app.asar")})
        (resources / "intel-build.json").write_text(json.dumps(info, ensure_ascii=False, indent=2) + "\n")
        # Sign once more after adding the provenance manifest.
        run(["codesign", "--force", "--deep", "--sign", "-", app])
        app.rename(output)
    (output.parent / "build-report.json").write_text(json.dumps(info, ensure_ascii=False, indent=2) + "\n")
    print(f"Built: {output}", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    latest = HERE / ".cache/sources/latest.json"
    default_source = Path(json.loads(latest.read_text())["source"]) if latest.exists() else Path("/Applications/Codex.app")
    parser.add_argument("--source", type=Path, default=default_source)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--codex", type=Path, help="Path to the Intel Codex executable, not the npm JS launcher")
    parser.add_argument("--inspect", action="store_true", help="Read architecture and versions without building")
    parser.add_argument("--dev-compat", action="store_true", help="Load this checkout's compatibility module for local debugging")
    args = parser.parse_args()
    if sys.platform != "darwin" or os.uname().machine != "x86_64":
        parser.error("Run this converter on an Intel Mac.")
    codex = find_codex(args.codex)
    source = args.source.expanduser().resolve()
    info = inspect(source, codex)
    print(json.dumps(info, ensure_ascii=False, indent=2), flush=True)
    if not args.inspect:
        build(source, args.output.expanduser().resolve(), codex, info, dev_compat=args.dev_compat)


if __name__ == "__main__":
    main()
