// 长期记忆的隐私开关。
//
// 背景：`privacy.memory` 此前只管两件事——对话后的**自动提炼**（run.ts）与召回注入。
// 但模型手里的 `memory_save` / `memory_search` 两个工具**一直挂在注册表里**，
// 于是用户明明关着开关，说一句"记住我明天九点提醒你看报告"，她就调 memory_save 写进
// 了记忆库（设置页显示"已记住 1 条"，用户看着莫名其妙）。
//
// 口径对齐 active_window（screen.ts）：**开关关闭 = 工具不进 LLM 注册表**——
// 没有工具就没有"偷偷记下"的路径；已有记忆保留不删（设置页原话：关闭只是暂停）。
// 本模块零依赖（不 import electron），供 registry / index / settings-ipc 共用。

let enabled = false

/** 隐私开关（主进程持有；启动读配置、设置页保存后即时同步） */
export function setMemoryEnabled(value: boolean): void {
  enabled = value
}

export function isMemoryEnabled(): boolean {
  return enabled
}
