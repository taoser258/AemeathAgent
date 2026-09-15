// 右键编辑菜单：选中文字后右键没有"复制 / 全选"等选项。
// 根因：Electron 默认不提供右键菜单——不自己挂 'context-menu' 就只有一片空白。
//
// 设计取舍（重要，别改回去）：
// - **只在"有选中文字"或"目标可编辑"时才弹原生菜单**。侧栏会话项、消息气泡等位置
// 已各有自己的渲染层右键菜单（React 自绘，如 SessionSidebar 的 重命名/隐藏/删除/置顶），
// 若不设条件就会与原生菜单同时弹出、两层菜单打架。
// - 桌宠窗不挂这里：它走自己的自定义菜单（WIN_SHOW_PET_MENU → popupPetMenu），
// 挂了会与之重复。
// - 复制/剪切/粘贴/删除用 role 而非手写实现：交给 Chromium 走真实编辑命令，
// 输入框的撤销栈、富文本选区等行为才正确。

import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'

/**
 * 给窗口挂上"按情境生成"的右键编辑菜单。
 * 在窗口创建后调用一次即可（webContents 存活期内持续有效）。
 */
export function attachEditContextMenu(win: BrowserWindow): void {
  win.webContents.on('context-menu', (_event, params) => {
    const hasSelection = params.selectionText.trim() !== ''
    // 非编辑器 + 无选中 → 不弹原生菜单，把右键让给渲染层自绘菜单（侧栏/气泡等）
    if (!params.isEditable && !hasSelection) return

    const items: MenuItemConstructorOptions[] = []

    if (params.isEditable && params.editFlags.canCut) items.push({ role: 'cut', label: '剪切' })
    if (hasSelection) items.push({ role: 'copy', label: '复制' })
    if (params.isEditable && params.editFlags.canPaste) items.push({ role: 'paste', label: '粘贴' })
    if (params.isEditable && params.editFlags.canDelete) {
      items.push({ role: 'delete', label: '删除' })
    }

    // 全选永远可用：只读内容里"选中一段再复制"是最常见的诉求
    if (items.length > 0) items.push({ type: 'separator' })
    items.push({ role: 'selectAll', label: '全选' })

    Menu.buildFromTemplate(items).popup({ window: win })
  })
}
