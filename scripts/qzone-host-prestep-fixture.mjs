import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_ASAR = 'D:/DSH Desktop/resources/app.asar';
const PACKAGES = [
  '@deepseek-ai/cordis', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-agent-loop',
  '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-projection',
  '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-tool-executor-native',
];

export async function loadOfflineHostFixture() {
  const archive = process.env.DSH_ASAR ?? DEFAULT_ASAR;
  if (!fs.existsSync(archive)) throw new Error(`本机找不到 DSH app.asar：${archive}`);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-qzone-prestep-'));
  try {
    extractDependencyGraph(archive, tempRoot);
    const module = (name) => path.join(tempRoot, 'dsh', 'node_modules', ...name.split('/'), 'lib', 'index.js');
    const [cordis, agent, agentLoop, llm, session, projection, systemPrompt, tools, nativeExecutor] = await Promise.all(
      PACKAGES.map((name) => import(pathToFileURL(module(name)))),
    );
    return {
      archive,
      tempRoot,
      cordis,
      session,
      projection,
      agent,
      agentLoop,
      llm,
      tools,
      nativeExecutor,
      systemPrompt,
      close() { fs.rmSync(tempRoot, { recursive: true, force: true }); },
    };
  } catch (error) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

function extractDependencyGraph(archive, targetRoot) {
  const { header, dataOffset, fd } = openArchive(archive);
  const seen = new Set();
  const queue = [...PACKAGES];
  try {
    while (queue.length) {
      const packageName = queue.shift();
      if (seen.has(packageName)) continue;
      seen.add(packageName);
      const packagePath = `dsh/node_modules/${packageName}`;
      const entry = findEntry(header, packagePath);
      if (!entry?.files) {
        if (PACKAGES.includes(packageName)) throw new Error(`app.asar 缺少依赖包 ${JSON.stringify(packageName)}`);
        continue;
      }
      for (const [relative, source] of extractTree(fd, dataOffset, entry, targetRoot, packagePath, archive)) {
        if (relative === 'package.json') {
          const metadata = JSON.parse(source);
          queue.push(...Object.keys(metadata.dependencies ?? {}));
        }
        for (const match of source.matchAll(/(?:from\s*|import\s*\()\s*["']([^"']+)["']/gu)) {
          const name = packageNameOf(match[1]);
          if (name && !seen.has(name)) queue.push(name);
        }
      }
    }
  } finally { fs.closeSync(fd); }
}

function openArchive(archive) {
  const fd = fs.openSync(archive, 'r');
  try {
    const prefix = Buffer.alloc(16);
    if (fs.readSync(fd, prefix, 0, 16, 0) !== 16 || prefix.readUInt32LE(0) !== 4) throw new Error('app.asar header 无效');
    const headerLength = prefix.readUInt32LE(12);
    const dataOffset = 8 + prefix.readUInt32LE(4);
    const bytes = Buffer.alloc(headerLength);
    if (fs.readSync(fd, bytes, 0, bytes.length, 16) !== bytes.length) throw new Error('app.asar header 截断');
    return { fd, dataOffset, header: JSON.parse(bytes.toString('utf8')) };
  } catch (error) { fs.closeSync(fd); throw error; }
}

function findEntry(header, relativePath) {
  let current = header;
  for (const part of relativePath.split('/')) {
    assertSafeSegment(part);
    current = current?.files?.[part];
    if (!current) return null;
  }
  return current;
}

function extractTree(fd, dataOffset, entry, targetRoot, archivePath, archive) {
  const root = path.resolve(targetRoot);
  const sources = new Map();
  const walk = (node, relativePath) => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      assertSafeSegment(name);
      const childPath = `${relativePath}/${name}`;
      if (child.files) { walk(child, childPath); continue; }
      if (child.link || !Number.isSafeInteger(child.size) || child.size > 8 * 1024 * 1024) continue;
      let bytes;
      if (child.unpacked === true) {
        const unpackedRoot = path.resolve(`${archive}.unpacked`);
        const unpackedPath = path.resolve(unpackedRoot, ...childPath.split('/'));
        assertInside(unpackedRoot, unpackedPath);
        bytes = fs.readFileSync(unpackedPath);
        if (bytes.length !== child.size) throw new Error(`app.asar unpacked entry size mismatch: ${childPath}`);
      } else {
        bytes = Buffer.alloc(child.size);
        if (child.size && fs.readSync(fd, bytes, 0, bytes.length, dataOffset + Number(child.offset)) !== bytes.length) throw new Error(`app.asar entry 截断：${childPath}`);
      }
      const destination = path.resolve(root, ...childPath.split('/'));
      assertInside(root, destination);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, bytes);
      if (name === 'package.json' || /\.(?:mjs|cjs|js)$/u.test(name)) sources.set(childPath.slice(archivePath.length + 1), bytes.toString('utf8'));
    }
  };
  walk(entry, archivePath);
  return sources;
}

function assertInside(root, destination) {
  const relative = path.relative(root, destination);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`拒绝越界路径：${destination}`);
}

function assertSafeSegment(segment) {
  if (typeof segment !== 'string' || !segment || segment === '.' || segment === '..' || /[\\/:\0]/u.test(segment)
    || path.posix.isAbsolute(segment) || path.win32.isAbsolute(segment)) throw new Error(`拒绝不安全的 app.asar 路径段：${JSON.stringify(segment)}`);
}

function packageNameOf(specifier) {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) return null;
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  return /^@[\w.-]+\/[\w.-]+$/u.test(name) || /^[\w.-]+$/u.test(name) ? name : null;
}
