"""Guard user-facing wording that the review found overstated what is computed."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FILES = [ROOT / "web" / "index.html", ROOT / "web" / "app.js", ROOT / "README.md", ROOT / "IMPLEMENTATION_GUIDE.md"]
BANNED = ["lower bound", "Partitioned 90%", "explore the resilience", "Hydro ", ">Hydrology<", "Hydrology spread"]


def test_no_overstated_wording():
    for path in FILES:
        text = path.read_text()
        for phrase in BANNED:
            assert phrase not in text, f"{phrase!r} in {path.name}"
