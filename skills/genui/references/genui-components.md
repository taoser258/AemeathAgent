# genui 组件完整字段规格（v1 渲染器实现口径）

> 本文件是 SKILL.md 的细则附录：SKILL.md 列了组件清单与高频速记，这里给**每个组件的全部字段**。
> 写复杂组件（table/chart/plot/交互表单）前读对应小节。所有字段都是 JSON；标 ? 的可省略。
> 注意：本渲染器是 genui 的适配子集，未列出的字段/组件不支持（写了会被忽略或校验拒绝）。

## 布局

- **text**：`{"type":"text","content":"…","size":"h1|h2|h3|body|muted|caption"?,"center":true?}`
- **row / col**：`{"type":"row|col","items":[…],"gap":n?,"wrap":true?(row),"spacer":true?(两端对齐)}`
- **grid**：`{"type":"grid","cols":2,"items":[…]}`；子节点可加 `"span":2` 占多列（bento 排版）
- **card**：`{"type":"card","title":"…"?,"items":[…],"accent":"#hex"?(边框+标题色),"tone":"success|warning|danger|info|accent"?(极淡底色)}`
- **hero**：封面块，一条回答最多一个、放最前。`{"type":"hero","title":"…","subtitle":"…"?,"value":"99.9%"?,"label":"小标签"?,"delta":"+0.2%"?,"tone":"accent|success|warning|danger"?}`
- **divider / spacer**：`{"type":"divider"}` / `{"type":"spacer"}`

## 展示

- **stat**：`{"type":"stat","label":"…","value":"…","delta":"+12%"?,"spark":[3,5,4,8]?,"size":"hero"?}`（delta：+开头自动红、-开头自动绿——中国股市惯例；spark 2-60 个数字画迷你趋势线）
- **badge**：`{"type":"badge","label":"…","tone":"success|warn|danger|accent"?,"icon":"emoji"?}`
- **progress**：`{"type":"progress","label":"…"?,"value":0-100,"valueLabel":"70%"?,"variant":"ring"?}`
- **list**：`{"type":"list","items":["纯字符串" | {"title":"…","desc":"…"?} | 任意组件节点, …]}`
- **keyvalue**：`{"type":"keyvalue","pairs":[{"key":"课程","value":"线性代数"},…]}`
- **avatar**：`{"type":"avatar","name":"张三","color":"#hex"?}`（取首字圆形徽章）
- **timeline**：`{"type":"timeline","items":[{"title":"…","desc":"…"?,"time":"3月12日"?},…]}`（纵向时间轴）
- **steps**：`{"type":"steps","current":1,"steps":[{"title":"…","desc":"…"?},…]}`（0 起算当前步；之前步骤自动打勾）
- **callout**：`{"type":"callout","tone":"info|success|warning|error","title":"…"?,"content":"…"}`
- **file-tree**：`{"type":"file-tree","items":[{"name":"src","type":"dir","children":[…]?},{"name":"a.ts","type":"file"},…]}`（目录可点击折叠）
- **breadcrumb**：`{"type":"breadcrumb","items":["首页","设置","账户"]}`（最后一项加粗）
- **diff**：`{"type":"diff","diffs":[{"path":"a.ts","oldText":"旧行\n…","newText":"新行\n…"},…]}`
- **json**：`{"type":"json","value":{…任意 JSON…}}`（格式化代码视图）
- **code**：`{"type":"code","lang":"ts"?,"code":"…"}`
- **table**（功能最全，细看）：
  ```json
  {"type":"table","columns":["项目","数值","环比"],
   "rows":[["A","1,200","+8%"],["B","980","-3%"]],
   "types":["text","num","delta"]?,          // 列型：num右对齐 | delta涨跌色 | bar | badge | spark("3,5,4"格式) | group(首列分组标题)
   "details":[null,{"type":"text","content":"A 行明细"}]?,  // 与 rows 同序；非 null 的行首出现展开箭头
   "total":true?,                             // 追加合计行（纯数值列自动求和）
   "export":true?,                            // 顶部出现 复制Markdown/复制CSV 按钮
   "filter":true?}                            // 顶部出现筛选框，输入即时过滤（本地）
  ```
  表头点击排序（升/降/还原，本地）；千分位/万/亿/k/%/货币符都能按真实数值比较；`+x%` 自动红、`-x` 自动绿。

## 图表（配色自动跟随深浅主题——不要写死颜色）

- **chart**：`{"type":"chart","kind":"bars|line|donut"?,"title":"…"?,"data":[{"label":"…","value":n,"color":"#hex"?},…],"series":[{"label":"…","data":[n,…]},…]?,"horizontal":true?(横向柱,排行用),"stacked":true?(堆叠)}`
  - 有 series 时：bars=分组柱、line=多序列折线；donut 用 data。≤8 点快速对比首选。
  - `palette:["#…",…]`? 仅在语义需要时给（如"成本必须红"），否则跟随主题色板。
- **plot**（数学函数图 + 参数滑块，本地实时重绘）：
  ```json
  {"type":"plot","title":"…"?,"xMin":-6.28?,"xMax":6.28?,
   "series":[{"expr":"a*sin(b*x)","label":"正弦"?,"color":"#hex"?,
     "params":[{"name":"a","value":1,"min":0,"max":5},
               {"name":"b","value":1,"min":0.5,"max":5}]}]}
  ```
  表达式支持：`+ - * / ^ ()`、sin cos tan asin acos atan sqrt cbrt exp log(以10为底) ln abs floor ceil round min max pow、常量 pi e tau、变量 x 与参数名。其余字母=参数（params 声明）。
- **echart**：`{"type":"echart","preset":"bar|line|area|pie|scatter|funnel|treemap","data":[…],"series":[…]?,"title":"…"?}`——preset 映射到内置 chart 渲染（本应用无 ECharts 引擎）；**full option 不支持**，需要复杂图表改用 chart/plot。

## 交互（本地优先：能本地做的不发往返）

带 `action` 的组件被操作后，界面把 `[genui-action] {"action":"…","value":…,"id":…}` 作为用户消息回传给你（运行中会作为插话注入）。**不带 action 的 button 渲染为禁用态**——交互必须明确要模型做什么才给 action。

- **button**：`{"type":"button","label":"…","tone":"primary|danger|success|ghost"?,"action":"…","full":true?,"small":true?,"icon":"emoji"?}`
- **input**：`{"type":"input","label":"…"?,"placeholder":"…"?,"inputType":"text|email|color"?,"value":"…"?,"action":"…"?,"id":"field-id"?}`（失焦且值变化/回车触发；带 id 的值会被 submit 收集进 fields）
- **textarea**：同 input，`rows:n?`；Ctrl/Cmd+Enter 触发
- **select**：`{"type":"select","label":"…"?,"options":["a","b"],"action":"…"?,"id":"…"?}`（缺省显示"请选择…"，不预选）
- **slider**：`{"type":"slider","label":"…"?,"min":0,"max":100,"step":1?,"value":n?,"action":"…"?,"id":"…"?}`（松手触发）
- **switch**：`{"type":"switch","label":"…","checked":true?,"action":"…"?}`
- **checkbox**：`{"type":"checkbox","label":"…","checked":true?,"action":"…"?,"group":"组名"?}`——有 group：勾选只本地记录，不发逐次 action，等 submit 聚合
- **radio**：`{"type":"radio","label":"题目?","options":["A","B","C"],"selected":n?,"action":"…"?,"group":"q1"?,"answer":1?,"explanation":"解析"?}`
  - 无 group：点选即发 action；带 answer+explanation 时**本地即时判卷**（对错+解析当场显示）
  - 有 group：只本地记录，交给 submit（卷子模式）
- **submit**：`{"type":"submit","label":"交卷"?,"action":"grade"?,"groups":["q1","q2","styles"]}`——groups 里每个 radio 已选、每个 checkbox 组至少一项才能点；一次把 `{answers:{q1:"B",styles:["a","c"]},fields:{id:值}}` 发给模型
- **tabs**：`{"type":"tabs","tabs":[{"label":"…","items":[…组件]},…]}`
- **accordion**：`{"type":"accordion","items":[{"title":"…","items":[…]},…]}`（默认展开第一项）
- **copy**：`{"type":"copy","label":"复制"?,"text":"…"}`（本地剪贴板）
- **link**：`{"type":"link","label":"…","href":"https://…"}`（仅 http(s)/mailto，点击走系统浏览器）

## 不支持清单（写了会被校验拒绝或降级，别用）

mermaid、3D 场景、image/audio/video 媒体组件、ECharts full option、状态持久化（刷新后表单值不保留）。
