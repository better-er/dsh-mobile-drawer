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
  '  top: calc(env(safe-area-inset-top, 0px) + 10px);',
  '  left: calc(env(safe-area-inset-left, 0px) + 10px);',
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
  '  -webkit-tap-highlight-color: transparent;',
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
    style.textContent = STYLE
    document.head.append(style)

    const scrim = document.createElement('div')
    scrim.className = 'dsh-mobile-drawer-scrim'
    document.body.append(scrim)

    const fab = document.createElement('button')
    fab.type = 'button'
    fab.className = FAB_CLASS
    fab.setAttribute('aria-label', '展开侧栏')
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

    /** 点方块展开侧栏；不冒泡到会话行的处理。 */
    const onFabClick = (event: MouseEvent): void => {
      event.preventDefault()
      event.stopPropagation()
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
    scrim.addEventListener('click', onScrimClick)
    fab.addEventListener('click', onFabClick)
    document.addEventListener('click', onClick, true)
    document.addEventListener('focusin', onFocusIn, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    update()

    return () => {
      observer.disconnect()
      media.removeEventListener('change', schedule)
      scrim.removeEventListener('click', onScrimClick)
      fab.removeEventListener('click', onFabClick)
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
