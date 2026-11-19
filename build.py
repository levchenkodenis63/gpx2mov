"""Build the standalone GitHub Pages entry point from the browser sources."""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "src"


def inline_script(match):
    code = (SOURCE / match.group(1)).read_text(encoding="utf-8")
    return f"<script>\n{code}\n</script>"


if __name__ == "__main__":
    page = (SOURCE / "index.html").read_text(encoding="utf-8")
    page = re.sub(r'<script src="([\w.-]+\.js)"></script>', inline_script, page)
    destination = ROOT / "docs"
    destination.mkdir(exist_ok=True)
    (destination / "index.html").write_text(page, encoding="utf-8")
