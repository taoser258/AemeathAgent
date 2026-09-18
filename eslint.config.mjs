import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

export default defineConfig(
  // release*/ 是 electron-builder 的解包产物（win-unpacked 内 ~100 个打包后的 JS），
  // .gitignore 早有 release*/ 但 eslint 的 ignores 漏了——全量 lint 会把它们也扫一遍，
  // 实测平白慢十倍以上（owner 反馈"lint 等半天"的第二成因，第一是后台孤儿进程）。
  { ignores: ['**/node_modules', '**/dist', '**/out', '**/electron.vite.config.*.mjs', 'release*/'] },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules,
      // 全仓库约定：故意不用的参数/变量以 `_` 前缀命名（如 ipcMain 回调的 _event）
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ]
    }
  },
  eslintConfigPrettier,
  // @electron-toolkit/eslint-config-ts 本意是给纯 JS 脚本关掉 explicit-function-return-type，
  // 但它写的是 `files: ['*.js', '*.mjs']` —— 扁平配置里 `*` 不跨目录，scripts/ 下的 .mjs
  // 仍被要求写返回类型（纯 JS 根本写不了 TS 注解）。这里补一条能覆盖子目录的同义豁免。
  {
    files: ['**/*.{js,mjs,cjs}'],
    rules: { '@typescript-eslint/explicit-function-return-type': 'off' }
  }
)
