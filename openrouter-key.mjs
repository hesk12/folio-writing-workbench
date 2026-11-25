import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// Only the signed-in Windows user can decrypt this file with DPAPI.
function convert(value, protect) {
  const command = protect
    ? '$bytes=[Text.Encoding]::UTF8.GetBytes($value); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($bytes,$null,"CurrentUser"))'
    : '$bytes=[Convert]::FromBase64String($value); [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,"CurrentUser"))';
  const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  return execFileSync(powershell, ['-NoProfile','-NonInteractive','-Command',
    '$ErrorActionPreference="Stop"; Add-Type -AssemblyName System.Security; $value=[Console]::In.ReadToEnd(); ' + command],
    { input:value, encoding:'utf8', stdio:['pipe','pipe','ignore'], windowsHide:true, timeout:15000 }).trim();
}
export function keyStore(directory) {
  const file = path.join(directory, 'openrouter.dpapi');
  return {
    load(fallback) {
      if (!fs.existsSync(file)) return fallback;
      try { return convert(fs.readFileSync(file, 'utf8'), false); }
      catch { return ''; } // The settings dialog can replace an unreadable credential.
    },
    save(key) {
      const ciphertext = convert(key, true);
      fs.mkdirSync(directory, {recursive:true});
      const tmp = path.join(directory, randomUUID() + '.tmp');
      try {
        fs.writeFileSync(tmp, ciphertext, {flag:'wx'});
        fs.renameSync(tmp, file);
      } finally { fs.rmSync(tmp, {force:true}); }
    }
  };
}
