"""Build the standalone GitHub Pages entry point from the browser sources."""
from pathlib import Path
import argparse
import re
import hashlib
import shutil

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "src"


def inline_script(match):
    code = (SOURCE / match.group(1)).read_text(encoding="utf-8")
    return f"<script>\n{code}\n</script>"


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--routing-preview", type=Path, metavar="FILE", help="Build a standalone routing test page outside docs")
    preview = parser.parse_args().routing_preview
    if preview and preview.resolve().is_relative_to(ROOT / "docs"):
        parser.error("Choose a preview path outside docs")
    page = (SOURCE / "index.html").read_text(encoding="utf-8")
    if not preview:
        page = re.sub(r"<!-- routing-preview -->.*?<!-- /routing-preview -->", "", page, flags=re.S)
    page = re.sub(r'<script src="([\w.-]+\.js)"></script>', inline_script, page)
    if preview:
        preview.write_text(page, encoding="utf-8")
        raise SystemExit
    destination = ROOT / "docs"
    destination.mkdir(exist_ok=True)
    (destination / "index.html").write_text(page, encoding="utf-8")

    shutil.copyfile(SOURCE / "manifest.webmanifest", destination / "manifest.webmanifest")
    shutil.copytree(SOURCE / "icons", destination / "icons", dirs_exist_ok=True)
    digest = hashlib.sha256()
    for asset in [destination / "index.html", destination / "manifest.webmanifest", *sorted((destination / "icons").glob("*.png"))]:
        digest.update(asset.read_bytes())
    worker = (SOURCE / "sw.js").read_text(encoding="utf-8")
    (destination / "sw.js").write_text(worker.replace("__BUILD_HASH__", digest.hexdigest()[:16]), encoding="utf-8")
