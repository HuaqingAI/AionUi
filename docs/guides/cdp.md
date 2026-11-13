# In-app browser and Agent control

The desktop app provides a persistent browser in the conversation preview panel. Enable **Settings → System → In-app browser → Let the agent use the in-app browser**, then restart the app if prompted.

Create a **new conversation** after upgrading to a build with browser control. AionCore keeps each conversation's MCP selection fixed at creation, so an older conversation does not gain browser tools when the app is updated.

## Open and use websites

Ask the agent, for example:

> Open https://www.baidu.com in the in-app browser.

The built-in `hq-browser` MCP opens the preview panel and waits for its page to be ready before using browser tools. It provides page navigation, snapshots, clicks, forms, scripts, and screenshots through Chrome DevTools MCP. `browser_open` explicitly opens or navigates the in-app browser. You can also open it manually from the workspace dropdown.

This connection exposes only the in-app browser webview. It does not expose the AionUi interface or launch a separate Chrome window. The CDP port is assigned dynamically; no fixed `9230` port or manually configured external MCP is required. WebUI does not provide an Electron webview and therefore does not expose these tools.

## Import Cookie and Local Storage state

Ask the agent to call `browser_import_storage_state` with a local `file_path`, for example:

> Import E:\login-state\state.json into the in-app browser, then open the website.

The importer accepts Playwright's Cookie and Local Storage state format:

```json
{
  "cookies": [
    {
      "name": "session",
      "value": "example-value",
      "domain": "example.com",
      "path": "/",
      "expires": -1,
      "httpOnly": true,
      "secure": true,
      "sameSite": "Lax"
    }
  ],
  "origins": [
    {
      "origin": "https://example.com",
      "localStorage": [{ "name": "preference", "value": "example-value" }]
    }
  ]
}
```

Cookie files containing a Cookie array are also supported. For a standalone Local Storage map such as `{"theme":"dark"}`, supply the website's exact `origin` (scheme, host, and port) along with `file_path`. Imports add or replace the supplied entries in the existing session. Import results report counts and failures without returning Cookie or Local Storage values.

Cookies, including HttpOnly cookies, are written to the application's persistent browser session. Local Storage is restored per origin. Browser tabs and projects share this session. Persistent site data remains after restarting the app; session cookies retain their session-cookie semantics. Expired, revoked, or device-bound credentials can still require signing in again. IndexedDB and sessionStorage are outside this import format.

## Troubleshooting

- If the agent has no `hq-browser` tools, verify that control was enabled when the app started and create a new conversation.
- Keep the desktop window available while the agent uses the browser. A missing or closed preview is reopened when an action requires it.
- The first Chrome DevTools MCP launch requires Node.js/npm and may download the pinned MCP package. A failed dependency launch is reported as a tool error.
- Disable Agent browser control in system settings and restart to remove access. Manual browsing remains available.

For development, the real Electron integration test uses isolated temporary browser data and local test websites:

```bash
bunx cross-env AIONUI_BROWSER_ELECTRON_SMOKE=1 vitest run tests/unit/preview/browser/control/browserElectron.test.ts
```

---

# 应用内浏览器与 Agent 控制

在桌面版的 **设置 → 系统 → 应用内浏览器** 中开启“允许 Agent 操作 APP 内的浏览器”，按提示重启。升级到支持浏览器控制的版本后，请**新建会话**使用：AionCore 不允许在已有会话中修改 MCP 配置。

对 Agent 说“使用应用内浏览器打开百度”即可自动展开预览面板。内置 `hq-browser` 工具会等待页面连接完成，再执行打开网址、读取页面、点击、填表或截图。它仅控制应用内浏览器，不控制 AionUi 界面，也不会另外启动 Chrome。控制端口由系统分配，无需手动配置 `9230` 或外部 MCP。WebUI 不支持这一 Electron 专属能力。

需要导入登录状态时，可以直接说：

> 将 E:\login-state\state.json 中的 Cookie 和 Local Storage 导入应用内浏览器，然后打开网站。

Agent 使用 `browser_import_storage_state` 读取本地文件。支持上面的 Playwright `cookies` / `origins[].localStorage` 格式，也支持单独的 Cookie 数组；单独的 Local Storage 键值文件（例如 `{"theme":"dark"}`）需同时指定准确的网站 `origin`。导入会在现有浏览器存储中添加或覆盖对应条目。HttpOnly Cookie 也可导入，结果仅返回导入数量与失败情况。

所有应用内浏览器标签页、项目共用同一份站点存储。持久化数据可在重启后保留，会话 Cookie 仍遵循其原有生命周期。过期、已注销或绑定设备的登录状态可能需要重新登录。此功能不导入 IndexedDB 或 sessionStorage。
