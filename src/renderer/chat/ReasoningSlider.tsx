// 思考强度滑条（P8-T4，2026-09 按 ChatGPT/Codex 官方 effort selector 1:1 重做观感；
// 参考实现：zanwei/chatgpt-model-selector——对官方控件的逐帧复刻，几何/动效常量均取自它）：
//
// 官方控件长什么样（与我们旧版的差别）：
// - 轨道不是细槽，是一条 **28px 粗胶囊**；填充与轨道同高，实心主题色；
// - 刻度只是轨道里 **5px 的小灰点**，且被填充段盖住（填充段里看不见点），
//   不再和拇指重叠成"靶眼"；
// - 拇指是 **34px 纯白圆钮**，只靠柔和投影浮在轨道上（无描边、无光晕），
//   拖动只放大到 1.06；松手用 380ms 单过冲弹簧吸到最近刻度；
// - 填充里始终有一条白色粒子"能量流"（稀疏白点向左匀速流动 + 原地明灭）；
// - 顶档（极致）填充淡入粉→紫渐变；旋钮**落定瞬间**从边缘爆开一圈珠粒（~0.25s 消散），
//   一次拖动只庆祝一次，reduced-motion 下全关。
//
// 交互：整条都能拖（不必精确按住圆钮）；下面一排档位名可直接点选；键盘 ←→/Home/End。
// 只做展示与回调：「写回哪个档案、何时生效」由调用方负责（档位只影响后续请求）。

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReasoningEffort } from '@shared/types'
import { REASONING_LABELS } from '@shared/reasoning'

/* —— 几何（px，与官方参考一致，别随手改成"好看"的比例）—— */
const KNOB = 34 // 圆钮直径
const SNAP_MS = 380 // 松手吸附弹簧时长
const BURST_MX = 32 // 庆祝画布向轨道两侧多留的飞行空间
const BURST_MY = 40

/** 系统「减少动态效果」：粒子只画一帧静态、珠粒与弹簧全免 */
function useReducedMotion(): boolean {
  const [query] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)'))
  const [reduced, setReduced] = useState(query.matches)
  useEffect(() => {
    const onChange = (): void => setReduced(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [query])
  return reduced
}

function ReasoningSlider({
  levels,
  value,
  onChange,
  hintOf,
  model
}: {
  /** 可选档位（按强度升序；来自档案 reasoningLevels，至少一个） */
  levels: ReasoningEffort[]
  /** 当前档位；不在 levels 里时回退首项 */
  value: ReasoningEffort | undefined
  onChange: (level: ReasoningEffort) => void
  /** 附加说明（如预算 tokens），跟在「模型名 · 档位」之后；缺省不占位 */
  hintOf?: (level: ReasoningEffort) => string
  /** 当前模型名（与当前档位组成一行，如「qwen3.8-flash · 极致」）；空模型只显示档位 */
  model?: string
}): React.JSX.Element {
  const reducedMotion = useReducedMotion()

  const rowRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const knobRef = useRef<HTMLDivElement>(null)
  const sparkRef = useRef<HTMLCanvasElement>(null)
  const burstRef = useRef<HTMLCanvasElement>(null)

  const count = levels.length
  const last = Math.max(0, count - 1)
  const idx = Math.max(0, levels.indexOf(value ?? levels[0] ?? 'medium'))
  const current = levels[idx]
  // 'default' 这一档说全「自动（不注入）」，否则用户分不清"自动"与"低"。
  const label = current === 'default' ? '自动（不注入）' : REASONING_LABELS[current]
  const hint = hintOf !== undefined ? hintOf(current) : ''

  const [dragging, setDragging] = useState(false)
  /** 松手/点选后圆钮正在弹簧吸附：此期间开过渡，落定即关（拖动中必须无过渡才跟手） */
  const [snapping, setSnapping] = useState(false)
  /** 拖动中手指位置（0..1）；非拖动时为 null，圆钮位置直接由 value 派生——
      这样外部改档（设置页等）不需要任何同步 effect，位置永远跟 props 一致 */
  const [dragPos, setDragPos] = useState<number | null>(null)
  /** 拖动中实时预览到的档（松手前 value 还没变，标题/高亮也要跟手） */
  const [preview, setPreview] = useState<number | null>(null)
  const pos = dragging && dragPos !== null ? dragPos : last === 0 ? 0 : idx / last
  const displayIdx = dragging && preview !== null ? preview : idx
  const displayPeak = displayIdx === last && last > 0
  const displayLevel = levels[displayIdx] ?? current
  const displayLabel =
    displayLevel === 'default' ? '自动（不注入）' : (REASONING_LABELS[displayLevel] ?? label)
  const displayHint =
    hintOf !== undefined && displayLevel !== undefined ? hintOf(displayLevel) : hint

  const snapTimer = useRef<number | undefined>(undefined)
  const pendingBurst = useRef(false) // 弹簧落定后再爆珠（在档上松手则立即爆）
  /** 本次拖动手势是否已庆祝过顶档（官方口径：每次按下重新计数，最多一次） */
  const burstFiredThisGesture = useRef(false)
  const lastBurstAt = useRef(0)

  useEffect(() => () => window.clearTimeout(snapTimer.current), [])

  /* ───────────────────────── 粒子"能量流"（填充内白点） ─────────────────────────
     逐帧算法取自官方复刻：白点沿轨道匀速左漂、出界回右侧；亮度是平方正弦——
     大部分时间很暗、短暂"啵"地亮起。画布按整条轨道铺底，由 fill 的 overflow 裁切，
     所以填充向右扩张时粒子已经等在那里，不用补种。 */
  useEffect(() => {
    const track = trackRef.current
    const canvas = sparkRef.current
    if (!track || !canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let w = 0
    let h = 0
    let raf = 0
    let particles: {
      x: number
      y: number
      r: number
      phase: number
      twinkle: number
      flow: number
    }[] = []

    const seed = (): void => {
      const n = Math.max(6, Math.round(w / 24))
      particles = Array.from({ length: n }, () => ({
        x: Math.random() * w,
        y: 4 + Math.random() * (h - 8),
        r: 0.8 + Math.random() * 0.9,
        phase: Math.random() * Math.PI * 2,
        twinkle: 2.5 + Math.random() * 4.5,
        flow: 85 + Math.random() * 50
      }))
    }

    const resize = (): void => {
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const cw = track.clientWidth
      const ch = track.clientHeight
      if (!cw || !ch || (cw === w && ch === h)) return
      w = cw
      h = ch
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      seed()
    }

    /** 静态一帧：各粒子用自己的相位，亮度有别但不动（reduced-motion） */
    const drawStatic = (): void => {
      ctx.clearRect(0, 0, w, h)
      ctx.fillStyle = '#ffffff'
      for (const p of particles) {
        const s = 0.5 + 0.5 * Math.sin(p.phase * 3)
        ctx.globalAlpha = 0.06 + 0.74 * s * s
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalAlpha = 1
    }

    let lastT = performance.now()
    /** 正式循环（dt 限幅，掉帧时粒子也不会瞬移） */
    const frame = (tNow: number): void => {
      const dt = Math.min(0.032, Math.max(0, (tNow - lastT) / 1000))
      lastT = tNow
      ctx.clearRect(0, 0, w, h)
      ctx.fillStyle = '#ffffff'
      for (const p of particles) {
        p.x -= p.flow * dt
        if (p.x < -3) p.x += w + 6
        const s = 0.5 + 0.5 * Math.sin((tNow / 1000) * p.twinkle + p.phase)
        ctx.globalAlpha = 0.06 + 0.74 * s * s
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalAlpha = 1
      raf = requestAnimationFrame(frame)
    }

    const paint = (): void => {
      cancelAnimationFrame(raf) // RO 可能多次触发，避免叠出多个循环
      if (reducedMotion) drawStatic()
      else {
        lastT = performance.now()
        raf = requestAnimationFrame(frame)
      }
    }

    resize()
    paint()
    // 面板初始宽可能还没布局出来；尺寸变化后补种并重绘
    const ro = new ResizeObserver(() => {
      resize()
      paint()
    })
    ro.observe(track)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [reducedMotion])

  /* ───────────────────────── 顶档珠粒庆祝 ─────────────────────────
     14 颗珠在旋钮边缘成环爆开，指数衰减、轻微上提、~0.25s 消散；没有重力和彩纸。 */
  const fireBurst = useCallback((): void => {
    if (reducedMotion) return
    const now = performance.now()
    if (now - lastBurstAt.current < 350) return // 快速来回切档不刷屏
    lastBurstAt.current = now

    const row = rowRef.current
    const canvas = burstRef.current
    if (!row || !canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const rowEl = row
    const sw = rowEl.clientWidth
    if (!sw) return
    const sh = rowEl.clientHeight

    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const cw = sw + BURST_MX * 2
    const ch = sh + BURST_MY * 2
    canvas.width = Math.round(cw * dpr)
    canvas.height = Math.round(ch * dpr)
    canvas.style.width = `${cw}px`
    canvas.style.height = `${ch}px`
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    // 珠色从 CSS 变量取（深浅主题各一套），别在 JS 里写死
    const styles = getComputedStyle(rowEl)
    const beadColors = [
      styles.getPropertyValue('--rslider-bead-a').trim() || '#f7b6d6',
      styles.getPropertyValue('--rslider-bead-b').trim() || '#e7a5f0',
      styles.getPropertyValue('--rslider-bead-c').trim() || '#f9c6e0',
      styles.getPropertyValue('--rslider-bead-d').trim() || '#c9b0f0'
    ]

    // 旋钮圆心：读实时 computed left（弹簧可能还在飞），画布比行多留了 MX/MY 边距
    const liveLeft = knobRef.current ? parseFloat(getComputedStyle(knobRef.current).left) : NaN
    const cx = (Number.isFinite(liveLeft) ? liveLeft : KNOB / 2 + pos * (sw - KNOB)) + BURST_MX
    const cy = sh / 2 + BURST_MY
    type Bead = {
      x: number
      y: number
      vx: number
      vy: number
      size: number
      life: number
      ttl: number
      color: string
    }
    const beads: Bead[] = []
    const N = 14
    for (let i = 0; i < N; i += 1) {
      const ang = (i / N) * Math.PI * 2 + (Math.random() - 0.5) * 0.35
      const speed = 105 + Math.random() * 45
      beads.push({
        x: cx + Math.cos(ang) * (KNOB / 2),
        y: cy + Math.sin(ang) * (KNOB / 2),
        vx: Math.cos(ang) * speed,
        vy: Math.sin(ang) * speed - 25,
        size: 4.5 + Math.random() * 1,
        life: 0,
        ttl: 0.2 + Math.random() * 0.08,
        color: beadColors[i % beadColors.length]
      })
    }

    let lastT = now
    const tick = (t: number): void => {
      const dt = Math.min(0.032, Math.max(0, (t - lastT) / 1000))
      lastT = t
      ctx.clearRect(0, 0, cw, ch)
      for (let i = beads.length - 1; i >= 0; i -= 1) {
        const p = beads[i]
        p.life += dt
        if (p.life >= p.ttl) {
          beads.splice(i, 1)
          continue
        }
        const damp = Math.exp(-6 * dt)
        p.vx *= damp
        p.vy = p.vy * damp - 20 * dt
        p.x += p.vx * dt
        p.y += p.vy * dt
        const k = p.life / p.ttl
        ctx.globalAlpha = Math.pow(1 - k, 1.5)
        ctx.fillStyle = p.color
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.size / 2, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalAlpha = 1
      // 珠粒全部消散即自停，无需在外层保存 raf 句柄
      if (beads.length > 0) requestAnimationFrame(tick)
      else ctx.clearRect(0, 0, cw, ch)
    }
    requestAnimationFrame(tick)

    // 旋钮同步一个极轻的脉动（调用点都在松手/落定后，350ms 节流也保证不会连发）
    knobRef.current?.animate([{ scale: '1' }, { scale: '1.06' }, { scale: '1' }], {
      duration: 180,
      easing: 'cubic-bezier(0.32, 0.72, 0, 1)'
    })
  }, [pos, reducedMotion])

  /* 弹簧结束（或 460ms 兜底）：关掉过渡类，补发庆祝 */
  const finishSnap = useCallback((): void => {
    window.clearTimeout(snapTimer.current)
    setSnapping(false)
    if (pendingBurst.current) {
      pendingBurst.current = false
      fireBurst()
    }
  }, [fireBurst])

  /* ───────────────────────── 拖拽（整条命中，几何算法同官方） ───────────────────────── */
  const fracFromX = useCallback((clientX: number): number => {
    const track = trackRef.current
    if (!track) return 0
    const rect = track.getBoundingClientRect()
    const span = rect.width - KNOB
    if (span <= 0) return 0
    return Math.min(1, Math.max(0, (clientX - rect.left - KNOB / 2) / span))
  }, [])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    setSnapping(false)
    pendingBurst.current = false
    burstFiredThisGesture.current = false
    setDragging(true)
    // 真实环境捕获指针（拖到圆钮外也不丢事件）；合成事件/极端环境捕获可能抛错，忽略即可
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* no-op */
    }
    const f = fracFromX(e.clientX)
    setDragPos(f)
    const n = last === 0 ? 0 : Math.round(f * last)
    setPreview(n)
    if (n !== idx) onChange(levels[n])
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragging) return
    const f = fracFromX(e.clientX)
    setDragPos(f)
    const n = last === 0 ? 0 : Math.round(f * last)
    if (n !== preview) {
      setPreview(n)
      if (n !== idx) onChange(levels[n])
    }
  }

  const endDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragging) return
    const f = fracFromX(e.clientX)
    const target = last === 0 ? 0 : Math.round(f * last)
    setDragging(false)
    setPreview(null)
    setDragPos(null) // 松手后位置回归派生值（乐观更新已让 idx=target），由 snap 过渡吸过去
    if (!reducedMotion) {
      setSnapping(true)
      // 在档上直接松手没有过渡会自然结束 transitionend；靠 460ms 兜底收尾
      window.clearTimeout(snapTimer.current)
      snapTimer.current = window.setTimeout(finishSnap, SNAP_MS + 80)
    }
    // 落定在顶档：每次手势最多庆祝一次（在档上松手立刻爆，否则等弹簧落定）
    if (target === last && last > 0 && !burstFiredThisGesture.current) {
      burstFiredThisGesture.current = true
      if (!reducedMotion) {
        if (Math.abs(f - target / last) < 0.001) fireBurst()
        else pendingBurst.current = true
      }
    }
  }

  /* 点选/键盘：乐观更新让 pos 派生到新档，同批次开 snap 让圆钮弹过去；顶档落定爆珠 */
  const commit = useCallback(
    (i: number): void => {
      const n = Math.min(last, Math.max(0, i))
      if (n === idx) return
      setDragPos(null)
      setPreview(null)
      onChange(levels[n])
      if (!reducedMotion) {
        pendingBurst.current = n === last && last > 0
        setSnapping(true)
        window.clearTimeout(snapTimer.current)
        snapTimer.current = window.setTimeout(finishSnap, SNAP_MS + 80)
      }
    },
    [finishSnap, idx, last, levels, onChange, reducedMotion]
  )

  const onKnobTransitionEnd = (e: React.TransitionEvent<HTMLDivElement>): void => {
    // left 走完说明弹簧落定；width 可能稍早/稍晚，统一只听 left，460ms 定时器兜底
    if (e.propertyName === 'left') finishSnap()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    let n: number | null = null
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') n = displayIdx - 1
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') n = displayIdx + 1
    else if (e.key === 'Home') n = 0
    else if (e.key === 'End') n = last
    if (n === null) return
    e.preventDefault()
    e.stopPropagation()
    commit(n)
  }

  const rootClass = [
    'rslider',
    dragging ? 'dragging' : '',
    snapping ? 'snap' : '',
    displayPeak ? 'peak' : ''
  ]
    .filter(Boolean)
    .join(' ')

  // 圆钮/填充的定位：两端圆心距轨道边各 17px（圆钮正好贴着胶囊端）
  const knobLeft = `calc(${KNOB / 2}px + ${pos} * (100% - ${KNOB}px))`
  const fillWidth = `calc(${KNOB}px + ${pos} * (100% - ${KNOB}px))`

  const modelName = model?.trim() ?? ''

  return (
    <div className={rootClass}>
      <div className={`rslider-caption${displayPeak ? ' peak' : ''}`}>
        {modelName !== '' ? <span className="rslider-cap-model">{modelName}</span> : null}
        <span className="rslider-cap-name">{displayLabel}</span>
        {displayHint ? <span className="rslider-cap-hint">{displayHint}</span> : null}
      </div>

      <div
        ref={rowRef}
        className="rslider-row"
        role="slider"
        aria-label="思考强度"
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={last}
        aria-valuenow={displayIdx}
        aria-valuetext={displayLabel}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
      >
        <div ref={trackRef} className="rslider-track" aria-hidden="true">
          <div className="rslider-ticks">
            {levels.map((level, i) => (
              <span
                key={level}
                className="rslider-tick"
                style={{
                  left: `calc(${KNOB / 2}px + ${last === 0 ? 0 : i / last} * (100% - ${KNOB}px))`
                }}
              />
            ))}
          </div>
          <div className="rslider-fill" style={{ width: fillWidth }}>
            <span className="rslider-ultra" />
            <canvas ref={sparkRef} className="rslider-spark" />
          </div>
        </div>
        <div
          ref={knobRef}
          className="rslider-knob"
          style={{ left: knobLeft }}
          onTransitionEnd={onKnobTransitionEnd}
        />
        <canvas ref={burstRef} className="rslider-burst" aria-hidden="true" />
      </div>

      <div className="rslider-scale">
        {levels.map((level, i) => (
          <button
            type="button"
            key={level}
            className={i === displayIdx ? 'rslider-scale-item on' : 'rslider-scale-item'}
            aria-pressed={i === displayIdx}
            tabIndex={-1}
            onClick={() => commit(i)}
          >
            {REASONING_LABELS[level]}
          </button>
        ))}
      </div>
    </div>
  )
}

export default ReasoningSlider
