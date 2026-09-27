# Third-party ASL CNN notice

The skeleton renderer, landmark smoothing, J/Z motion rules, and
`models/asl_cnn_model.onnx` were adapted from
[`punpuniacitizen/MediaPipe-ASL-sign-language-recognition`](https://github.com/punpuniacitizen/MediaPipe-ASL-sign-language-recognition),
release v1.1 (`45ff2c0`).

The source code is used under the MIT License:

> Copyright (c) 2026 Nicolás Florentín
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

The upstream MIT license covers its source code, not the trained ONNX weights.
The weights were trained from ASL Alphabet by Akash Nagaraj (GPL-2.0), ASL
Dataset by Ayush Thakur (CC0-1.0), and ASL Alphabet Test by Dan Rasband
(CC0-1.0). This repository preserves that provenance instead of presenting the
weights as an original IMG2BRL model.

`models/asl_cnn_model_space.onnx` is that same model with one extra output
column (SPACE) added by `train_cnn_space.py`, trained only from this project's
own recorded Space and letter samples; the original 26 letter weights are
unchanged, so the provenance above applies to it as well.
