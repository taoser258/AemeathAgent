---
name: genui
modes: work, learn
description: 在回答正文里内嵌可视化 UI（图表、数据卡、对比表、时间线、进度、测验、函数图等），用 ```genui 围栏写 JSON 规格，界面会渲染成真实组件。当"用图/表/卡片比纯文字更清楚"时使用：数据对比、占比趋势、流程步骤、指标看板、参数滑块演示、自测题——即使用户没明说"做个界面"，只要结构化呈现明显优于散文，就主动用。纯聊天/短回答/写代码不要用。
---

# GenUI — 生成式 UI 输出规范

你可以在回答正文中间输出可交互 UI：写一个 ` ```genui ` 围栏，内含一段 JSON 文档，界面会把它渲染成真实组件，文字照常穿插在前后。组件是回答的一部分，不是工具调用。

```genui
{"title":"可选标题","items":[ {"type":"text","content":"…"}, {"type":"chart","kind":"bars","data":[{"label":"一月","value":42}]} ]}
```

## 何时用 / 何时不用

- **用**：多维数据对比（table/chart）、占比（donut）、趋势（line）、KPI 看板（stat/hero）、流程步骤（steps/timeline）、进度（progress）、参数演示（plot 滑块）、自测题（radio+submit）、要点强调（callout/badge）。
- **不用**：闲聊、单句回答、写代码/改文件、纯叙述——这些用散文更好。别为炫技堆 UI。

## 文档结构

根是对象：`{ "title"?: string, "gap"?: number, "items": [节点, …] }`。items 是组件数组，纵向排列。容器组件（row/col/grid/card/tabs/accordion）的子节点放在 `items`（tabs 用 `tabs:[{label,items}]`）。

**别用 HTML/React 习惯词**：没有 `section`/`column`/`container` 这些 type（纵向分组用 `col`，带标题的块用 `card`）；子节点字段只叫 `items` 不叫 `children`；文本内容字段只叫 `content` 不叫 `text`。写错会被归一化兜底，但以本清单为准最稳。

## 三条硬规矩（都踩过坑）

1. **根永远是 `{"items":[…]}`**——不是 `{"component":"table","data":{…}}`，也不是 `{"type":"section","children":[…]}`；节点类型只写在节点的 `type` 里。
2. **字符串里不要出现英文双引号**：要引用就用中文引号「」，否则 JSON 解析失败、整块降级成代码块（用户看到的是"界面数据不完整"）。字符串里也不要换行。
3. **table 的 columns 是字符串数组、rows 是二维数组**：`{"type":"table","columns":["知识点","张数"],"rows":[["定义","4"]]}`。

## 组件清单（type 只允许这些）

- 布局：`text` `row` `col` `grid` `card` `hero` `divider` `spacer`
- 展示：`stat` `badge` `progress` `list` `table` `keyvalue` `avatar` `timeline` `file-tree` `breadcrumb` `diff` `json` `code` `callout` `steps`
- 图表：`chart`（bars/line/donut，多序列）`plot`（函数图+参数滑块）`echart`（preset 会映射到内置图表）
- 交互：`button` `input` `textarea` `select` `checkbox` `radio` `slider` `switch` `tabs` `accordion` `copy` `link` `submit`

**每个组件的完整字段、取值、示例见 references/genui-components.md**——动手写复杂组件（table 的排序/过滤/明细、chart 的多序列、plot 的表达式、交互表单）前，用 read_file 读它（加载本技能时末尾已给出绝对路径）。下面只列最常用的几个，其余照 references 写。

### 速记（高频）
- `{"type":"text","size":"h2|body|muted","content":"…"}`
- `{"type":"stat","label":"营收","value":"¥1.2万","delta":"+18%","spark":[3,5,4,8,6]}`（delta：+红-绿，中国惯例）
- `{"type":"chart","kind":"bars|line|donut","data":[{"label":"…","value":n}],"series":[…]?,"horizontal":true?,"stacked":true?}`
- `{"type":"table","columns":[…],"rows":[[…]],"types":["num","delta","bar"]?,"total":true?,"export":true?}`
- `{"type":"callout","tone":"info|success|warning|error","title":"…","content":"…"}`
- `{"type":"hero","title":"…","value":"99.9%","label":"可用率","delta":"+0.2%","tone":"success"}`（一条回答最多一个，放最前当封面）

## 硬规则

1. **JSON 必须合法且完整**：一次写全，别写半截（半截会显示"生成中"占位）。字符串里的引号/换行要正确转义。
2. **配色自动跟随主题**：图表色板、卡片底色都由界面按当前深浅主题注入，**你不要写死颜色**（除非用户明确要某个语义色，如"成本标红"才用 `color`/`tone`）。默认不写 palette 最稳。
3. **数据要真实**：组件里的数字来自你的分析/工具结果，绝不编造。没有数据就用文字，别画空图。
4. **克制**：一条回答里 UI 是点缀不是主体。通常 1～3 个组件足够；能一句话说清的别做卡片。text/散文与组件混排，前后要有文字解释这张图说明什么。
5. **交互组件**：button/input/radio 等带 `action` 字段的，用户点击后会把 `[genui-action] {…}` 作为消息回传给你，你据此继续。**判卷/排序/折叠/筛选这类本地能做的，界面自己完成，不用你往返**。出选择题用 radio（带 `answer`+`explanation`）+ 末尾 submit 聚合，别每题单独发 action。
6. **降级透明**：echart 的完整 option、mermaid、3D、图片音视频这些当前界面不支持——用 chart/plot/table 等内置组件表达，或如实说明"这个用文字/表格呈现"。别硬塞渲染不了的 type（会被校验拒绝、整块降级成代码）。
7. **秘密禁令**：不得借 input 索取或生成密码、API Key、令牌等敏感输入。

## 一个完整示例（月度营收对比）

```genui
{"title":"2024 上半年营收","items":[
  {"type":"hero","label":"总营收","value":"¥68.4万","delta":"+12.6%","tone":"success"},
  {"type":"chart","kind":"bars","title":"按月","data":[
    {"label":"1月","value":9.2},{"label":"2月","value":8.1},{"label":"3月","value":11.5},
    {"label":"4月","value":12.3},{"label":"5月","value":13.1},{"label":"6月","value":14.2}]},
  {"type":"callout","tone":"info","title":"结论","content":"Q2 环比 Q1 增长 23%，5-6 月连续创新高。"}
]}
```

围栏前后照常写解释文字。图表/表格给完，记得一两句人话点出关键结论——UI 是辅助，你的判断才是主体。
