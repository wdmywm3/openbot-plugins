---
name: gpt-image
description: 使用 GPT Image 模型绘图时，可选的提示词、参考图和动图指导。
openbot-visibility:
  any:
    - all:
        - field: provider
          oneOf: [openai-images, openai-responses, auto]
        - field: openaiImageModel
          startsWith: gpt-image-
    - all:
        - field: provider
          oneOf: [compatible-images, compatible-responses, auto]
        - field: compatibleImageModel
          startsWith: gpt-image-
    - all:
        - field: provider
          oneOf: [codex, auto]
        - field: codexImageModel
          startsWith: gpt-image-
    - all:
        - field: provider
          equals: codex
        - field: codexImageModel
          equals: ""
---

# GPT Image 绘图指导

沿用 `image-studio:imagegen` 的自然语言画面与工具流程。把原样文字放在引号内并标明位置，编辑时先定位底图中的具体目标，迭代仅描述本次变化。多张参考按实际输入顺序写明对象、位置和保留关系；每次请求携带所需参考。

动图可写动作起点、变化和回到起点的方式，并说明机位是否固定。格式、帧数、帧时长分别使用 `format`、`frameCount`、`frameDurationMs`。关于构图、光影和微表情，可通过主指南读取 `references/prompting.md`。
