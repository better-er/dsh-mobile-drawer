/**
 * dsh-mobile-drawer 的浏览器半身。
 *
 * 只对窄屏，也就是手机，做四件内置布局没提供的事，宽屏一律不碰：
 * 1. 收起态不再保留 56px 全高图标栏，改成零宽列加左上角一个悬浮方块，点方块展开；
 * 2. 在展开的侧栏里点会话行，自动收起侧栏，把屏幕让回对话；
 * 3. 切会话后输入框会无条件夺回焦点，手机上这会弹出软键盘并把页面顶起，这里把紧随会话点击的那一次聚焦压掉；
 * 4. 输入框工具行补一排手机键盘上没有的键，见 ./keys.tsx。
 *
 * 前三条走 DOM：内置布局没有面向插件的窄屏幂等收起入口，也没有会话切换广播。
 * 与其重写 AppFrame 外壳，不如在客户端半身做副作用，卸载时全部撤销。
 *
 * @module dsh-mobile-drawer/client
 */

import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'
import { applyKeys } from './keys'
import type { KeysContext } from './keys'

/** 插件名，同时也是配置项 id。 */
export const name = 'dsh-mobile-drawer'

/** 本插件需要的客户端服务：借布局控制器翻转窄屏侧栏，借 slots 往工具行加键位组。 */
export const inject = ['layout', 'slots']

/** 与 ui-layout 的 SIDEBAR_AUTO_COLLAPSE 对齐：视口小于 1024 像素视为窄屏。 */
const NARROW_QUERY = '(max-width: 1023.98px)'

/** 会话行点击后等待自动聚焦的最长时间，超时即认为用户想自己输入。 */
const FOCUS_SUPPRESS_MS = 1500

/** 悬浮方块按钮的类名。 */
const FAB_CLASS = 'dsh-mobile-drawer-fab'

/** 方块的边长，与样式里的宽高一致，算停靠坐标要用。 */
const FAB_SIZE = 44

/** 方块离视口边缘的基准距离，与安全区叠加。 */
const FAB_GAP = 10

/** 方块中心离两条边都近于这个像素数时吸到角，否则只吸最近的一条边。 */
const CORNER_REACH = 48

/** 手指位移超过这个像素数才算拖动，短于它仍当作点击，避免手抖把方块挪走。 */
const DRAG_THRESHOLD = 8

/** 拖动时方块与视口边缘之间至少留出的像素。 */
const DRAG_EDGE_MARGIN = 4

/** 记住停靠位的本地存储键。 */
const DOCK_KEY = 'dsh-mobile-drawer:fab-dock'

/** 方块可以停靠的位置：四角与四边。 */
type FabDockEdge = 'tl' | 'tr' | 'bl' | 'br' | 'left' | 'right' | 'top' | 'bottom'

/** 停靠位。边停靠时 ratio 是沿边位置的比例，0 到 1；角停靠时不用。 */
interface FabDock {
  readonly edge: FabDockEdge
  readonly ratio: number
}

/** 视口四边的安全区，单位像素。 */
interface ViewInsets {
  readonly top: number
  readonly right: number
  readonly bottom: number
  readonly left: number
}

/** 没存过或存坏时的停靠位：左上角。 */
const DEFAULT_DOCK: FabDock = { edge: 'tl', ratio: 0 }

/** 认识这些停靠边名。 */
function isDockEdge(value: unknown): value is FabDockEdge {
  return value === 'tl' || value === 'tr' || value === 'bl' || value === 'br'
    || value === 'left' || value === 'right' || value === 'top' || value === 'bottom'
}

/** 读上次记住的停靠位；存储不可用或值不认识时回到左上角。 */
function readDock(): FabDock {
  try {
    const raw = window.localStorage.getItem(DOCK_KEY)
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null) {
        const record = parsed as Record<string, unknown>
        if (isDockEdge(record.edge)) {
          const ratio = Number(record.ratio)
          return { edge: record.edge, ratio: Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0 }
        }
      }
    }
  } catch (error) {
    console.warn('[dsh-mobile-drawer] 读不到方块的停靠位，改用左上角：' + String(error))
  }
  return DEFAULT_DOCK
}

/** 记住停靠位；写不进去只影响下次启动的位置。 */
function saveDock(dock: FabDock): void {
  try {
    window.localStorage.setItem(DOCK_KEY, JSON.stringify(dock))
  } catch (error) {
    console.warn('[dsh-mobile-drawer] 存不下方块的停靠位：' + String(error))
  }
}

/** 探一次视口四边的安全区：临时元素上写 env()，再读回计算值。 */
function readInsets(): ViewInsets {
  const probe = document.createElement('div')
  probe.style.cssText = [
    'position: fixed',
    'top: 0',
    'left: 0',
    'width: 0',
    'height: 0',
    'visibility: hidden',
    'padding-top: env(safe-area-inset-top, 0px)',
    'padding-right: env(safe-area-inset-right, 0px)',
    'padding-bottom: env(safe-area-inset-bottom, 0px)',
    'padding-left: env(safe-area-inset-left, 0px)',
  ].join(';')
  document.body.append(probe)
  const style = getComputedStyle(probe)
  const insets: ViewInsets = {
    top: Number.parseFloat(style.paddingTop) || 0,
    right: Number.parseFloat(style.paddingRight) || 0,
    bottom: Number.parseFloat(style.paddingBottom) || 0,
    left: Number.parseFloat(style.paddingLeft) || 0,
  }
  probe.remove()
  return insets
}

/** 挂在 body 上、表示窄屏且侧栏收起、方块该显示的类名。 */
const COLLAPSED_CLASS = 'dsh-mobile-drawer-collapsed'

/** 挂在 body 上、表示窄屏且侧栏以抽屉展开、遮罩该显示的类名。 */
const EXPANDED_CLASS = 'dsh-mobile-drawer-expanded'

/** AppFrame 在侧栏列收起时带上的属性。 */
const COLLAPSED_ATTR = 'data-sidebar-collapsed'

/** 会话行的稳定标记，值形如 session:<id>。 */
const SESSION_ROW_SELECTOR = '[data-row-key^="session:"]'

/**
 * 只在窄屏生效的样式。
 *
 * 收起态把侧栏列压到零宽，中央区拿回整幅宽度；悬浮方块复用主题语义令牌，跟随明暗与圆角规范。
 * 收起态的这些副作用都挂在 body 的收起类上，拿不到内置图标、方块不显示时一并跳过，侧栏保持内置形态，不会出现收起了却没有展开入口的局面。
 */
const STYLE = [
  '@media (max-width: 1023.98px) {',
  '  body:is(.dsh-mobile-drawer-collapsed, .dsh-mobile-drawer-expanded) [data-rightbar-collapsed] {',
  '    grid-template-columns: 0px minmax(0px, 1fr) 0px !important;',
  '  }',
  '  body.dsh-mobile-drawer-collapsed [data-sidebar-collapsed] > div:first-child {',
  '    visibility: hidden;',
  '  }',
  '  body.dsh-mobile-drawer-expanded [data-rightbar-collapsed]:not([data-sidebar-collapsed]) > div:first-child {',
  '    position: relative;',
  '    overflow: visible;',
  '  }',
  '  body.dsh-mobile-drawer-expanded [data-rightbar-collapsed]:not([data-sidebar-collapsed]) [data-slot="sidebar"] > div {',
  '    position: absolute;',
  '    top: 0;',
  '    bottom: 0;',
  '    left: 0;',
  '    width: 280px;',
  '    z-index: 25;',
  '    box-shadow: var(--dsw-elevation-prominent);',
  '  }',
  '}',
  '.dsh-mobile-drawer-scrim {',
  '  position: fixed;',
  '  inset: 0;',
  '  z-index: 24;',
  '  display: none;',
  '  background: rgb(0 0 0 / 0.35);',
  '  -webkit-tap-highlight-color: transparent;',
  '}',
  'body.dsh-mobile-drawer-expanded .dsh-mobile-drawer-scrim {',
  '  display: block;',
  '}',
  '.dsh-mobile-drawer-fab {',
  '  position: fixed;',
  '  top: 0;',
  '  left: 0;',
  '  z-index: 30;',
  '  display: none;',
  '  align-items: center;',
  '  justify-content: center;',
  '  width: 44px;',
  '  height: 44px;',
  '  padding: 0;',
  '  border: 0.5px solid var(--dsw-alias-border-l3);',
  '  border-radius: var(--dsw-radius-md, 12px);',
  '  background: var(--dsw-alias-button-elevated-fill);',
  '  color: var(--dsw-alias-label-primary);',
  '  box-shadow: var(--dsw-elevation-panel);',
  '  cursor: pointer;',
  '  touch-action: none;',
  '  user-select: none;',
  '  -webkit-tap-highlight-color: transparent;',
  '}',
  '.dsh-mobile-drawer-fab.is-dragging {',
  '  cursor: grabbing;',
  '}',
  'body.dsh-mobile-drawer-collapsed .dsh-mobile-drawer-fab {',
  '  display: inline-flex;',
  '}',
  '.dsh-mobile-drawer-fab:active {',
  '  background: var(--dsw-alias-interactive-bg-hover);',
  '}',
  '.dsh-mobile-drawer-fab:focus-visible {',
  '  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));',
  '  outline-offset: 2px;',
  '}',
  '.dsh-mobile-drawer-fab > svg {',
  '  width: 20px;',
  '  height: 20px;',
  '}',
  '',
].join('\n')

/** 客户端上下文里本插件用得到的一小片。 */
interface MobileContext extends KeysContext {
  readonly layout: ILayout
}

/**
 * 挂载窄屏侧栏适配。
 *
 * @param ctx - 客户端根上下文，layout 已就绪。
 */
export function apply(ctx: MobileContext): void {
  ctx.effect(() => {
    const media = window.matchMedia(NARROW_QUERY)
    const style = document.createElement('style')
    style.id = 'dsh-mobile-drawer-style'
    // 必须自带 data-plugin：client 模块系统实例化任何一个插件时，都会把页面上所有没有这个
    // 属性的 <style> 认领给那个插件，它一重载就被 removeOwnedStyles 一并删掉，这里的样式
    // 又会退回浏览器默认，方块与按键条掉进文档流底部。带上属性才不会被人认领。
    style.dataset.plugin = name
    style.dataset.pluginCss = name + '/client.css'
    style.textContent = STYLE
    document.head.append(style)

    const scrim = document.createElement('div')
    scrim.className = 'dsh-mobile-drawer-scrim'
    document.body.append(scrim)

    const fab = document.createElement('button')
    fab.type = 'button'
    fab.className = FAB_CLASS
    fab.setAttribute('aria-label', '展开侧栏，拖动可换位置')
    // 图标只能在克隆到内置标记后填入；拿不到就不显示这个方块。
    document.body.append(fab)

    /** 已应用到方块上的图标标记，避免每次更新都重建 SVG。 */
    let appliedIcon: string | undefined
    /** 从内置 rail 克隆到的一次图标标记，拿到后固定不再查。 */
    let builtinIcon: string | undefined
    /** 会话点击后压掉自动聚焦的截止时刻，0 表示不压制。 */
    let suppressUntil = 0
    /** 本轮压制已经 blur 掉的次数，防止反复聚焦时无限循环。 */
    let suppressHits = 0
    /** rAF 节流标志。 */
    let scheduled = false

    /** 取方块图标：复用内置 rail 的 toggle 图标；拿不到就不显示方块，不自造图标。 */
    const currentIconMarkup = (): string | undefined => {
      if (builtinIcon !== undefined) return builtinIcon
      const found = document.querySelector('[' + COLLAPSED_ATTR + '] > div:first-child button svg')
      if (found instanceof SVGElement) {
        builtinIcon = found.outerHTML
        return builtinIcon
      }
      return undefined
    }

    /** 按窄屏、收起与抽屉展开状态切换方块与遮罩；没有内置图标可克隆时方块不出现。 */
    const update = (): void => {
      const narrow = media.matches
      const collapsed = document.querySelector('[' + COLLAPSED_ATTR + ']') !== null
      const canOverlay = narrow && document.querySelector('[data-rightbar-collapsed]') !== null
      const markup = narrow && collapsed ? currentIconMarkup() : undefined
      document.body.classList.toggle(COLLAPSED_CLASS, markup !== undefined)
      document.body.classList.toggle(EXPANDED_CLASS, canOverlay && !collapsed)
      if (markup === undefined) return
      if (appliedIcon === markup) return
      appliedIcon = markup
      fab.innerHTML = markup
    }

    /** rAF 节流地跑一次 update。 */
    const schedule = (): void => {
      if (scheduled) return
      scheduled = true
      requestAnimationFrame(() => {
        scheduled = false
        update()
      })
    }

    /** 正在跟手拖动的指针，没按下时为 undefined。 */
    let dragPointer: number | undefined
    /** 按下时的指针起点，拖动位移相对它算。 */
    let dragStartX = 0
    let dragStartY = 0
    /** 按下时方块的原始矩形，用来把拖动夹在视口内。 */
    let dragRect: DOMRect | undefined
    /** 本次手势是否已越过阈值，成为拖动。 */
    let dragging = false
    /** 拖动后的那一次 click 要吞掉，否则松手就展开侧栏。 */
    let swallowClick = false

    /** 按下只记账，越过阈值才开始拖，轻点仍旧是展开。 */
    const onFabPointerDown = (event: PointerEvent): void => {
      if (!event.isPrimary || event.button !== 0) return
      swallowClick = false
      dragPointer = event.pointerId
      dragStartX = event.clientX
      dragStartY = event.clientY
      dragRect = fab.getBoundingClientRect()
      dragging = false
      fab.setPointerCapture(event.pointerId)
    }

    /** 视口四边的安全区，窗口尺寸变化时重读。 */
    let insets = readInsets()
    /** 当前停靠位。 */
    let dock = readDock()

    /** 把方块摆到停靠位上；窗口尺寸变化时也走这里重算。 */
    const place = (): void => {
      const vw = window.innerWidth
      const vh = window.innerHeight
      const minLeft = insets.left + FAB_GAP
      const minTop = insets.top + FAB_GAP
      const maxLeft = Math.max(minLeft, vw - insets.right - FAB_GAP - FAB_SIZE)
      const maxTop = Math.max(minTop, vh - insets.bottom - FAB_GAP - FAB_SIZE)
      const spanX = maxLeft - minLeft
      const spanY = maxTop - minTop
      const ratio = Math.min(1, Math.max(0, dock.ratio))
      let left: number
      let top: number
      switch (dock.edge) {
        case 'left':
          left = minLeft
          top = minTop + spanY * ratio
          break
        case 'right':
          left = maxLeft
          top = minTop + spanY * ratio
          break
        case 'top':
          left = minLeft + spanX * ratio
          top = minTop
          break
        case 'bottom':
          left = minLeft + spanX * ratio
          top = maxTop
          break
        case 'tr':
          left = maxLeft
          top = minTop
          break
        case 'bl':
          left = minLeft
          top = maxTop
          break
        case 'br':
          left = maxLeft
          top = maxTop
          break
        default:
          left = minLeft
          top = minTop
          break
      }
      fab.style.left = left + 'px'
      fab.style.top = top + 'px'
    }

    /** 窗口尺寸或方向变了，安全区与可停靠范围都会变，重新摆一次。 */
    const onResize = (): void => {
      insets = readInsets()
      place()
    }

    /** 拖动中让方块跟手，位移夹在视口内，免得拖到屏幕外找不回来。 */
    const onFabPointerMove = (event: PointerEvent): void => {
      if (dragPointer !== event.pointerId || dragRect === undefined) return
      const dx = event.clientX - dragStartX
      const dy = event.clientY - dragStartY
      if (!dragging) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return
        dragging = true
        fab.classList.add('is-dragging')
      }
      const x = Math.min(Math.max(dx, DRAG_EDGE_MARGIN - dragRect.left), window.innerWidth - DRAG_EDGE_MARGIN - dragRect.right)
      const y = Math.min(Math.max(dy, DRAG_EDGE_MARGIN - dragRect.top), window.innerHeight - DRAG_EDGE_MARGIN - dragRect.bottom)
      fab.style.transform = 'translate(' + x + 'px, ' + y + 'px)'
    }

    /**
     * 松手收尾：没拖动就交给 click，拖过了就吸附并记住。
     *
     * 中心同时贴近两条边时吸到那个角，否则只吸最近的一条边，沿边的位置按比例保留。
     */
    const onFabPointerUp = (event: PointerEvent): void => {
      if (dragPointer !== event.pointerId) return
      dragPointer = undefined
      if (fab.hasPointerCapture(event.pointerId)) fab.releasePointerCapture(event.pointerId)
      if (!dragging) return
      dragging = false
      fab.classList.remove('is-dragging')
      const rect = fab.getBoundingClientRect()
      fab.style.transform = ''
      const vw = window.innerWidth
      const vh = window.innerHeight
      const centerX = rect.left + rect.width / 2
      const centerY = rect.top + rect.height / 2
      const reachLeft = centerX
      const reachRight = vw - centerX
      const reachTop = centerY
      const reachBottom = vh - centerY
      const horizontal = reachLeft <= reachRight ? 'left' : 'right'
      const vertical = reachTop <= reachBottom ? 'top' : 'bottom'
      const neckX = Math.min(reachLeft, reachRight)
      const neckY = Math.min(reachTop, reachBottom)
      const minLeft = insets.left + FAB_GAP
      const minTop = insets.top + FAB_GAP
      const spanX = Math.max(1, vw - insets.right - FAB_GAP - FAB_SIZE - minLeft)
      const spanY = Math.max(1, vh - insets.bottom - FAB_GAP - FAB_SIZE - minTop)
      if (neckX < CORNER_REACH && neckY < CORNER_REACH) {
        dock = {
          edge: vertical === 'top'
            ? (horizontal === 'left' ? 'tl' : 'tr')
            : (horizontal === 'left' ? 'bl' : 'br'),
          ratio: 0,
        }
      } else if (neckX <= neckY) {
        dock = { edge: horizontal, ratio: Math.min(1, Math.max(0, (rect.top - minTop) / spanY)) }
      } else {
        dock = { edge: vertical, ratio: Math.min(1, Math.max(0, (rect.left - minLeft) / spanX)) }
      }
      place()
      saveDock(dock)
      swallowClick = true
    }

    /** 点方块展开侧栏；不冒泡到会话行的处理。拖动过的那一次不展开。 */
    const onFabClick = (event: MouseEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      if (swallowClick) {
        swallowClick = false
        return
      }
      ctx.layout.toggleSidebar()
    }

    /** 点遮罩收起抽屉。 */
    const onScrimClick = (event: MouseEvent): void => {
      event.preventDefault()
      ctx.layout.toggleSidebar()
    }

    /** 指针落在输入区时，用户是想自己输入，撤掉压制。 */
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (target instanceof HTMLElement && target.isContentEditable) {
        suppressUntil = 0
        suppressHits = 0
      }
    }

    /**
     * 压掉会话点击带来的自动聚焦。
     *
     * 输入框切会话后会无条件 focus 一次编辑器，手机上这会拉起软键盘。
     * 只拦 contenteditable，不碰重命名等输入框；拦一次即撤，避免影响后续主动输入。
     */
    const onFocusIn = (event: FocusEvent): void => {
      if (suppressUntil === 0) return
      if (performance.now() > suppressUntil) {
        suppressUntil = 0
        suppressHits = 0
        return
      }
      const target = event.target
      if (!(target instanceof HTMLElement) || !target.isContentEditable) return
      target.blur()
      suppressHits += 1
      if (suppressHits >= 6) {
        suppressUntil = 0
        suppressHits = 0
      }
    }

    /**
     * 窄屏点会话行时自动收起侧栏，并预置聚焦压制。
     *
     * 行内按钮，例如更多菜单，不触发收起；已收起时不重复操作。
     */
    const onClick = (event: MouseEvent): void => {
      const target = event.target
      if (!(target instanceof HTMLElement)) return
      if (!media.matches) return
      if (target.closest(SESSION_ROW_SELECTOR) === null) return
      if (target.closest('button') !== null) return
      suppressUntil = performance.now() + FOCUS_SUPPRESS_MS
      suppressHits = 0
      if (document.querySelector('[' + COLLAPSED_ATTR + ']') !== null) return
      ctx.layout.toggleSidebar()
    }

    const observer = new MutationObserver(schedule)
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [COLLAPSED_ATTR],
    })

    media.addEventListener('change', schedule)
    window.addEventListener('resize', onResize)
    scrim.addEventListener('click', onScrimClick)
    fab.addEventListener('click', onFabClick)
    fab.addEventListener('pointerdown', onFabPointerDown)
    fab.addEventListener('pointermove', onFabPointerMove)
    fab.addEventListener('pointerup', onFabPointerUp)
    fab.addEventListener('pointercancel', onFabPointerUp)
    document.addEventListener('click', onClick, true)
    document.addEventListener('focusin', onFocusIn, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    update()
    place()

    return () => {
      observer.disconnect()
      media.removeEventListener('change', schedule)
      window.removeEventListener('resize', onResize)
      scrim.removeEventListener('click', onScrimClick)
      fab.removeEventListener('click', onFabClick)
      fab.removeEventListener('pointerdown', onFabPointerDown)
      fab.removeEventListener('pointermove', onFabPointerMove)
      fab.removeEventListener('pointerup', onFabPointerUp)
      fab.removeEventListener('pointercancel', onFabPointerUp)
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('focusin', onFocusIn, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
      scrim.remove()
      fab.remove()
      style.remove()
      document.body.classList.remove(COLLAPSED_CLASS)
      document.body.classList.remove(EXPANDED_CLASS)
      suppressUntil = 0
      suppressHits = 0
    }
  }, 'dsh-mobile-drawer：窄屏侧栏与聚焦压制')

  applyKeys(ctx)
}
