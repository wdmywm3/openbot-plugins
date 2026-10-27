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