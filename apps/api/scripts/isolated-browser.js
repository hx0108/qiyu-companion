'use strict';

const { chromium } = require('playwright-core');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

// Own the disposable browser process explicitly. Some Windows Edge builds leave
// graceful shutdown pending; never attach to or terminate a user's browser.
async function launchIsolatedBrowser(options) {
  const launchOptions = { ...options };
  if (process.env.QIYU_E2E_BROWSER_EXECUTABLE) {
    launchOptions.executablePath = process.env.QIYU_E2E_BROWSER_EXECUTABLE;
    delete launchOptions.channel;
  }
  const server = await chromium.launchServer(launchOptions);
  const browser = await chromium.connect(server.wsEndpoint());
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    let timer;
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(false), 5000); });
    try {
      // Disconnect the protocol client first; otherwise the browser server's
      // WebSocket shutdown can wait for its own still-connected client.
      await Promise.race([browser.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 1000))]);
      const graceful = await Promise.race([server.close().then(() => true), timeout]);
      if (!graceful) {
        const child = server.process();
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = new Promise(resolve => child.once('exit', resolve));
        server.kill().catch(() => {});
        if (process.platform === 'win32' && child.exitCode === null && child.signalCode === null) {
          // Only the process returned by this launchServer is eligible. Never
          // search by browser name or act on a pre-existing user's process.
          const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
          const result = spawnSync(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000, encoding: 'utf8' });
          if (result.error) throw new Error('Cannot stop owned test browser: ' + result.error.code);
          console.log('Owned browser cleanup status: ' + result.status);
          try { process.kill(child.pid, 0); }
          catch (error) { if (error.code === 'ESRCH') return; throw error; }
        }
        await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('Isolated browser did not terminate')), 5000))]);
      }
    } finally { clearTimeout(timer); }
  };
  return { browser, close };
}

module.exports = { launchIsolatedBrowser };
