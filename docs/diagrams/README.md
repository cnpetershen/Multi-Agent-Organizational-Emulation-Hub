# 图表输出目录（生成物，不入库）

本目录是 [`scripts/extract-diagrams.mjs`](../../scripts/extract-diagrams.mjs) 的**输出目标**。

## 为什么这里没有 `.mmd` 文件

**架构图的唯一真相源是 Markdown 文档中的 ` ```mermaid ` 代码块**，分布在：

- [`README.md`](../../README.md)
- [`docs/architecture/01-overview.md`](../architecture/01-overview.md) … [`08-adr.md`](../architecture/08-adr.md)

GitHub / GitLab / VS Code **原生渲染**这些代码块，因此查看架构图**无需任何安装、无需导出**。
生成的 `.mmd` 属于派生产物，按 `.gitignore` 排除，避免与文档产生不一致的副本。

## 什么时候需要运行提取脚本

需要把图交给**不支持 Mermaid 的工具**（PPT、Word、设计稿）时：

```bash
# 1) 校验全部图表（CI 用，不写文件，有错则退出码 1）
node scripts/extract-diagrams.mjs --check

# 2) 导出 .mmd 到本目录
node scripts/extract-diagrams.mjs

# 3) 渲染为 PNG / SVG
npm install -g @mermaid-js/mermaid-cli
npx puppeteer browsers install chrome-headless-shell
mmdc -i docs/diagrams/<file>.mmd -o diagram.png -w 2048 --backgroundColor white
```

或使用无需安装的 Kroki API：

```bash
curl -X POST -H "Content-Type: text/plain" \
     --data-binary @docs/diagrams/<file>.mmd \
     https://kroki.io/mermaid/svg -o diagram.svg
```

## 校验能力与边界

`--check` 做的是**结构性**校验：

- 图类型关键字是否合法（flowchart / erDiagram / stateDiagram-v2 …）
- 方括号、花括号、双引号是否配平（已对 erDiagram 的鸦脚基数 `o{` `}o` 做归一化，避免误报）
- `sequenceDiagram` 是否声明了 participant 且存在消息箭头

它用于在 CI 中拦截最常见的书写错误，**不是完整的 Mermaid 语法解析器，不能替代一次真实渲染**。

当前状态：**10 个文档 / 28 个图表，校验 0 失败**。
