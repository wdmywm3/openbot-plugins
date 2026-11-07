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

这是一份可选参考。先按照 `image-studio:imagegen` 的工具说明执行；只有需要 GPT Image 的提示词、参考图或动图指导时才读取本 Skill，不需要把全文加入每次请求。

把用户需求整理为主体、动作、场景、构图、风格、画面文字和必须保留的约束。用户没有要求的角色、品牌、对白和剧情不要自行增加。对参考图说明每张图的作用；修改角色时描述需要保留的面貌、发型和辨识特征。

GPT Image 2.6 Flare 偏重速度，Sunburst 偏重细节与精确编辑。动图提示词写清动作起点、终点、镜头是否固定及是否循环；可用 `format: "gif"`、`frameCount` 和 `frameDurationMs` 请求动图。最终以服务实际返回的格式与任务结果为准，服务不支持时说明原因。

更详细的提示词范例和原则见 `references/prompting.md` 与 `references/sample-prompts.md`，只在需要时读取。它们改编自 OpenAI Codex 的 imagegen Skill，许可见 `LICENSE.txt`。
