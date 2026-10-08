# 设计说明

## 背景

dsh 的窄屏布局把侧栏收起成一条 56 像素宽的全高图标栏，桌面浏览器缩窄或手机上访问时都是如此。手机上这条栏占用宽度又不便点击，切会话后输入框还会无条件夺回焦点，拉起软键盘把页面顶起。

本插件只做四件事，全部限定在窄屏，视口小于 1024 像素时生效：

1. 收起态不再保留图标栏，改成左上角一个 44 像素的悬浮方块。
2. 展开态改成覆盖式抽屉，并在点会话行时自动收起。
3. 压掉切会话后紧随的一次自动聚焦，避免软键盘顶页。
4. 右上角浮一排手机键盘上没有的按键，目前是 Shift、Ctrl 与 Tab。

## 优先级：读优先

手机上用 DSH，多数时候是在读：翻会话、看改动的行、扫工具卡片。写是间歇的，而屏幕小，软键盘一弹就吃掉半屏。取舍就按读优先排：

- 收起态把整幅宽度还给对话，侧栏不再是常驻的 56 像素窄条。
- 切会话后自动弹起的那次聚焦压掉。你点会话是为了看内容，不是接着打字。
- 你伸手去点输入框，压制立刻撤销，写从不受阻。

判据是键盘由谁要来的：自动聚焦弹出的压掉，手伸过去要的不碰。

## 内置窄屏机制

对齐 dsh 0.2.0-rc.2 的 `packages/client`：

- `ui-layout` 的 `columns.ts` 定义 `SIDEBAR_AUTO_COLLAPSE = 1024` 与 `SIDEBAR_COLLAPSED = 56`。
- `ui-layout` 的 `AppFrame.tsx` 在 `viewport < 1024` 时判定窄屏，收起态把侧栏列设为 56 像素，并把 `data-sidebar-collapsed` 挂在网格框上，另用 `data-rightbar-collapsed` 表示右栏无轨道。网格的 `grid-template-columns` 是行内样式。
- `ui-layout` 的 `stores.ts` 用 `narrowExpanded` 表示窄屏下的手动展开；跨断点时会把它清零。
- `ui-sidebar` 的 `SidebarRoot.tsx` 在收起态渲染 36 像素的图标控件，展开态渲染完整侧栏。
- `ui-conversation` 的 `InputBar.tsx` 在 `sessionId` 变化时调用 `focusDraftEditor` 把焦点还给编辑器。

内置没有面向插件的窄屏幂等收起入口，也没有会话切换广播，所以这四条行为在客户端半身用 DOM 副作用实现，卸载时全部撤销。

## 四件行为的实现

### 收起态的小方块

注入的样式只对窄屏生效，用 `!important` 覆盖行内网格轨道：

```css
[data-rightbar-collapsed] {
  grid-template-columns: 0px minmax(0px, 1fr) 0px !important;
}
```

侧栏列宽度归零，中央列拿回整幅宽度。收起态再给侧栏列加 `visibility: hidden` 隐藏残留的图标栏。这一步必须用 `visibility` 而不是 `display: none`：`display: none` 会让侧栏列不再参与网格自动放置，中央列会顶到第一轨的零宽上，右栏列顶到第二轨，界面直接失效。

方块由插件自己创建，固定在左上角，尺寸与圆角复用主题语义令牌，只在窄屏且侧栏收起时显示，条件由 body 上挂的 `dsh-mobile-drawer-collapsed` 控制。图标克隆内置收起栏第一个按钮里的 SVG，跟得上后续品牌变化；查不到就不显示方块，收起态的布局改动一并跳过，不自造兜底图标，免得收起了却没有展开入口。

### 展开态的覆盖式抽屉

内置的展开是挤压中央区，390 像素宽的屏幕上侧栏占 280 像素，中央只剩 110 像素，基本不可用。插件把它改成覆盖：

```css
[data-rightbar-collapsed]:not([data-sidebar-collapsed]) > div:first-child {
  position: relative;
  overflow: visible;
}
[data-rightbar-collapsed]:not([data-sidebar-collapsed]) [data-slot="sidebar"] > div {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 280px;
  z-index: 25;
  box-shadow: var(--dsw-elevation-prominent);
}
```

定位对象必须是侧栏根节点而不是侧栏列。侧栏列有 `overflow: hidden` 且第一轨始终零宽；把根节点绝对定位在列内，它就不参与网格放置，中央列仍在第二轨。若直接给侧栏列设 `position: fixed`，它会脱离网格，中央列顶到第一轨。

同时插入一层遮罩，z-index 低于抽屉、高于内容，点它收起抽屉。展开与收起的判定只看网格框有没有 `data-sidebar-collapsed`。

### 点会话自动收起

捕获阶段监听 `document` 的 `click`。命中 `[data-row-key^="session:"]` 时：

- 目标是行内 `button` 就放行，避免点更多菜单时收起侧栏。
- 窄屏且当前是展开态，即网格框没有 `data-sidebar-collapsed`，调用 `ctx.layout.toggleSidebar()` 收起。
- 无论收起与否都预置一次聚焦压制。

### 压掉自动聚焦

`InputBar.tsx` 的聚焦发生在会话切换提交之后，捕获阶段的 `focusin` 是唯一能拦住它的时机。插件在会话点击时记下压制截止时刻，之后：

- `focusin` 命中的是 `contenteditable` 就 `blur()`，同一轮最多 blur 六次，防止反复聚焦时无限循环。
- 压制窗口一秒半，超时即停。
- 用户主动按下输入区时立即撤销压制，不会挡住想自己输入的人。
- 只拦 `contenteditable`，重命名等 `input` 不受影响，双击标题重命名不会被误伤。

用 JavaScript 直接 `el.click()` 不产生真实的焦点转移，验证这条行为必须用 CDP 派发真实的鼠标按下与抬起事件。

### 右上角的按键条

手机软键盘上没有 Tab。对话输入框里想打缩进、或让 / 与 @ 的触发菜单补全，都没得按；终端里更彻底，shell 的命令与路径补全只认这一个键。

按键条固定在自己的 DOM 里，`position: fixed` 到右上角，压在原有按钮的下方，挂载点 `conversation.input.dock` 只用来拿会话作用域的 `inputActions`。

位置不能随便挑。触发菜单从输入框向上展开，压在输入区附近的条子上时点击会全部落进菜单里；右上角本来就有的按钮也要让开，实测最终让到 96 像素。

动作不在按钮上，而在 document 的 `pointerdown` 捕获阶段：菜单的关闭监听挂在 document 上，事件走到按钮时菜单已经关掉，捕获阶段是唯一还来得及的时机；命中 `button[data-key]` 就 `preventDefault` 加 `stopImmediatePropagation`，再执行按键。

按键先往编辑器派发一次合成的 Tab：被 `preventDefault` 的就是触发菜单接管了；没人接管才用 `captureInsertion` 与 `insertText` 在光标处落一个制表符。按键条不由 slot 渲染，因此终端与文件编辑器这些不在会话输入区的页面同样有它，按当前焦点分三路：对话输入框走 `inputActions`，终端与编辑器收合成的 Tab，普通 input 与 textarea 由插件自己把字符补进选区。

键位在 `KEYS` 表里，加键只加一项。目前三项：Shift、Ctrl 与 Tab，前面两个是粘滞修饰键，点一下锁定并高亮，紧接着按下的普通键带上它，派发完立即放开，再点自己一下则当场取消。

软键盘的回车由插件在 keydown 捕获阶段拦下，按锁定状态重发一个带 Shift 或 Ctrl 的回车。编辑器的按键处理只认事件自带的修饰键：见到 shiftKey 放行给默认行为，输入框换行；见到 ctrlKey 则当加速手势，按 DSH 自己的规则算发送模式，不去动用户的设置。判定同时认 key、code 与 keyCode 13，安卓软键盘的回车给的 key 常常不是 Enter。两个都锁着时按 Shift 算，用掉哪个放开哪个。终端与普通输入框不碰，可打印的字符键也不接管。

## 版本契约

插件按 `@deepseek-ai/dsh@^0.2.0-rc.2` 固定，用到的 DOM 契约如下，全部来自内置布局的稳定属性而不是 CSS Module 的哈希类名：

| 契约 | 来源 | 用途 |
| --- | --- | --- |
| `data-sidebar-collapsed` | AppFrame 网格框 | 判定收起态 |
| `data-rightbar-collapsed` | AppFrame 网格框 | 限定右栏无轨道时生效 |
| `[data-row-key^="session:"]` | ui-workspace 会话行 | 识别会话点击 |
| `[data-slot="sidebar"]` | ui-sidebar 槽位 | 定位侧栏根节点 |
| `conversation.input.dock` | ui-conversation 槽位 | 只为借它拿到会话作用域的 inputActions，按键条本身不渲染在这里 |
| `style[data-plugin]` | client 模块系统 | 注入的样式必须自带归属标记，见下节 |

哈希类名一律不直接依赖；只有克隆图标时按结构取内置收起栏的第一个按钮里的 SVG。

## 样式必须自带归属标记

两个注入的 `<style>` 都要写 `data-plugin="dsh-mobile-drawer"`，不是可选的美化。

client 模块系统在实例化任何一个插件时都会跑 `claimStyles`，把页面上所有**没有** `data-plugin` 的 `<style>` 认领给当时正在实例化的那个插件；那个插件一重载，`removeOwnedStyles` 就按 id 把这批样式一起删掉。

插件要等到 `apply` 挂载时才建样式，早已错过自己那次 `claimStyles`，所以不标记就是一份无主样式，谁实例化得晚就归谁。被收走之后，本插件的一切样式凭空消失：42 像素方块和按键条退回浏览器默认按钮，`position: fixed` 一并失效，元素落进文档流尾巴，把页面撑高，要滚到最下面才看得见——Dsh 上表现为窗口左下角多出一排灰色按钮。

带上 `data-plugin` 之后既不会被别人认领，卸载时也能被 `removeOwnedStyles` 正确回收。

## 已知限制

- 右栏展开时不覆盖网格，窄屏侧栏退回内置的 56 像素图标栏；此时右栏通常全屏覆盖，图标栏本就被压在下面。
- 抽屉宽度固定 280 像素，与内置默认侧栏宽一致。
- 只针对窄屏；宽屏下插件不产生任何 DOM 与样式影响。
