#!/usr/bin/env python3
"""Download the detection weights into this directory via Ultralytics' auto-download.

Usage:
    python fetch_models.py                       # fetch both default models
    python fetch_models.py yolo26n-seg.pt         # fetch just one
"""

from __future__ import annotations

import sys
from pathlib import Path

DEFAULT_MODELS = ["yolo26n-seg.pt", "yoloe-26m-seg-pf.pt"]


def main() -> None:
    from ultralytics import YOLO

    names = sys.argv[1:] or DEFAULT_MODELS
    here = Path(__file__).resolve().parent

    for name in names:
        dest = here / name
        if dest.exists():
            print(f"{name}: already present, skipping")
            continue
        print(f"{name}: downloading via ultralytics...")
        YOLO(name)
        downloaded = Path.cwd() / name
        if downloaded.exists() and downloaded != dest:
            downloaded.rename(dest)
        print(f"{name}: saved to {dest}")


if __name__ == "__main__":
    main()
