import { exec } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const asyncExec = promisify(exec);

function isChromeLike(execPath: string): boolean {
  const lower = execPath.toLowerCase();
  return (
    lower.includes('chrome') ||
    lower.includes('chromium') ||
    lower.includes('edge') ||
    lower.includes('msedge') ||
    lower.includes('brave')
  );
}

async function getDefaultBrowserPath(platform: string): Promise<string | null> {
  if (platform === 'win32') {
    try {
      const { stdout } = await asyncExec(
        'reg query HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice /v ProgId'
      );
      const progId = stdout.trim().split(/\s+/).pop();
      if (!progId) return null;
      const { stdout: cmdOut } = await asyncExec(
        `reg query "HKEY_CLASSES_ROOT\\${progId}\\shell\\open\\command" /ve`
      );
      const match = cmdOut.match(/\"(.+?)\"/);
      if (match) return match[1] || null;
    } catch (e) {
      return null;
    }
  } else if (platform === 'darwin') {
    try {
      const { stdout } = await asyncExec(
        'defaults read com.apple.LaunchServices/com.apple.launchservices.secure | grep -o \'LSHandlerRoleAll = "[^"]*";\' | grep http'
      );
      const match = stdout.match(/LSHandlerRoleAll = "([^"]*)";/);
      if (!match) return null;
      const bundleId = match[1];
      const { stdout: appPathOut } = await asyncExec(
        `mdfind kMDItemCFBundleIdentifier = "${bundleId}"`
      );
      const appPath = appPathOut.trim();
      if (!appPath) return null;
      const exeName = path.basename(appPath, '.app');
      return path.join(appPath, 'Contents/MacOS', exeName);
    } catch (e) {
      return null;
    }
  } else if (platform === 'linux') {
    try {
      const { stdout } = await asyncExec('xdg-settings get default-web-browser');
      const desktopFile = stdout.trim();
      if (!desktopFile) return null;
      const locations = [
        path.join(os.homedir(), '.local/share/applications/'),
        '/usr/share/applications/',
        '/usr/local/share/applications/'
      ];
      let desktopPath: string | null = null;
      for (const loc of locations) {
        const p = path.join(loc, desktopFile);
        if (fs.existsSync(p)) {
          desktopPath = p;
          break;
        }
      }
      if (!desktopPath) return null;
      const content = fs.readFileSync(desktopPath, 'utf8');
      const execLine = content.split('\n').find(line => line.startsWith('Exec='));
      if (!execLine) return null;
      const execPath = execLine.slice(5).trim().split(' ')[0];
      return execPath || null;
    } catch (e) {
      return null;
    }
  }
  return null;
}

async function searchDesktopShortcuts(platform: string): Promise<string[]> {
  const desktopDir = path.join(os.homedir(), 'Desktop');
  if (!fs.existsSync(desktopDir)) return [];
  const shortcuts: string[] = [];
  const files = fs.readdirSync(desktopDir);
  for (const file of files) {
    const fullPath = path.join(desktopDir, file);
    let target: string | undefined;
    if (platform === 'win32' && file.toLowerCase().endsWith('.lnk')) {
      try {
        const { stdout } = await asyncExec(
          `powershell.exe -Command "$ws = New-Object -ComObject WScript.Shell; $sc = $ws.CreateShortcut('${fullPath.replace(/'/g, "''")}'); $sc.TargetPath"`
        );
        target = stdout.trim();
      } catch (e) {}
    } else if (platform === 'darwin') {
      try {
        const { stdout: kindOut } = await asyncExec(
          `mdls -name kMDItemKind "${fullPath.replace(/"/g, '\\"')}"`
        );
        if (kindOut.includes('Alias')) {
          const { stdout: origOut } = await asyncExec(
            `osascript -e 'tell application "Finder" to get POSIX path of (original item of item (POSIX file "${fullPath.replace(/"/g, '\\"')}") as alias)'`
          );
          target = origOut.trim();
        }
      } catch (e) {}
    } else if (platform === 'linux' && file.endsWith('.desktop')) {
      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        const execLine = content.split('\n').find(l => l.startsWith('Exec='));
        if (execLine) {
          target = execLine.slice(5).trim().split(' ')[0];
        }
      } catch (e) {}
    }
    if (target && isChromeLike(target)) {
      shortcuts.push(target);
    }
  }
  return shortcuts;
}

export async function findChromeBrowser(): Promise<string | null> {
  const platform = os.platform();
  if (!['win32', 'darwin', 'linux'].includes(platform)) {
    return null;
  }

  // Query default browser first
  const defaultPath = await getDefaultBrowserPath(platform);
  if (defaultPath && fs.existsSync(defaultPath) && isChromeLike(defaultPath)) {
    return defaultPath;
  }

  // Search known paths
  const knownPaths: { [key: string]: string[] } = {
    win32: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      'C:\\Program Files\\Chromium\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Chromium\\Application\\chrome.exe',
      path.join(os.homedir(), 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'),
      path.join(os.homedir(), 'AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(
        os.homedir(),
        'AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'
      ),
      path.join(os.homedir(), 'AppData\\Local\\Chromium\\Application\\chrome.exe')
    ],
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      path.join(os.homedir(), 'Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
      path.join(os.homedir(), 'Applications/Brave Browser.app/Contents/MacOS/Brave Browser'),
      path.join(os.homedir(), 'Applications/Chromium.app/Contents/MacOS/Chromium')
    ],
    linux: [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
      '/usr/bin/brave-browser',
      '/opt/google/chrome/chrome',
      '/opt/google/chrome/google-chrome',
      '/opt/chromium.org/chromium/chromium',
      '/opt/brave.com/brave/brave-browser',
      '/snap/bin/brave',
      '/snap/bin/chromium',
      '/snap/bin/microsoft-edge'
    ]
  };

  const paths = knownPaths[platform] || [];
  for (const p of paths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  // Look for shortcuts on desktop
  const desktopTargets = await searchDesktopShortcuts(platform);
  for (const target of desktopTargets) {
    if (fs.existsSync(target)) {
      return target;
    }
  }

  return null;
}
