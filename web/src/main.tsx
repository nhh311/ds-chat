import { createRoot } from 'react-dom/client'
import { App } from './app/App.js'
import { applyInsets } from './app/native.js'
import { setupTheme } from './app/theme.js'
import { ensureKatex } from './services/markdown/katex.js'
import './app/theme.css'
import './app/global.css'

declare global {
  interface Window {
    /** index.html 的启动自检脚本据此判断挂载是否发生 */
    __dskMounted?: boolean
    __dskBootFail?: (title: string, detail: string) => void
  }
}

ensureKatex()
setupTheme()
// 安全区：Android 15 起强制沉浸式（edge-to-edge），状态栏会压在顶栏上；
// 原生桥给出真实高度写进 CSS 变量，浏览器里回落到 env(safe-area-inset-*)
applyInsets()

createRoot(document.getElementById('root') as HTMLElement).render(<App />)
window.__dskMounted = true

// 旋转、分屏、键盘弹出都会改变可用区域，重新取一次
window.addEventListener('resize', applyInsets, { passive: true })
window.addEventListener('orientationchange', applyInsets, { passive: true })
window.visualViewport?.addEventListener('resize', applyInsets, { passive: true })
