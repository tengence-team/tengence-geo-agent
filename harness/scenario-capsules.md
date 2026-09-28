# 场景胶囊（Scenario Capsules）

> 输入框上方的快捷提示词模板。点击即填入输入框。
> 中英双份，按平台要求的语言版本取用。

## 中文（5 条，建议 3–5 条）

| # | 胶囊文案 | 触发的工作模式 |
|---|---|---|
| 1 | 帮我规划下一批 GEO 选题，给出体裁和优先级 | `topic-planning` |
| 2 | 按 GEO 标准写一篇 comparison 文章，并过一遍门禁 | `writing-gate` |
| 3 | 把已过门禁的稿件发布到微信和技术社区 | `publishing` |
| 4 | 提交这批新文章的收录，看看目前收录基线 | `monitoring` |
| 5 | 看看我们品牌在 AI 助手里的可见性怎么样 | `monitoring` |

## English (5)

| # | Capsule | Work mode |
|---|---|---|
| 1 | Plan the next batch of GEO topics with formats and priorities | `topic-planning` |
| 2 | Write a comparison article to GEO standard and run the quality gate | `writing-gate` |
| 3 | Publish the approved draft to WeChat and tech communities | `publishing` |
| 4 | Submit the new articles for indexing and show the current baseline | `monitoring` |
| 5 | How visible is our brand inside AI assistants? | `monitoring` |

## 编排建议

- 顺序按流水线排列（规划 → 撰写 → 发布 → 提交 → 监测），符合用户心智。
- 每条指向一个工作模式；点击后应自动切到对应模式并填入提示词。
- 文案保持口语化短句，不堆术语——术语由工作模式的 System Prompt 负责。
