// Implement compatible desktop APIs with stock x64 Electron facilities.
// This module provides real behavior, and does not change authentication or policy decisions.
const { app, BrowserWindow } = require('electron');

app.whenReady().then(() => {
  const { screen } = require('electron');
  if (typeof screen.isCursorScreenPointSupported !== 'function') {
    screen.isCursorScreenPointSupported = () => typeof screen.getCursorScreenPoint === 'function';
  }
});

if (typeof BrowserWindow.isInputShapeSupported !== 'function') {
  BrowserWindow.isInputShapeSupported = () => false;
}
if (typeof BrowserWindow.isSystemBackdropSupported !== 'function') {
  BrowserWindow.isSystemBackdropSupported = () => false;
}
if (typeof BrowserWindow.isAlwaysOnTopSupported !== 'function') {
  BrowserWindow.isAlwaysOnTopSupported = () => typeof BrowserWindow.prototype.setAlwaysOnTop === 'function';
}

if (process.env.CODEX_INTEL_DIAGNOSTICS === '1') {
  const { dialog } = require('electron');
  const original = dialog.showMessageBox.bind(dialog);
  dialog.showMessageBox = function (...args) {
    const options = args.length > 1 ? args[1] : args[0];
    console.error('[Intel startup dialog]', options?.message, options?.detail);
    return original(...args);
  };
}

const patchSession = session => {
  if (typeof session.setPreferredLanguages !== 'function') {
    session.setPreferredLanguages = languages => {
      if (!Array.isArray(languages) || languages.some(language => typeof language !== 'string')) {
        throw new TypeError('setPreferredLanguages requires language codes');
      }
      session.setUserAgent(session.getUserAgent(), languages.join(','));
    };
  }
  // These callbacks belong to Owl's native browser surface. Stock Electron does
  // not produce those events; retain registrations while upstream's standard
  // permission request/check handlers continue to deny browser permissions.
  for (const method of ['setPermissionPromptHandler', 'setOpenURLHandler', 'setWebContentsActivationHandler']) {
    if (typeof session[method] !== 'function') {
      let registered = null;
      session[method] = callback => {
        if (callback !== null && typeof callback !== 'function') throw new TypeError(`${method} requires a function or null`);
        registered = callback;
      };
    }
  }
  if (typeof session.setWebsiteReportingEnabled === 'function') return;
  let reportingWarningShown = false;
  session.setWebsiteReportingEnabled = enabled => {
    if (enabled && !reportingWarningShown) {
      reportingWarningShown = true;
      console.warn('[Codex Intel] Website activity reporting is unavailable in this runtime and remains disabled.');
    }
    // Stock Electron has no Owl activity producer. Report that the feature is inactive.
    return false;
  };
};
app.on('session-created', patchSession);
app.whenReady().then(() => patchSession(require('electron').session.defaultSession));

if (typeof app.setDebugChromePagesEnabled !== 'function') {
  let enabled = false;
  app.setDebugChromePagesEnabled = value => {
    if (value) throw new Error('Owl debugging pages are unavailable in the Intel compatibility runtime.');
    enabled = false;
  };
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (event, url) => {
      if (!enabled && /^chrome:\/\//i.test(url)) event.preventDefault();
    });
  });
}

// Keep the scope of the local compatibility build visible in the app's Help menu.
const { Menu, MenuItem, dialog } = require('electron');
const setApplicationMenu = Menu.setApplicationMenu.bind(Menu);
Menu.setApplicationMenu = menu => {
  if (menu && !menu.getMenuItemById('codex-intel-compatibility-info')) {
    let help = menu.items.find(item => item.role === 'help' || item.label === 'Help' || item.label === '帮助');
    if (!help?.submenu) {
      help = new MenuItem({ label: '帮助', submenu: new Menu() });
      menu.append(help);
    }
    help.submenu.append(new MenuItem({
      id: 'codex-intel-compatibility-info', label: 'Intel 兼容性说明',
      click: () => dialog.showMessageBox({ type: 'info', title: 'Codex Intel', message: 'Intel 本地兼容版本',
        detail: '用于在 Intel Mac 上使用官方界面和本地 Codex 编码后端。\n\n已知限制：内置浏览器的原生集成、网站活动记录、部分系统快捷键和外设集成尚未适配。电脑控制与语音功能尚未验证。\n\n官方自动更新已关闭，新版本需要重新运行兼容打包器。',
        buttons: ['知道了'], noLink: true }),
    }));
  }
  return setApplicationMenu(menu);
};

let taskManager;
if (typeof app.showTaskManager !== 'function') {
  app.showTaskManager = function showTaskManager() {
    if (!app.isReady()) {
      app.whenReady().then(showTaskManager);
      return;
    }
    if (taskManager && !taskManager.isDestroyed()) {
      taskManager.show();
      taskManager.focus();
      return;
    }
    taskManager = new BrowserWindow({
      width: 760, height: 440, title: 'Codex Intel · 进程', backgroundColor: '#151719',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    const window = taskManager;
    window.setMenuBarVisibility(false);
    const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>
      body{margin:32px;background:#151719;color:#eee;font:14px system-ui}h1{font-size:20px}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:12px;border-bottom:1px solid #333}th{color:#aaa}
      </style><h1>Codex Intel · 进程</h1><table><thead><tr><th>进程</th><th>PID</th><th>CPU</th><th>内存</th></tr></thead><tbody></tbody></table>`;
    window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    const update = async () => {
      if (window.isDestroyed()) return;
      const metrics = app.getAppMetrics().map(metric => ({
        type: metric.name || metric.type,
        pid: metric.pid,
        cpu: `${(metric.cpu?.percentCPUUsage || 0).toFixed(1)}%`,
        memory: `${((metric.memory?.workingSetSize || 0) / 1024).toFixed(1)} MB`,
      }));
      try {
        await window.webContents.executeJavaScript(`(() => {
          const body = document.querySelector('tbody'); if (!body) return;
          body.replaceChildren(...${JSON.stringify(metrics)}.map(metric => {
            const row = document.createElement('tr');
            for (const value of [metric.type, metric.pid, metric.cpu, metric.memory]) {
              const cell = document.createElement('td'); cell.textContent = value; row.appendChild(cell);
            }
            return row;
          }));
        })()`);
      } catch { /* The window may have closed while this sample was being rendered. */ }
    };
    window.webContents.once('did-finish-load', update);
    const interval = setInterval(update, 1500);
    window.on('closed', () => { clearInterval(interval); taskManager = null; });
  };
}
