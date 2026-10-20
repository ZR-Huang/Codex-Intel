#!/usr/bin/env python3
"""Fetch and verify the current official source app into this repository's cache."""
from concurrent.futures import ThreadPoolExecutor, as_completed
import argparse
import hashlib
import json
from pathlib import Path
import plistlib
import subprocess
import xml.etree.ElementTree as ET

HERE = Path(__file__).resolve().parent
FEED = "https://persistent.oaistatic.com/codex-app-prod/appcast.xml"
SPARKLE = "http://www.andymatuschak.org/xml-namespaces/sparkle"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--direct", action="store_true", help="Connect directly to the official CDN, without the configured proxy")
    parser.add_argument("--workers", type=int, default=6)
    args = parser.parse_args()
    if not 1 <= args.workers <= 12:
        parser.error("--workers must be between 1 and 12")
    base = HERE / ".cache/sources"
    base.mkdir(parents=True, exist_ok=True)
    curl = ["curl", "--fail", "--location", "--retry", "3", "--retry-all-errors", "--connect-timeout", "10", "--max-time", "600", "--silent", "--show-error"]
    if args.direct:
        curl += ["--noproxy", "persistent.oaistatic.com"]
    feed = base / "appcast.xml"
    subprocess.run([*curl, "--output", str(feed), FEED], check=True)
    item = ET.fromstring(feed.read_bytes()).find(".//item")
    enclosure = item.find("enclosure")
    version = item.findtext(f"{{{SPARKLE}}}shortVersionString")
    url, total = enclosure.attrib["url"], int(enclosure.attrib["length"])
    signature = enclosure.attrib[f"{{{SPARKLE}}}edSignature"]
    if not url.startswith("https://persistent.oaistatic.com/codex-app-prod/"):
        raise ValueError("Unexpected official source download URL")
    folder = base / version
    folder.mkdir(parents=True, exist_ok=True)
    archive = folder / "official.zip"
    print(f"Official source: {version}; {total / 1048576:.1f} MiB", flush=True)
    if not archive.exists():
        chunk = 32 * 1048576
        ranges = [(index, start, min(start + chunk, total) - 1) for index, start in enumerate(range(0, total, chunk))]
        # Fetch the application archive and metadata early; remaining bundles follow.
        ranges.sort(key=lambda value: (0 if 4 <= value[0] <= 11 else 1, value[0]))
        def download(item):
            index, start, end = item
            part = folder / f"part-{index:03d}"
            expected = end - start + 1
            if not part.exists() or part.stat().st_size != expected:
                subprocess.run([*curl, "--range", f"{start}-{end}", "--max-filesize", str(expected), "--output", str(part), url], check=True)
            if part.stat().st_size != expected:
                raise ValueError(f"Incomplete download range {index}")
            return part
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            futures = [pool.submit(download, item) for item in ranges]
            for count, future in enumerate(as_completed(futures), 1):
                part = future.result()
                print(f"Downloaded {count}/{len(ranges)} ranges: {part.name}", flush=True)
        with archive.open("wb") as target:
            for index in range(len(ranges)):
                with (folder / f"part-{index:03d}").open("rb") as part:
                    while data := part.read(1048576):
                        target.write(data)
    if archive.stat().st_size != total:
        raise ValueError("Official archive length differs from the signed feed")
    extracted = folder / "extracted"
    if not extracted.exists():
        subprocess.run(["ditto", "-x", "-k", str(archive), str(extracted)], check=True)
    apps = list(extracted.glob("*.app"))
    if len(apps) != 1:
        raise ValueError("Expected one official application bundle")
    source = apps[0]
    # Signing keys rotate. Read the updater key only after verifying OpenAI's Apple identity.
    requirement = '=anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2"'
    subprocess.run(["codesign", "--verify", "--deep", "--strict", "-R", requirement, str(source)], check=True)
    plist = plistlib.loads((source / "Contents/Info.plist").read_bytes())
    public_key = plist["SUPublicEDKey"]
    verify = """
const fs = require('node:fs');
const crypto = require('node:crypto');
const [file, publicKey, signature] = process.argv.slice(1);
const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKey, 'base64')]);
const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
if (!crypto.verify(null, fs.readFileSync(file), key, Buffer.from(signature, 'base64'))) {
  throw new Error('Official Sparkle Ed25519 signature verification failed');
}
console.log('Official Ed25519 signature verified.');
"""
    subprocess.run(["node", "-e", verify, str(archive), public_key, signature], check=True)
    with archive.open("rb") as stream:
        sha = hashlib.file_digest(stream, "sha256").hexdigest()
    report = {"version": version, "source": str(source), "url": url, "bytes": total,
              "sha256": sha, "ed25519_verified": True, "official_codesign_verified": True}
    (folder / "source-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    (base / "latest.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(f"Verified source: {source}", flush=True)


if __name__ == "__main__":
    main()
