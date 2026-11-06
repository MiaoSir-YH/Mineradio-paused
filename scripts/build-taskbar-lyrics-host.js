'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const source = path.join(projectRoot, 'desktop', 'native', 'taskbar-lyrics-host.cs');
const clickSequenceSource = path.join(projectRoot, 'desktop', 'native', 'taskbar-lyrics-click-sequence.cs');
const manifest = path.join(projectRoot, 'desktop', 'native', 'taskbar-lyrics-host.manifest');

function compileHost(output) {
  if (process.platform !== 'win32') throw new Error('The taskbar lyrics host can only be built on Windows');
  const windowsDir = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const compilers = ['Framework64', 'Framework'].map(name => path.join(windowsDir, 'Microsoft.NET', name, 'v4.0.30319', 'csc.exe'));
  const compiler = compilers.find(file => fs.existsSync(file));
  if (!compiler) throw new Error('The .NET Framework C# compiler was not found');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const result = spawnSync(compiler, [
    '/nologo', '/target:exe', '/platform:x64', `/win32manifest:${manifest}`, `/out:${output}`, source, clickSequenceSource,
  ], { windowsHide: true, encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(`Taskbar lyrics host compilation failed: ${result.error && result.error.message || result.stderr || result.stdout || result.status}`);
  }
  if (!fs.existsSync(output)) throw new Error('Taskbar lyrics host compiler did not produce an executable');
  return output;
}

function ensureDevelopmentHost() {
  const hash = crypto.createHash('sha256').update(fs.readFileSync(source)).update(fs.readFileSync(clickSequenceSource)).update(fs.readFileSync(manifest)).digest('hex').slice(0, 20);
  const dir = path.join(os.tmpdir(), 'mineradio-taskbar-lyrics-host', hash);
  const output = path.join(dir, 'taskbar-lyrics-host.exe');
  if (fs.existsSync(output)) return output;
  fs.mkdirSync(dir, { recursive: true });
  const temporary = path.join(dir, `taskbar-lyrics-host-${process.pid}-${crypto.randomBytes(4).toString('hex')}.exe`);
  try {
    compileHost(temporary);
    try { fs.renameSync(temporary, output); } catch (error) { if (!fs.existsSync(output)) throw error; }
    return output;
  } finally {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch (_) {}
  }
}

async function beforePack(context) {
  if (!context || context.electronPlatformName !== 'win32') return;
  compileHost(path.join(context.appDir || projectRoot, 'build', 'taskbar-lyrics-host.exe'));
}

beforePack.compileHost = compileHost;
beforePack.ensureDevelopmentHost = ensureDevelopmentHost;
module.exports = beforePack;
