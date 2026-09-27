# Detection models (not checked in)

This project's real detector (still to be wired in, see the top-level
README's "Detection in" section) uses two stock Ultralytics weight files.
They are not committed here — both are large, publicly downloadable, and
already covered by Ultralytics' own auto-download mechanism, so keeping them
out of git keeps clone/pull fast and avoids binary bloat in history.

| File | Size | Purpose |
| --- | --- | --- |
| `yolo26n-seg.pt` | ~6.7 MB | Default object segmentation model (640px), matches the Vision Assistant prototype |
| `yoloe-26m-seg-pf.pt` | ~85.6 MB | Larger open-vocabulary, prompt-free YOLOE segmentation model |

Both names are in Ultralytics' `GITHUB_ASSETS_NAMES` registry
(`ultralytics/assets` releases on GitHub), so the `ultralytics` package
resolves and downloads them automatically the first time either is loaded
by name — no manual URL needed.

## Fetch them

```bash
pip install ultralytics
python fetch_models.py            # downloads both into this directory
# or just one:
python fetch_models.py yolo26n-seg.pt
```

`fetch_models.py` calls `ultralytics.YOLO(name)`, which downloads the
weight into the current directory if it isn't already there, verified by
Ultralytics against its own release assets.

## Manual fallback

If a device can't run `ultralytics` (e.g. resource-constrained Pi Zero 2 W),
download the `.pt` files on another machine the same way and copy them over
(`scp`, the USB gadget link, etc.) rather than committing them to the repo.

Ultralytics/YOLO weights are AGPL-3.0 licensed; see
<https://www.ultralytics.com/license> before distributing a closed-source
build that bundles them.
