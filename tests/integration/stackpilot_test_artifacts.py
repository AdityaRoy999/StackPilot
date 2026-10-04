"""Generated qualification evidence is private working data, not source docs."""
from pathlib import Path


def artifact_path(filename):
    filename = str(filename)
    if Path(filename).name != filename:
        raise ValueError("Artifact names must be simple filenames")
    directory = Path(__file__).resolve().parents[1] / "artifacts"
    directory.mkdir(parents=True, exist_ok=True)
    return directory / filename
