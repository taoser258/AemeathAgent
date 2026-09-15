/**
 * 版本（单一事实源）：关于页「当前阶段」、设置页侧栏底部都从这里取。
 *
 * ★ 版本号不在这里手写——直接从 package.json 读，改版本只改一处。
 * 此前 APP_VERSION 是写死的常量，与 package.json 各改各的 → 必然脱节。
 * 现在打包版与 dev 版都从同一份 package.json 取值。
 * 阶段名不再上界面：开发阶段是过程信息，用户看版本号就够。
 */
import pkg from '../../package.json'
import { APP_NAME } from './brand'

export const APP_VERSION = pkg.version as string
/** 关于页「当前阶段」行的右侧值（只留应用名 + 版本号） */
export const APP_STAGE_LABEL = `${APP_NAME} v${APP_VERSION}`
/** 设置页侧栏底部的小字 */
export const APP_FOOTER_LABEL = `${APP_NAME} v${APP_VERSION}`
