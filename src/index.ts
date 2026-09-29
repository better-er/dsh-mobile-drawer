/**
 * dsh-mobile-drawer 的宿主入口。
 *
 * 本插件的行为全部在浏览器半身，宿主半身没有运行时行为。
 * 保留入口文件是因为客户端模块系统按 Loader entry 扫描 dsh.client 声明：entry 指向的宿主模块必须存在，浏览器半身才会被加载。
 *
 * @module dsh-mobile-drawer
 */

/** 插件名，同时也是配置项 id。 */
export const name = 'dsh-mobile-drawer'

/** 无宿主行为，仅作为可挂载的宿主入口存在。 */
export function apply(): void {}
