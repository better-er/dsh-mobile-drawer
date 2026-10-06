/**
 * 手机输入按键：窄屏下在右上角浮一排手机键盘上没有的键，目前只有一个 Tab。
 *
 * 输入框里打 / 或 @ 会弹出触发菜单，那时 Tab 的职责是选中补全项而不是插字符。
 * 但点击屏幕上的按钮会先把菜单关掉，所以必须抢在关闭之前处理：
 * 触发菜单的关闭监听挂在 document 上，插件就在 document 的 pointerdown 捕获阶段接手，
 * 那一刻菜单还开着、编辑器还带焦点，派发一次合成的 Tab 就能被菜单接管。
 * 菜单没接手时才在光标处插入制表符。
 *
 * 键位表是唯一的扩展点，加键只往 KEYS 加一项，容器与键面样式都不用动。
 *
 * @module dsh-mobile-drawer/client/keys
 */

import { useEffect, type ReactNode } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** 键位组容器类名，样式一次注入。 */
const ROW_CLASS = 'dsh-mobile-drawer-keys'

/**
 * 键位条的样式。
 *
 * 条子浮在右上角，横向排开；键面样式统一由子选择器给，加键不必新增 CSS。
 * 顶部工具行约占 28 像素，文件预览页在它下面还有一排操作按钮，实测压到 56 像素仍会盖住
 * 「用古法编程编辑」，所以从这里再往下让到 96 像素。
 * 只在窄屏显示：宽屏本来就有物理键盘，不占位置。
 */
const STYLE = [
  '.dsh-mobile-drawer-keys {',
  '  position: fixed;',
  '  top: calc(env(safe-area-inset-top, 0px) + 96px);',
  '  right: calc(env(safe-area-inset-right, 0px) + 10px);',
  '  z-index: 1000;',
  '  display: flex;',
  '  align-items: center;',
  '  gap: 6px;',
  '}',
  '.dsh-mobile-drawer-keys > button {',
  '  display: inline-flex;',
  '  align-items: center;',
  '  justify-content: center;',
  '  min-width: 28px;',
  '  height: 28px;',
  '  padding: 0 8px;',
  '  border: 0.5px solid var(--dsw-alias-border-l3);',
  '  border-radius: var(--dsw-radius-sm, 8px);',
  '  background: var(--dsw-alias-button-elevated-fill);',
  '  color: var(--dsw-alias-label-primary);',
  '  box-shadow: var(--dsw-elevation-panel);',
  '  font: inherit;',
  '  font-size: 12px;',
  '  line-height: 1;',
  '  cursor: pointer;',
  '  -webkit-tap-highlight-color: transparent;',
  '}',
  '.dsh-mobile-drawer-keys > button:active {',
  '  background: var(--dsw-alias-interactive-bg-hover);',
  '}',
  '.dsh-mobile-drawer-keys > button:focus-visible {',
  '  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));',
  '  outline-offset: 2px;',
  '}',
  '@media (min-width: 1024px) {',
  '  .dsh-mobile-drawer-keys {',
  '    display: none;',
  '  }',
  '}',
  '',
].join('\n')

/** 一个键位：id 用作注册点与 React key，label 是键面文字，text 是落进输入框的字符。 */
interface KeySpec {
  readonly id: string
  readonly label: string
  readonly text: string
  /** 按下前先让页面处理一次合成的 Tab，触发菜单开着时补全优先。 */
  readonly yieldToMenu?: boolean
}

/** 键位表，也是唯一的扩展点。加键只在这里加一项。 */
const KEYS: readonly KeySpec[] = [
  { id: 'tab', label: 'Tab', text: '\t', yieldToMenu: true },
]

/** 输入区按键条的 props，session 作用域下带标准输入操作面。 */
type InputDockProps = PropsRuntime<'conversation.input.dock'>

/** 当前会话的输入操作面，由 slot 组件挂载后持续更新。 */
let activeActions: InputDockProps['inputActions'] | undefined

/** 客户端上下文里本模块用得到的一小片。 */
export interface KeysContext {
  effect(callback: () => (() => void) | void, label?: string): void
  slots: {
    inject(key: 'conversation.input.dock', callback: () => (() => void) | void): void
    register(
      spec: { name: 'conversation.input.dock'; id: string; order?: number },
      component: (props: InputDockProps) => ReactNode,
    ): () => void
  }
}

/** 键盘事件选项。keyCode 在类型里但已废弃，which 不在，两条都补上只为照顾真去读它们的处理逻辑。 */
const TAB_EVENT: KeyboardEventInit & { keyCode: number; which: number } = {
  key: 'Tab',
  code: 'Tab',
  keyCode: 9,
  which: 9,
  bubbles: true,
  cancelable: true,
  composed: true,
}


/**
 * 往编辑器派发一次合成的 Tab 按键，返回页面是否还有默认行为没被接管。
 *
 * 这个判断只能问页面：被 preventDefault 的就是触发菜单接管了，没接管才轮到我们插制表符。
 */
function dispatchTab(target: HTMLElement): boolean {
  const unhandled = target.dispatchEvent(new KeyboardEvent('keydown', TAB_EVENT))
  target.dispatchEvent(new KeyboardEvent('keyup', TAB_EVENT))
  return unhandled
}

/**
 * 按下一个键，交给当前焦点所在的那个输入面。
 *
 * 对话输入框是 contenteditable 的 Lexical 编辑器，写入只能走会话作用域的 inputActions：
 * 先让触发菜单接手一次 Tab，没人接手再用 captureInsertion 与 insertText 在光标处落字。
 * 终端、编辑器与普通输入框各有自己的键盘处理，把合成的 Tab 原样交给它们即可；
 * 合成的按键不触发浏览器默认行为，所以普通输入框那一支自己把字符补上。
 */
function press(key: KeySpec): void {
  const active = document.activeElement

  if (active instanceof HTMLElement && active.isContentEditable) {
    if (key.yieldToMenu === true && !dispatchTab(active)) {
      return
    }
    const inputActions = activeActions
    if (inputActions === undefined) {
      console.warn('[dsh-mobile-drawer] 对话输入框有焦点但拿不到 inputActions，按键未生效：' + key.id)
      return
    }
    const span = inputActions.captureInsertion()
    if (!inputActions.insertText(key.text, span)) {
      console.warn('[dsh-mobile-drawer] 输入框判定选区已过期而拒绝插入，按键未生效：' + key.id)
    }
    return
  }

  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    if (!dispatchTab(active)) {
      return
    }
    const start = active.selectionStart
    const end = active.selectionEnd
    if (start === null || end === null) {
      console.warn('[dsh-mobile-drawer] 当前输入框取不到选区，按键未生效：' + key.id)
      return
    }
    active.setRangeText(key.text, start, end, 'end')
    active.dispatchEvent(new Event('input', { bubbles: true }))
    return
  }

  if (active instanceof HTMLElement) {
    dispatchTab(active)
    return
  }

  console.warn('[dsh-mobile-drawer] 当前没有能接收按键的元素，按键未生效：' + key.id)
}

/**
 * 只做一件事的空组件：把会话作用域的输入操作面留下来给按键条用。
 *
 * 按键条本身不渲染在这里。它固定在右上角，终端与文件编辑器这些不在会话输入区的页面也该看得见，
 * 所以由 applyKeys 直接建 DOM，这个登记点只负责拿到 inputActions。
 */
function ActionsBridge({ inputActions }: InputDockProps) {
  useEffect(() => {
    activeActions = inputActions
    return () => {
      if (activeActions === inputActions) {
        activeActions = undefined
      }
    }
  }, [inputActions])

  return null
}

/**
 * 挂载手机输入按键。
 *
 * @param ctx - 客户端根上下文，slots 已就绪。
 */
export function applyKeys(ctx: KeysContext): void {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.id = 'dsh-mobile-drawer-keys-style'
    style.textContent = STYLE
    document.head.append(style)
    return () => {
      style.remove()
    }
  }, 'dsh-mobile-drawer：手机按键样式')

  ctx.effect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Element)) {
        return
      }
      // 先认准自家的容器，页面别处若有同样带 data-key 的按钮，不归这里管
      const row = target.closest('.' + ROW_CLASS)
      if (row === null) {
        return
      }
      const button = target.closest('button[data-key]')
      if (button === null || !row.contains(button)) {
        return
      }
      const key = KEYS.find((item) => item.id === button.getAttribute('data-key'))
      if (key === undefined) {
        console.warn('[dsh-mobile-drawer] 按键条上的按钮没有对应键位：' + String(button.getAttribute('data-key')))
        return
      }
      // 抢在触发菜单的关闭监听之前：这时候菜单还开着，事件一旦继续传播就被关掉，补全也就没了
      event.preventDefault()
      event.stopImmediatePropagation()
      press(key)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, 'dsh-mobile-drawer：手机按键')

  ctx.effect(() => {
    const row = document.createElement('div')
    row.className = ROW_CLASS
    for (const key of KEYS) {
      const button = document.createElement('button')
      button.type = 'button'
      button.setAttribute('data-key', key.id)
      button.setAttribute('aria-label', key.label)
      button.textContent = key.label
      row.append(button)
    }
    document.body.append(row)
    return () => {
      row.remove()
    }
  }, 'dsh-mobile-drawer：手机按键条')

  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.dock',
        id: 'dsh-mobile-drawer-keys',
        order: 100,
      },
      ActionsBridge,
    ),
  )
}
