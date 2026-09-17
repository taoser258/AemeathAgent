// Markdown 渲染：remark-gfm（表格/删除线等）+ remark-math（$...$ 解析为数学节点，
// rehype-katex 的前置必备件）+ rehype-highlight（代码高亮）+ rehype-katex（公式渲染）。
// 流式期间允许整段重渲染。
// 配色全部走 CSS 变量，不引入 highlight.js 现成主题。

import { memo, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import { GenuiBlock } from './genui/GenuiView'
import { useChatStore } from './store'

/** 从 React 子树里抠出纯文本（供复制按钮用，不参与渲染） */
function extractText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (typeof node === 'object' && 'props' in node) {
    return extractText((node.props as { children?: ReactNode }).children)
  }
  return ''
}

/** 代码块：语言标签 + 一键复制（验收条目：代码块可复制）。
 * language=genui 的围栏交给 genui 渲染器画成真实组件（解析失败自动降级回代码块）。 */
function CodeBlock({
  children,
  streaming
}: {
  children?: ReactNode
  streaming: boolean
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const child = Array.isArray(children) ? children[0] : children
  const className =
    typeof child === 'object' && child !== null && 'props' in child
      ? ((child.props as { className?: string }).className ?? '')
      : ''
  const language = /language-([\w-]+)/.exec(className)?.[1] ?? 'text'
  const code = extractText(children)

  if (language === 'genui') return <GenuiBlock code={code} streaming={streaming} />

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      // 剪贴板不可用（如无授权）时静默失败，不打断阅读
    }
  }

  return (
    <div className="code-block">
      <div className="code-block-bar">
        <span className="code-block-lang">{language}</span>
        <button type="button" className="code-block-copy" onClick={() => void copy()}>
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      {/* children 是 rehype-highlight 产出高亮 span 的 <code> 元素，原样渲染保住配色 */}
      <pre>{children}</pre>
    </div>
  )
}

/**
 * 链接：统一拦截到右侧栏内置浏览器打开。
 * 不拦截就会在 Electron 当前窗口直接跳转、覆盖整个应用且退不回来（实测事故）。
 * 中键/Ctrl 点击也拦下（默认行为同样是窗口导航）；要系统浏览器可在侧栏里点 ↗。
 */
function ExtLink(props: { href?: string; children?: ReactNode }): React.JSX.Element {
  const openRightLink = useChatStore((s) => s.openRightLink)
  const href = props.href ?? ''
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault()
        if (href !== '') openRightLink(href)
      }}
    >
      {props.children}
    </a>
  )
}

/** streaming：本轮消息是否仍在流式生成（genui 围栏半截 JSON 时据此显示占位而非报错降级） */
function Markdown({
  content,
  streaming = false
}: {
  content: string
  streaming?: boolean
}): React.JSX.Element {
  const Pre = (props: { children?: ReactNode }): React.JSX.Element => (
    <CodeBlock {...props} streaming={streaming} />
  )
  return (
    <div className="chat-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeHighlight, rehypeKatex]}
        components={{ pre: Pre, a: ExtLink }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

export default memo(Markdown)
