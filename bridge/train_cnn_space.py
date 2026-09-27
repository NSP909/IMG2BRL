"""Teach Bragi's skeleton CNN a 27th sign, SPACE, from the Space samples
recorded in the Dev tab -- without touching its 26 letters.

The CNN ends in one dense layer: 128 features -> 26 letter logits. This adds a
27th column to that layer and trains only that column (128 weights + a bias),
by softmax cross-entropy over all 27 outputs with the original 26 frozen. So
every letter keeps exactly the logit it had; SPACE just competes with them.

Training images are the same skeleton renders the CNN sees at runtime, drawn
from the recorded landmark samples:
  - positives: every SPACE sample (both cameras), with small rotations and a
    mirrored copy so either hand and a bit of tilt still count;
  - negatives: every recorded letter sample, with the same augmentation.

Writes bridge/models/asl_cnn_model_space.onnx (the original model is kept);
asl_cnn.py loads it automatically when it exists.

    bridge/.venv/bin/python3 bridge/train_cnn_space.py
"""

from __future__ import annotations

import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import asl_cnn  # noqa: E402

SOURCE_MODEL = os.path.join(HERE, "models", "asl_cnn_model.onnx")
OUT_MODEL = os.path.join(HERE, "models", "asl_cnn_model_space.onnx")
# (file, raw frame width, height, clockwise turn to upright): the CNN always
# sees the hand upright, like it does at runtime (asl_mode._upright_points).
SOURCES = [
    (os.path.join(HERE, "models", "asl_samples_pi.json"), 1280, 720, 90),
    (os.path.join(HERE, "models", "asl_samples.json"), 640, 480, 0),
]
ANGLES = (-15, -7, 0, 7, 15)
HOLDOUT = 0.25  # last quarter of each recorded take, for an honest check


def to_points(vec, w, h, rotate):
    v = np.asarray(vec, dtype=np.float32).reshape(21, 3)
    x, y = v[:, 0] * w, v[:, 1] * h
    if rotate == 90:
        x, y = -y, x
    return np.stack([x, y], axis=1)


def augment(points, angle, mirror):
    p = points - points.mean(axis=0)
    t = np.deg2rad(angle)
    p = p @ np.array([[np.cos(t), -np.sin(t)], [np.sin(t), np.cos(t)]], dtype=np.float32).T
    if mirror:
        p[:, 0] = -p[:, 0]
    return p


def load_samples():
    """[(points, is_space, is_holdout)] from every recorded sample file."""
    out = []
    for path, w, h, rot in SOURCES:
        try:
            data = json.load(open(path))
        except FileNotFoundError:
            continue
        by_label: dict[str, list] = {}
        for s in data:
            by_label.setdefault(s["label"], []).append(s["vector"])
        for label, vecs in by_label.items():
            cut = int(len(vecs) * (1 - HOLDOUT))
            for i, vec in enumerate(vecs):
                out.append((to_points(vec, w, h, rot), label == "SPACE", i >= cut))
    return out


def main():
    import onnx
    import onnxruntime as ort
    from onnx import numpy_helper

    samples = load_samples()
    n_space = sum(1 for _, sp, _ in samples if sp)
    if n_space == 0:
        sys.exit("No SPACE samples recorded yet: record Space in the Dev tab's recorder first.")

    sess = ort.InferenceSession(SOURCE_MODEL, providers=["CPUExecutionProvider"])
    inp = sess.get_inputs()[0].name

    def features(points_list):
        imgs = np.stack([asl_cnn.render_skeleton(asl_cnn.normalize_landmarks(p)).astype(np.float32) for p in points_list])
        logits, feats = [], []
        for i in range(0, len(imgs), 256):
            l, f = sess.run(["logits", "dense_features"], {inp: imgs[i:i + 256]})
            logits.append(l)
            feats.append(f)
        return np.concatenate(logits), np.concatenate(feats)

    def build(split):
        pts, ys = [], []
        for p, sp, hold in samples:
            if hold != split:
                continue
            variants = [(a, m) for a in ANGLES for m in (False, True)] if not split else [(0, False)]
            for a, m in variants:
                pts.append(augment(p, a, m))
                ys.append(1 if sp else 0)
        logits, feats = features(pts)
        return logits, feats, np.asarray(ys, dtype=np.float32)

    print(f"{n_space} SPACE samples, {len(samples) - n_space} letter samples; rendering and embedding...")
    z_tr, f_tr, y_tr = build(False)
    z_te, f_te, y_te = build(True)

    # Train the SPACE column: logit_s = f . w + b, CE over [26 frozen logits, logit_s].
    w = np.zeros(f_tr.shape[1], dtype=np.float64)
    b = float(np.median(z_tr.max(axis=1))) - 6.0   # start well below the letters
    pos_weight = (len(y_tr) - y_tr.sum()) / max(y_tr.sum(), 1)
    sw = np.where(y_tr == 1, pos_weight, 1.0)
    m_w = v_w = np.zeros_like(w)
    m_b = v_b = 0.0
    lr, l2 = 0.02, 1e-3
    for step in range(1, 1501):
        s = f_tr @ w + b
        top = np.maximum(z_tr.max(axis=1), s)
        e_letters = np.exp(z_tr - top[:, None]).sum(axis=1)
        e_s = np.exp(s - top)
        p_s = e_s / (e_letters + e_s)
        g = sw * (p_s - y_tr) / sw.sum()
        gw = f_tr.T @ g + l2 * w
        gb = g.sum()
        m_w = 0.9 * m_w + 0.1 * gw
        v_w = 0.999 * v_w + 0.001 * gw * gw
        m_b = 0.9 * m_b + 0.1 * gb
        v_b = 0.999 * v_b + 0.001 * gb * gb
        w -= lr * (m_w / (1 - 0.9 ** step)) / (np.sqrt(v_w / (1 - 0.999 ** step)) + 1e-8)
        b -= lr * (m_b / (1 - 0.9 ** step)) / (np.sqrt(v_b / (1 - 0.999 ** step)) + 1e-8)

    def space_prob(z, f):
        s = f @ w + b
        top = np.maximum(z.max(axis=1), s)
        return np.exp(s - top) / (np.exp(z - top[:, None]).sum(axis=1) + np.exp(s - top))

    p_te = space_prob(z_te, f_te)
    pos, neg = y_te == 1, y_te == 0
    recall = float((p_te[pos] >= asl_cnn.COMMIT_CONFIDENCE).mean()) if pos.any() else float("nan")
    false_pos = float((p_te[neg] >= 0.5).mean())
    print(f"held-out SPACE counted (>= {int(asl_cnn.COMMIT_CONFIDENCE * 100)}%): {recall:.0%} of {int(pos.sum())}")
    print(f"held-out letters wrongly read as SPACE: {false_pos:.1%} of {int(neg.sum())}")

    model = onnx.load(SOURCE_MODEL)
    inits = {i.name: i for i in model.graph.initializer}
    wname = "asl_cnn_instrumented_1/logits_1/Cast/ReadVariableOp:0"
    bname = "asl_cnn_instrumented_1/logits_1/BiasAdd/ReadVariableOp:0"
    W = numpy_helper.to_array(inits[wname])
    B = numpy_helper.to_array(inits[bname])
    inits[wname].CopyFrom(numpy_helper.from_array(np.concatenate([W, w[:, None].astype(W.dtype)], axis=1), wname))
    inits[bname].CopyFrom(numpy_helper.from_array(np.concatenate([B, np.asarray([b], dtype=B.dtype)]), bname))
    for out in model.graph.output:
        if out.name == "logits":
            out.type.tensor_type.shape.dim[1].dim_value = W.shape[1] + 1
    onnx.checker.check_model(model)
    onnx.save(model, OUT_MODEL)
    print(f"wrote {os.path.relpath(OUT_MODEL, os.path.dirname(HERE))} ({W.shape[1] + 1} outputs: a-z + space)")


if __name__ == "__main__":
    main()
