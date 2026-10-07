/**
 * 手机输入按键：窄屏下在右上角浮一排手机键盘上没有的键，目前是 Shift、Ctrl 与 Tab。
 *
 * 输入框里打 / 或 @ 会弹出触发菜单，那时 Tab 的职责是选中补全项而不是插字符。
 * 但点击屏幕上的按钮会先把菜单关掉，所以必须抢在关闭之前处理：
 * 触发菜单的关闭监听挂在 document 上，插件就在 document 的 pointerdown 捕获阶段接手，
 * 那一刻菜单还开着、编辑器还带焦点，派发一次合成的 Tab 就能被菜单接管。
 * 菜单没接手时才在光标处插入制表符。
 *
 * Shift 与 Ctrl 是粘滞修饰键：点一下锁定，接着按的普通键带上它，随后自动放开；
 * 再点自己一下则当场取消。手机没法两只手按组合键，粘滞是这里唯一能用的形态。
 * 软键盘上真实按下的回车也归它们管：拦下来按锁定状态补发一个带 Shift 或 Ctrl 的回车，
 * Shift 加回车让输入框换行，Ctrl 加回车交给 DSH 的排队发送。
 *
 * 键位表是唯一的扩展点，加键只往 KEYS 加一项，容器与键面样式都不用动。
 *
 * @module dsh-mobile-drawer/client/keys
 */

import { useEffect, type ReactNode } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** 挂当前实例监听用的名字：热更新时旧实例未必被完整卸载，留着会两份叠着处理同一次按键。 */
const MOUNT_SLOT = '__dshMobileDrawerKeysAbort'

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
  '  gap: 7px;',
  '}',
  '.dsh-mobile-drawer-keys > button {',
  '  display: inline-flex;',
  '  align-items: center;',
  '  justify-content: center;',
  '  min-width: 34px;',
  '  height: 34px;',
  '  padding: 0 10px;',
  '  border: 0.5px solid var(--dsw-alias-border-l3);',
  '  border-radius: var(--dsw-radius-sm, 8px);',
  '  background: var(--dsw-alias-button-elevated-fill);',
  '  color: var(--dsw-alias-label-primary);',
  '  box-shadow: var(--dsw-elevation-panel);',
  '  font: inherit;',
  '  font-size: 14px;',
  '  line-height: 1;',
  '  cursor: pointer;',
  '  -webkit-tap-highlight-color: transparent;',
  '}',
  '.dsh-mobile-drawer-keys > button:active,',
  '.dsh-mobile-drawer-keys > button.is-active {',
  '  background: var(--dsw-alias-interactive-bg-hover);',
  '  border-color: var(--dsw-alias-label-primary);',
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

/** 粘滞修饰键的种类。 */
type Modifier = 'shift' | 'ctrl'

/**
 * 一个键位。
 *
 * 普通键带要落进输入框的字符；修饰键带自己的种类，按下只切换锁定状态，不落字。
 */
type KeySpec = { readonly id: string; readonly label: string } & (
  | { readonly text: string; readonly yieldToMenu?: boolean; readonly modifier?: undefined }
  | { readonly modifier: Modifier; readonly text?: undefined; readonly yieldToMenu?: undefined }
)

/** 键位表，也是唯一的扩展点。加键只在这里加一项，修饰键排在普通键前面。 */
const KEYS: readonly KeySpec[] = [
  { id: 'shift', label: 'Shift', modifier: 'shift' },
  { id: 'ctrl', label: 'Ctrl', modifier: 'ctrl' },
  { id: 'tab', label: 'Tab', text: '\t', yieldToMenu: true },
]

/** 当前锁住的修饰键。 */
const activeModifiers = new Set<Modifier>()

/** 键位条根节点，用来把锁定状态刷到键面上。 */
let keyRow: Element | undefined

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

/**
 * 造一份键盘事件选项。
 *
 * keyCode 在类型里但已废弃，which 不在，两条都补上只为照顾真去读它们的处理逻辑。
 */
function keyEventOptions(key: string, code: string, keyCode: number): KeyboardEventInit & { keyCode: number; which: number } {
  return { key, code, keyCode, which: keyCode, bubbles: true, cancelable: true, composed: true }
}

/** 补全与缩进用的 Tab。 */
const TAB_EVENT = keyEventOptions('Tab', 'Tab', 9)

/** 回车的键盘事件选项，也用来把软键盘的普通回车改写成带修饰键的回车。 */
const ENTER_EVENT = keyEventOptions('Enter', 'Enter', 13)

/** 一次派发要带上的修饰键状态。 */
interface ModifierState {
  readonly ctrlKey: boolean
  readonly shiftKey: boolean
}

/**
 * 往焦点元素派发一次合成的 Tab 按键，返回页面是否还有默认行为没被接管。
 *
 * 这个判断只能问页面：被 preventDefault 的就是触发菜单接管了，没接管才轮到我们插制表符。
 */
function dispatchTab(target: HTMLElement, modifiers: ModifierState): boolean {
  const init = { ...TAB_EVENT, ...modifiers }
  const unhandled = target.dispatchEvent(new KeyboardEvent('keydown', init))
  target.dispatchEvent(new KeyboardEvent('keyup', init))
  return unhandled
}

/** 把锁定状态刷到键面上，锁住的修饰键高亮。 */
function syncModifierState(): void {
  const row = keyRow
  if (row === undefined) {
    return
  }
  for (const button of row.querySelectorAll<HTMLButtonElement>('button[data-key]')) {
    const key = KEYS.find((item) => item.id === button.getAttribute('data-key'))
    if (key === undefined || key.modifier === undefined) {
      continue
    }
    const locked = activeModifiers.has(key.modifier)
    button.classList.toggle('is-active', locked)
    button.setAttribute('aria-pressed', locked ? 'true' : 'false')
  }
}

/**
 * 按下一个键。
 *
 * 修饰键只切换锁定状态，不落字；普通键取上当前锁定状态再派发，派发完就把锁定放开，
 * 免得下一次按键莫名带上修饰符。
 */
function press(key: KeySpec): void {
  if (key.modifier !== undefined) {
    if (activeModifiers.has(key.modifier)) {
      activeModifiers.delete(key.modifier)
    } else {
      activeModifiers.add(key.modifier)
    }
    syncModifierState()
    return
  }

  const modifiers: ModifierState = {
    ctrlKey: activeModifiers.has('ctrl'),
    shiftKey: activeModifiers.has('shift'),
  }
  activeModifiers.clear()
  syncModifierState()
  insert(key, modifiers)
}

/**
 * 把按键送到当前焦点所在的输入面。
 *
 * 对话输入框是 contenteditable 的 Lexical 编辑器，写入只能走会话作用域的 inputActions：
 * 先让触发菜单接手一次 Tab，没人接手再用 captureInsertion 与 insertText 在光标处落字。
 * 终端、编辑器与普通输入框各有自己的键盘处理，把合成的 Tab 原样交给它们即可；
 * 合成的按键不触发浏览器默认行为，所以普通输入框那一支自己把字符补上。
 */
function insert(key: KeySpec, modifiers: ModifierState): void {
  const text = key.text
  if (text === undefined) {
    console.warn('[dsh-mobile-drawer] 键位既不是修饰键也没有字符，按键未生效：' + key.id)
    return
  }

  const active = document.activeElement

  if (active instanceof HTMLElement && active.isContentEditable) {
    if (key.yieldToMenu === true && !dispatchTab(active, modifiers)) {
      return
    }
    const inputActions = activeActions
    if (inputActions === undefined) {
      console.warn('[dsh-mobile-drawer] 对话输入框有焦点但拿不到 inputActions，按键未生效：' + key.id)
      return
    }
    const span = inputActions.captureInsertion()
    if (!inputActions.insertText(text, span)) {
      console.warn('[dsh-mobile-drawer] 输入框判定选区已过期而拒绝插入，按键未生效：' + key.id)
    }
    return
  }

  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    if (!dispatchTab(active, modifiers)) {
      return
    }
    const start = active.selectionStart
    const end = active.selectionEnd
    if (start === null || end === null) {
      console.warn('[dsh-mobile-drawer] 当前输入框取不到选区，按键未生效：' + key.id)
      return
    }
    active.setRangeText(text, start, end, 'end')
    active.dispatchEvent(new Event('input', { bubbles: true }))
    return
  }

  if (active instanceof HTMLElement) {
    dispatchTab(active, modifiers)
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
  // 热更新或重复加载时，上一份实例未必被完整卸载。先掐掉它的监听、清掉它的界面，
  // 否则两份模块状态各管一半，点击写的锁定拦截那侧读不到。
  const host = window as unknown as Record<string, AbortController | undefined>
  host[MOUNT_SLOT]?.abort()
  const controller = new AbortController()
  host[MOUNT_SLOT] = controller
  for (const stale of document.querySelectorAll('.' + ROW_CLASS)) {
    stale.remove()
  }
  document.getElementById('dsh-mobile-drawer-keys-style')?.remove()

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
    document.addEventListener('pointerdown', onPointerDown, { capture: true, signal: controller.signal })
  }, 'dsh-mobile-drawer：手机按键')

  ctx.effect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // 只管软键盘上真实按下、又没自带修饰键的回车：已发生的按键改不了，只能拦下来自己重发一个。
      // 合成事件一律跳过，免得自己发的再被自己接住。
      // 判定同时认 key 与 keyCode：安卓软键盘的回车常常给不出 Enter 这个 key，只给 keyCode 13
      const isEnter = event.key === 'Enter' || event.code === 'Enter' || event.keyCode === 13
      if (!event.isTrusted || !isEnter || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) {
        return
      }
      const shift = activeModifiers.has('shift')
      const ctrl = activeModifiers.has('ctrl')
      if (!shift && !ctrl) {
        return
      }
      // 只改对话输入框。终端里 Shift 加回车与回车等价，普通输入框却未必，不必替它们拿主意。
      // 手机上回车的 target 未必就是编辑框本身，所以往上找最近的 contenteditable 祖先
      const holder = event.target instanceof Element ? event.target.closest('[contenteditable]') : null
      if (holder === null) {
        return
      }
      // 编辑器的按键处理只认事件自带的修饰键，所以拦下这一下，补发一个带上 Shift 或 Ctrl 的回车
      event.preventDefault()
      event.stopImmediatePropagation()
      // 两个都锁着时按 Shift 算，换行没有副作用；用掉哪个放开哪个，另一个留着
      const used: Modifier = shift ? 'shift' : 'ctrl'
      activeModifiers.delete(used)
      syncModifierState()
      const init = { ...ENTER_EVENT, shiftKey: used === 'shift', ctrlKey: used === 'ctrl' }
      // 手机上回车的落点常只是编辑器里的一个普通元素，补发要打到真正的编辑容器上，编辑器的按键处理才认
      const sink = holder instanceof HTMLElement ? holder : event.target instanceof HTMLElement ? event.target : null
      if (sink === null) {
        return
      }
      sink.dispatchEvent(new KeyboardEvent('keydown', init))
      sink.dispatchEvent(new KeyboardEvent('keyup', init))
    }
    document.addEventListener('keydown', onKeyDown, { capture: true, signal: controller.signal })
  }, 'dsh-mobile-drawer：粘滞修饰键的回车')

  ctx.effect(() => {
    const row = document.createElement('div')
    row.className = ROW_CLASS
    for (const key of KEYS) {
      const button = document.createElement('button')
      button.type = 'button'
      button.setAttribute('data-key', key.id)
      button.setAttribute('aria-label', key.label)
      if (key.modifier !== undefined) {
        button.setAttribute('aria-pressed', 'false')
      }
      button.textContent = key.label
      row.append(button)
    }
    document.body.append(row)
    keyRow = row
    return () => {
      row.remove()
      keyRow = undefined
      activeModifiers.clear()
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
