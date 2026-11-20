import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export function listQzoneTests(directory) {
  // Discovery is not a security sandbox: review newly added matching test files
  // before running the suite. Individual tests must use fixtures or fake I/O.
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^test-qzone-.*\.mjs$/.test(entry.name))
    .map((entry) => join(directory, entry.name)).sort();
}

export function runQzoneTests(files, { spawn = spawnSync } = {}) {
  if (!Array.isArray(files) || files.length === 0) return 1;
  try {
    const result = spawn(process.execPath, ['--test', ...files], { stdio: 'inherit', shell: false });
    return result?.error || !Number.isInteger(result?.status) ? 1 : result.status;
  } catch { return 1; }
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try { process.exitCode = runQzoneTests(listQzoneTests(dirname(scriptPath))); }
  catch { process.exitCode = 1; }
}
