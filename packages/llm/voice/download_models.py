"""Build-time download of the reviewed model manifest; runtime inference stays offline."""
import argparse
import hashlib
import json
import pathlib
import urllib.request


def download(manifest, destination, engine):
    destination.mkdir(parents=True, exist_ok=True)
    for item in json.loads(manifest.read_text(encoding="utf-8")):
        if item["engine"] != engine:
            continue
        name = item["file"]
        if pathlib.PurePosixPath(name).name != name or "\\" in name:
            raise ValueError("Invalid model filename")
        if not item["url"].startswith("https://huggingface.co/"):
            raise ValueError("Invalid model source")
        with urllib.request.urlopen(item["url"], timeout=180) as response:
            data = response.read(item["bytes"] + 1)
        if len(data) != item["bytes"] or hashlib.sha256(data).hexdigest() != item["sha256"]:
            raise ValueError("Model checksum mismatch")
        (destination / name).write_bytes(data)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=pathlib.Path, required=True)
    parser.add_argument("--destination", type=pathlib.Path, required=True)
    parser.add_argument("--engine", choices=["whisper", "piper"], required=True)
    args = parser.parse_args()
    download(args.manifest, args.destination, args.engine)
