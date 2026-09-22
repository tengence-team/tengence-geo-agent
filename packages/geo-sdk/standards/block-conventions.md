# Block Conventions (Authoring ⇄ Parser Contract)

> Single source of truth for the GEO block headings and the answer-first notation.
> The article skeletons in `templates/skeletons/` use the **English** forms; the parser
> and the publish chain accept **both** languages (see "Bilingual support" below), so
> existing Chinese articles keep passing unchanged.

## 1. Canonical blocks

| Role | English (canonical) | Chinese (legacy, still accepted) | Required |
|---|---|---|---|
| Opening summary | `> **Summary:** …` | `> **摘要**：…` | yes |
| Key takeaways | `## Key Takeaways` | `## 关键要点` | yes (4–8 items) |
| FAQ | `## FAQ` | `## 常见问题` | yes (4–8 pairs) |
| Data sources | `## Data Sources` | `## 数据来源` | yes |
| Related reading | `## Related Reading` | `## 相关阅读` | recommended |
| Call to action | `## Get Started` | `## 立即行动` | site-defined |
| Brand blurb | `## About <Brand>` | `## 关于<品牌>` | site-defined |

Legacy bold notation (`**数据来源**`, `**引用来源**`) is still recognized for
citations but should not be used in new articles — always write an H2.

## 2. Answer-first notation

- Every H2 opens with a **self-contained answer sentence** — 40–60 characters in
  Chinese, roughly 25–40 words in English. The reader must get the conclusion from
  that sentence alone, with no setup and no suspense.
- FAQ pairs are written as a blockquote pair:

```markdown
> **Q: {question}?**
>
> A: {answer, with a decision rule or a figure}
```

Chinese equivalent: `> **问：{问题}？**` / `> 答：{答案}`.

## 3. Bilingual support (parser contract)

These are the recognition points that must accept both languages. They are the
contract between this document and the code:

| Code location | What it matches | English forms to add |
|---|---|---|
| `content/md.js` takeaways heading | `关键要点｜核心要点｜要点速览` | `Key Takeaways`, `Key Points` |
| `content/md.js` FAQ heading | `常见问题｜FAQ` | already accepts `FAQ` |
| `content/md.js` citations heading | `数据来源` | `Data Sources`, `Sources`, `References` |
| `content/md.js` summary regex | `> **摘要**：` | `> **Summary:**` |
| `check/index.js` h2 counts | `<h2>关键要点</h2>`, `<h2>常见问题</h2>` | `<h2>Key Takeaways</h2>`, `<h2>FAQ</h2>` |
| `check/index.js` citation block | `**数据来源**｜**引用来源**｜^## (数据来源\|引用来源)` | `**Data Sources**`, `^## (Data Sources\|Sources)` |
| `check/index.js` summary gate | `> **摘要**：` | `> **Summary:**` |
| `publish/index.js` block detection | `<h2>关键要点</h2>`, `常见问题</h2>` | English equivalents |
| `content/meta.js` FAQ fallback | `^## 常见问题` | `^## FAQ` |

Rule for any future change: **add, never replace.** Removing a Chinese form breaks
every article already published.

## 4. Numbered H2 sections

- English articles number H2 sections with **Arabic numerals**: `## 1. …`, `## 2. …`
- Chinese articles use **Chinese numerals**: `## 一、…`, `## 二、…`
- In both cases numbering runs continuously — no skipped, no repeated numbers.

## 5. Hard rules that hold in both languages

- No bare URLs: every citation is a text hyperlink pointing at the specific page
  that carries the claim (never a homepage or a level-1 channel page).
- No Markdown residue in the rendered body (`###`, stray `**`).
- No third-party logos in images; every image carries substantive content.
- Named entities with context beat pronouns: prefer concrete product, version and
  institution names over "the platform".
