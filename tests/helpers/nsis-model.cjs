'use strict';
// A small symbolic NSIS runner for path/stack and manifest-removal regressions.
// It does not replace a Windows installer integration test.
const fs = require('node:fs');
const path = require('node:path');
module.exports = function nsisModel({ installDir = 'E:\\Apps\\Mineradio', files = {}, registry = {}, reparse = [] } = {}) {
  const functions = new Map(), variables = {}, stack = [], handles = new Map(), removed = [];
  const normalize = value => path.win32.normalize(value).toLowerCase();
  const entries = new Map(Object.entries(files).map(([key, value]) => [normalize(key), value]));
  const directories = new Set([normalize(installDir)]), reparses = new Set(reparse.map(normalize));
  for (const file of entries.keys()) {
    let parent = path.win32.dirname(file);
    while (parent !== path.win32.dirname(parent)) { directories.add(parent); parent = path.win32.dirname(parent); }
  }
  for (const file of ['installer.nsh', 'uninstall-manifest.nsh']) {
    const lines = fs.readFileSync(path.join(__dirname, '../../build', file), 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const match = /^Function (\S+)/.exec(lines[i]); if (!match) continue;
      const body = [];
      for (i++; i < lines.length && lines[i].trim() !== 'FunctionEnd'; i++) body.push(lines[i].trim());
      functions.set(match[1], body);
    }
  }
  const defines = { MINERADIO_INSTALL_DIR_NAME: 'Mineradio', MINERADIO_INSTALL_DIR_NAME_LOWER: 'mineradio', MINERADIO_INSTALL_MARKER: '.mineradio-install-root', MINERADIO_MARKER_APP_ID: 'com.mineradio.desktop', PRODUCT_FILENAME: 'Mineradio', APP_GUID: 'app-guid', UNINSTALL_APP_KEY: 'uninstall-key' };
  variables.$INSTDIR = installDir;
  let errors = false, nextHandle = 1;
  const tokens = line => line.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  const value = token => String(token ?? '').replace(/^("|')|("|')$/g, '').replace(/\$\{([^}]+)\}/g, (_, name) => defines[name] ?? '${' + name + '}')
    .replace(/\$\\r/g, '\r').replace(/\$\\n/g, '\n').replace(/\$(?:R\d|\d|INSTDIR\b)/g, key => variables[key] ?? '');
  function condition(line) {
    if (line === '${Errors}') return errors;
    const [a, op, b] = tokens(line), left = value(a), right = value(b);
    if (op === '==') return left.toLowerCase() === right.toLowerCase();
    if (op === '!=') return left.toLowerCase() !== right.toLowerCase();
    if (op === '<') return Number(left) < Number(right);
    if (op === '>') return Number(left) > Number(right);
    throw new Error('Unsupported NSIS condition: ' + line);
  }
  function boundary(body, from, includeElse) {
    let depth = 0;
    for (let i = from + 1; i < body.length; i++) {
      if (body[i].startsWith('${If}')) depth++;
      if (body[i] === '${EndIf}') { if (!depth) return i; depth--; }
      if (includeElse && !depth && (body[i] === '${Else}' || body[i].startsWith('${ElseIf}'))) return i;
    }
    throw new Error('Missing NSIS condition boundary');
  }
  function exists(file) {
    file = normalize(file);
    if (file.endsWith('\\*.*')) return directories.has(file.slice(0, -4));
    return entries.has(file) || directories.has(file);
  }
  function invoke(name) {
    const body = functions.get(name); if (!body) throw new Error('Unknown NSIS function ' + name);
    let steps = 0;
    for (let ip = 0; ip < body.length; ip++) {
      if (++steps > 50000) throw new Error('NSIS symbolic loop in ' + name);
      const line = body[ip]; if (!line || line.startsWith(';') || line.endsWith(':')) continue;
      const jump = target => {
        if (!target || target === '0') return;
        if (/^[+-]\d+$/.test(target)) { ip += Number(target) - 1; return; }
        ip = body.indexOf(target + ':'); if (ip < 0) throw new Error('Unknown NSIS label ' + target);
      };
      if (/^\$\{(?:If|ElseIf)\}/.test(line)) {
        let pass = condition(line.replace(/^\$\{(?:If|ElseIf)\}\s+/, ''));
        while (/^\$\{(?:AndIf|OrIf)\}/.test(body[ip + 1] || '')) {
          const next = body[++ip], result = condition(next.replace(/^\$\{(?:AndIf|OrIf)\}\s+/, ''));
          pass = next.startsWith('${AndIf}') ? pass && result : pass || result;
        }
        if (!pass) { const end = boundary(body, ip, true); ip = body[end].startsWith('${ElseIf}') ? end - 1 : end; }
        continue;
      }
      if (line === '${Else}') { ip = boundary(body, ip, false); continue; }
      if (line === '${EndIf}') continue;
      const t = tokens(line), op = t[0];
      if (op === 'Push') stack.push(value(t[1]));
      else if (op === 'Pop') { if (!stack.length) throw new Error('NSIS stack underflow'); variables[t[1]] = stack.pop(); }
      else if (op === 'Exch') { const old = variables[t[1]] || ''; variables[t[1]] = stack.pop(); stack.push(old); }
      else if (op === 'StrCpy') {
        let result = value(t[2]), offset = Number(value(t[4])) || 0;
        if (offset < 0) offset += result.length; result = result.slice(offset);
        if (t[3] !== undefined && value(t[3]) !== '') result = result.slice(0, Number(value(t[3])));
        variables[t[1]] = result;
      } else if (op === 'StrLen') variables[t[1]] = String(value(t[2]).length);
      else if (op === 'IntOp') { const a = Number(value(t[2])), b = Number(value(t[4])); variables[t[1]] = String(t[3] === '+' ? a + b : t[3] === '&' ? a & b : a - b); }
      else if (op === 'Call') invoke(t[1]);
      else if (op === 'Return') return;
      else if (op === 'Goto') jump(t[1]);
      else if (op === 'StrCmp') jump(value(t[1]).toLowerCase() === value(t[2]).toLowerCase() ? t[3] : t[4]);
      else if (op === 'IfFileExists') jump(exists(value(t[1])) ? t[2] : t[3]);
      else if (op === 'ReadRegStr') variables[t[1]] = registry[[t[2], value(t[3]), value(t[4])].join('|')] || '';
      else if (op === 'GetFullPathName') variables[t[1]] = path.win32.resolve(value(t[2]));
      else if (op === '${GetParent}') variables[t[2]] = path.win32.dirname(value(t[1]));
      else if (op === 'System::Call' && line.includes('GetFileAttributesW')) { const file = value('$4'); variables.$5 = reparses.has(normalize(file)) ? '1024' : exists(file) ? '0' : '-1'; }
      else if (op === 'ClearErrors') errors = false;
      else if (op === 'FileOpen') {
        const file = normalize(value(t[2])); errors = !entries.has(file);
        const handle = String(nextHandle++); variables[t[1]] = handle;
        if (!errors) handles.set(handle, { lines: String(entries.get(file)).match(/[^\n]*\n|[^\n]+$/g) || [], offset: 0 });
      } else if (op === 'FileReadUTF16LE') {
        const handle = handles.get(value(t[1])); errors = !handle || handle.offset >= handle.lines.length;
        variables[t[2]] = errors ? '' : handle.lines[handle.offset++];
      } else if (op === 'FileClose') handles.delete(value(t[1]));
      else if (op === 'Delete') { const file = normalize(value(t[1])); removed.push(file); entries.delete(file); }
      else if (op === 'RMDir') {
        const dir = normalize(value(t[1]));
        if (![...entries.keys(), ...directories].some(file => file !== dir && file.startsWith(dir + '\\'))) { removed.push(dir); directories.delete(dir); }
      } else if (op === 'SetOutPath' || op === 'DetailPrint') { /* No state needed. */ }
      else throw new Error('Unsupported NSIS instruction: ' + line);
    }
  }
  return { variables, stack, entries, directories, removed, invoke,
    call(name, argument) { stack.push(argument); invoke(name); return stack.pop(); } };
};
