/**
 * 应用品牌（单一事实源）：应用名只在这里定义一次，其余 UI / 主进程 / 打包配置都从它取。
 *
 * 定名 **Aemeath Agent**。
 * 用法约定：
 * - 用户可见的「应用名」一律用 APP_NAME（窗口标题、关于页、退出菜单、桌面快捷方式）；
 * - 发给第三方服务的 client 标识才用 APP_ID（MCP initialize 的 clientInfo.name）——
 * 保持稳定的英文小写 slug，方便对方做统计，也避免改中文名时反复动协议字段。
 */
export const APP_NAME = 'Aemeath Agent'
/** 程序标识（MCP clientInfo 等协议字段用；小写 slug，不随展示名变动） */
export const APP_ID = 'aemeath-agent'
