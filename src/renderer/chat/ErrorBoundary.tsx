// 渲染层错误边界：
// 任何渲染期异常不再白屏——显示可读错误 + 一键重新加载；异常详情 console.error 供 devtools 排查。
// 已知历史根因（TodoCard selector 不稳定引用致整树卸载， 修复）即此类崩溃。

import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

class ChatErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }): void {
    // devtools console 留全量堆栈（生产不弹窗不打断，仅本边界兜底展示）
    console.error('[ChatErrorBoundary] 渲染异常捕获：', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 14,
            height: '100%',
            padding: 40,
            fontSize: 13,
            color: '#6b5560'
          }}
        >
          <div style={{ fontSize: 30 }}>🌸</div>
          <div style={{ fontWeight: 600 }}>页面出了点小问题，已停止渲染以保护数据</div>
          <div
            style={{
              maxWidth: 560,
              maxHeight: 120,
              overflow: 'auto',
              padding: '8px 12px',
              borderRadius: 8,
              background: 'rgba(236, 107, 160, 0.08)',
              fontFamily: 'ui-monospace, Consolas, monospace',
              fontSize: 11,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              color: '#a3707f'
            }}
          >
            {this.state.error.message}
          </div>
          <button
            type="button"
            onClick={() => {
              this.setState({ error: null })
              window.location.reload()
            }}
            style={{
              padding: '8px 22px',
              borderRadius: 999,
              border: 'none',
              cursor: 'pointer',
              color: '#fff',
              background: 'linear-gradient(135deg, #ec6ba0, #f0889c)',
              fontSize: 13
            }}
          >
            重新加载
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

export default ChatErrorBoundary
