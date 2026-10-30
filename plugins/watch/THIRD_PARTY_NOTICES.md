# Third-party notices

The FFmpeg frame timestamp extraction, WebVTT parsing, original-language caption
selection and reuse of downloaded metadata in
`tools/media.py` are adapted from `bradautomates/claude-video`, commit
`03ceb42f7fa2c4439aca01752118044baabffb8f` (skills/watch/scripts/frames.py and
transcribe.py and download.py). The source was inspected locally before adaptation. Watch uses
its own bounded process runner, job storage, tool interface, input validation,
frame coverage policy and Bilibili WBI adapter. The upstream setup, global
configuration and cloud model integrations are not included.

Source: https://github.com/bradautomates/claude-video

MIT License

Copyright (c) 2026 Bradley Bonanno

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.


## Bilibili storyboard reference

The storyboard timestamp normalization, binary index fallback and tile sampling
in `tools/preview.py` follow the approach in `c1overzz/dsh-bili-scroll`, commit
`4af98392ee078e02f50a7fd0bf0491033f4675ed`, `vendor/bilibili-mcp/mcp_server.py`.
The implementation uses its own bounded client and explicit part/range checks.

Source: https://github.com/c1overzz/dsh-bili-scroll

MIT License

Copyright (c) 2026 c1overzz

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## dsh-video-storyboard — SAOS-3624

感谢 SAOS-3624 开源 dsh-video-storyboard。

The density-integral allocation and Laplacian sharpness ranking in
`tools/storyboard.py` are adapted from `src/density.js` and `src/sheet.js` of
SAOS-3624/dsh-video-storyboard, commit
`e32f9f66b61b7ac579481f6ddf458cc8b00d3bbe` (version 0.4.4).
The numbered overview, time-aligned transcript and cell-based rereading design
also draw on that project. Watch implements its own Python/MCP interfaces,
FFmpeg scene-score and actual-PTS handling, bounded candidate extraction,
per-job immutable cell addressing, image composition, validation and lifecycle.

Source: https://github.com/SAOS-3624/dsh-video-storyboard
Author: https://github.com/SAOS-3624

The upstream source code is MIT-licensed. Its NOTICE excludes documentation
images from that grant. No upstream demonstration images, video footage,
model weights, DSH runtime, configuration or credentials are redistributed.

MIT License

Copyright (c) 2026 SAOS-3624

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Browser-reading design references

The online-reading design was informed by the MIT-licensed projects
[MoaidHathot/Zakira.Replay](https://github.com/MoaidHathot/Zakira.Replay)
(commit `09dbc02bf9a3b1a60dd4d9591dc1078c66e7ef36`),
[cctv2333/vidlens](https://github.com/cctv2333/vidlens)
(commit `e91bf966d6de80cdb6d8f5a2b6211eed41f4645a`), and
[yanlingLabs/video-extract-mcp](https://github.com/yanlingLabs/video-extract-mcp)
(commit `32d1861aaebcee4ccdfa2a459b2990e3d30d04c0`).
These references informed browser seeking/captions and bounded reading windows.
The browser SDK, evidence ingestion, and tab-audio integration are independently
implemented for OpenBot; no source code or runtime dependency from these three
projects is included in this release.
