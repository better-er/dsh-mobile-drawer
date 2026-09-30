# 设计说明

## 背景

dsh 的窄屏布局把侧栏收起成一条 56 像素宽的全高图标栏，桌面浏览器缩窄或手机上访问时都是如此。手机上这条栏占用宽度又不便点击，切会话后输入框还会无条件夺回焦点，拉起软键盘把页面顶起。

本插件只做三件事，全部限定在窄屏，视口小于 1024 像素时生效：

1. 收起态不再保留图标栏，改成左上角一个 44 像素的悬浮方块。
2. 展开态改成覆盖式抽屉，并在点会话行时自动收起。
3. 压掉切会话后紧随的一次自动聚焦，避免软键盘顶页。

## 内置窄屏机制

对齐 dsh 0.2.0-rc.2 的 `packages/client`：

- `ui-layout` 的 `columns.ts` 定义 `SIDEBAR_AUTO_COLLAPSE = 1024` 与 `SIDEBAR_COLLAPSED = 56`。
- `ui-layout` 的 `AppFrame.tsx` 在 `viewport < 1024` 时判定窄屏，收起态把侧栏列设为 56 像素，并把 `data-sidebar-collapsed` 挂在网格框上，另用 `data-rightbar-collapsed` 表示右栏无轨道。网格的 `grid-template-columns` 是行内样式。
- `ui-layout` 的 `stores.ts` 用 `narrowExpanded` 表示窄屏下的手动展开；跨断点时会把它清零。
- `ui-sidebar` 的 `SidebarRoot.tsx` 在收起态渲染 36 像素的图标控件，展开态渲染完整侧栏。
- `ui-conversation` 的 `InputBar.tsx` 在 `sessionId` 变化时调用 `focusDraftEditor` 把焦点还给编辑器。

内置没有面向插件的窄屏幂等收起入口，也没有会话切换广播，所以这三条行为在客户端半身用 DOM 副作用实现，卸载时全部撤销。

## 三件行为的实现

### 收起态的小方块

注入的样式只对窄屏生效，用 `!important` 覆盖行内网格轨道：

```css
[data-rightbar-collapsed] {
  grid-template-columns: 0px minmax(0px, 1fr) 0px !important;
}
```

侧栏列宽度归零，中央列拿回整幅宽度。收起态再给侧栏列加 `visibility: hidden` 隐藏残留的图标栏。这一步必须用 `visibility` 而不是 `display: none`：`display: none` 会让侧栏列不再参与网格自动放置，中央列会顶到第一轨的零宽上，右栏列顶到第二轨，界面直接失效。

方块由插件自己创建，固定在左上角，尺寸与圆角复用主题语义令牌。它只在窄屏且侧栏收起时显示，显示条件由插件在 body 上挂 `dsh-mobile-drawer-collapsed` 控制。方块图标克隆内置收起栏的第一个按钮里的 SVG，这样后续版本换品牌标记也能跟上；查不到时退回一个内联的左侧面板图标。

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

定位对象必须是侧栏根节点而不是侧栏列。侧栏列有 `overflow: hidden`，且网格第一轨始终是零宽；把根节点绝对定位在列内，它就不参与网格放置，中央列仍在第二轨，宽度保持整幅。若直接给侧栏列设 `position: fixed`，它会脱离网格，中央列同样会顶到第一轨。

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

## 版本契约

插件按 `@deepseek-ai/dsh@^0.2.0-rc.2` 固定，用到的 DOM 契约如下，全部来自内置布局的稳定属性而不是 CSS Module 的哈希类名：

| 契约 | 来源 | 用途 |
| --- | --- | --- |
| `data-sidebar-collapsed` | AppFrame 网格框 | 判定收起态 |
| `data-rightbar-collapsed` | AppFrame 网格框 | 限定右栏无轨道时生效 |
| `[data-row-key^="session:"]` | ui-workspace 会话行 | 识别会话点击 |
| `[data-slot="sidebar"]` | ui-sidebar 槽位 | 定位侧栏根节点 |

哈希类名一律不直接依赖；只有克隆图标时按结构取内置收起栏的第一个按钮里的 SVG。

## 已知限制

- 右栏展开时不覆盖网格，窄屏侧栏退回内置的 56 像素图标栏；此时右栏通常全屏覆盖，图标栏本就被压在下面。
- 抽屉宽度固定 280 像素，与内置默认侧栏宽一致。
- 只针对窄屏；宽屏下插件不产生任何 DOM 与样式影响。
