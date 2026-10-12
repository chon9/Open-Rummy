#!/usr/bin/env node
// Secret scanner for Open Rummy. No dependencies; Node >= 22.
//
// Usage:
//   node scripts/check-secrets.mjs            scan files staged for commit (pre-commit hook mode)
//   node scripts/check-secrets.mjs --all      scan every tracked + untracked-but-not-ignored file
//   node scripts/check-secrets.mjs --path <file-or-dir> [...]
//                                             scan explicit paths (works outside git; used for testing)
//
// Exit codes: 0 = clean, 1 = possible secrets found, 2 = usage / git error.
//
// A line can be exempted by putting the marker "check-secrets: allow" in a comment on that line.
// Use it sparingly and only for values that are provably not secrets.

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, readdirSync, existsSync } from 'node:fs';
import { join, relative, resolve, basename, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = resolve(fileURLToPath(import.meta.url));
const ALLOW_MARKER = 'check-secrets: allow';
const MAX_BYTES = 5 * 1024 * 1024; // larger text files are almost certainly generated or binary

/** Extensions that are never scanned as text (binary assets). */
const BINARY_EXT = new Set([
  '.vrm', '.vrma', '.glb', '.gltf-binary', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico',
  '.bmp', '.ktx2', '.basis', '.hdr', '.exr', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp3', '.ogg',
  '.wav', '.m4a', '.mp4', '.webm', '.zip', '.gz', '.tgz', '.br', '.7z', '.pdf', '.wasm', '.bin',
]);

/** Files skipped by name (huge generated files with many hashes that look like tokens). */
const SKIP_NAMES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml']);

/** Directories never walked in --path mode (git modes already honour .gitignore). */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage']);

/**
 * Content rules. Each regex is tested per line. `mask` controls how much of the hit is echoed:
 * we never print a full secret to the terminal or CI logs.
 */
const CONTENT_RULES = [
  { id: 'aws-access-key-id', re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[0-9A-Z]{16}\b/ },
  {
    id: 'aws-secret-access-key',
    re: /aws_?secret_?access_?key["']?\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/i,
  },
  { id: 'private-key-pem', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/ },
  { id: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/ },
  { id: 'github-fine-grained-pat', re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { id: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { id: 'slack-webhook', re: /https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9_]+\/B[A-Za-z0-9_]+\/[A-Za-z0-9_]+/ },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'stripe-secret-key', re: /\b(?:sk|rk)_live_[0-9A-Za-z]{16,}\b/ },
  {
    // Generic "password = '...'" style assignment with a quoted literal of 8+ chars.
    id: 'generic-secret-assignment',
    re: /\b(?:password|passwd|pwd|secret|token|api[_-]?keys?|access[_-]?key|client[_-]?secret)\s*[:=]\s*["']([^"'\s]{8,})["']/i,
    // Obvious placeholders are fine (documentation, examples, env-var references).
    ignoreValue: /^(?:x+|\*+|\.+|changeme|change[_-]?me|example\S*|placeholder\S*|your[_-]\S*|dummy\S*|test\S*|redacted|<[^>]*>|\$\{[^}]*\}|process\.env\.\S+)$/i,
  },
];

/** File-name rules: committing these files at all is a mistake, whatever they contain. */
function fileNameFinding(relPath) {
  const name = basename(relPath).toLowerCase();
  if (name === '.env.example' || name === '.env.sample' || name === '.env.template') return null;
  if (name === '.env' || name.startsWith('.env.')) return 'env-file';
  const ext = extname(name);
  if (['.pem', '.key', '.p12', '.pfx', '.ppk', '.jks', '.keystore'].includes(ext)) return 'key-file';
  if (/^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/.test(name) && !name.endsWith('.pub')) return 'ssh-private-key-file';
  if (/^credentials.*\.json$/.test(name)) return 'credentials-file';
  if (name.startsWith('lightsaildefaultkey')) return 'lightsail-key-file';
  return null;
}

/** Show only the first 4 characters of a hit so logs never contain a usable secret. */
function mask(hit) {
  const s = hit.trim();
  return s.length <= 8 ? '****' : `${s.slice(0, 4)}...(${s.length} chars)`;
}

function isBinaryByName(relPath) {
  return BINARY_EXT.has(extname(relPath).toLowerCase());
}

/**
 * Scan one text buffer. Exported for tests / other tooling.
 * @param {string} relPath path used in messages and for name-based rules
 * @param {Buffer} buf file contents
 * @returns {{file: string, line: number, rule: string, excerpt: string}[]}
 */
export function scanBuffer(relPath, buf) {
  const findings = [];
  const nameRule = fileNameFinding(relPath);
  if (nameRule) findings.push({ file: relPath, line: 0, rule: nameRule, excerpt: 'file should not be committed' });
  if (isBinaryByName(relPath) || buf.length > MAX_BYTES || buf.includes(0)) return findings;

  const lines = buf.toString('utf8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes(ALLOW_MARKER)) continue;
    for (const rule of CONTENT_RULES) {
      const m = rule.re.exec(line);
      if (!m) continue;
      if (rule.ignoreValue && m[1] !== undefined && rule.ignoreValue.test(m[1])) continue;
      findings.push({ file: relPath, line: i + 1, rule: rule.id, excerpt: mask(m[0]) });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------
// File discovery

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: opts.encoding ?? 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

function gitRoot() {
  try {
    return git(['rev-parse', '--show-toplevel']).trim();
  } catch {
    return null;
  }
}

/** NUL-separated output -> list of repo-relative paths. */
function splitZ(out) {
  return out.split('\0').filter(Boolean);
}

/** Recursively list files. SKIP_DIRS applies to nested directories, not to the roots given. */
function walk(absPath, out, isRoot = true) {
  const st = statSync(absPath);
  if (st.isDirectory()) {
    if (!isRoot && SKIP_DIRS.has(basename(absPath))) return;
    for (const entry of readdirSync(absPath)) walk(join(absPath, entry), out, false);
  } else if (st.isFile()) {
    out.push(absPath);
  }
}

/** Is this the scanner itself? Its own regex literals would otherwise match. */
function isSelf(absPath) {
  return resolve(absPath).toLowerCase() === SELF.toLowerCase();
}

/**
 * Yields {rel, read} pairs: `read()` returns the bytes to scan. In staged mode we read the
 * staged blob (what will actually be committed), not the working-tree file.
 */
function collectTargets(mode, paths) {
  const targets = [];
  if (mode === 'path') {
    const files = [];
    for (const p of paths) {
      const abs = resolve(p);
      if (!existsSync(abs)) throw new Error(`no such path: ${p}`);
      walk(abs, files);
    }
    for (const abs of files) {
      if (isSelf(abs)) continue;
      targets.push({ rel: relative(process.cwd(), abs).split(sep).join('/') || basename(abs), read: () => readFileSync(abs) });
    }
    return targets;
  }

  const root = gitRoot();
  if (!root) throw new Error('not inside a git repository (use --path to scan arbitrary files)');
  const list =
    mode === 'all'
      ? splitZ(git(['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard']))
      : splitZ(git(['-C', root, 'diff', '--cached', '--name-only', '--diff-filter=ACM', '-z']));

  for (const rel of [...new Set(list)]) {
    const abs = join(root, rel);
    if (isSelf(abs)) continue;
    if (mode === 'all') {
      // Tracked files deleted from the working tree are still listed by ls-files; skip them.
      if (!existsSync(abs) || !statSync(abs).isFile()) continue;
      targets.push({ rel, read: () => readFileSync(abs) });
    } else {
      targets.push({ rel, read: () => git(['-C', root, 'show', `:${rel}`], { encoding: 'buffer' }) });
    }
  }
  return targets;
}

// ---------------------------------------------------------------------------------------------
// CLI

function main(argv) {
  let mode = 'staged';
  const paths = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') mode = 'all';
    else if (a === '--path') {
      mode = 'path';
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) paths.push(argv[++i]);
    } else if (a === '-h' || a === '--help') {
      console.log('usage: node scripts/check-secrets.mjs [--all | --path <file-or-dir>...]');
      return 0;
    } else {
      console.error(`check-secrets: unknown argument ${a}`);
      return 2;
    }
  }
  if (mode === 'path' && paths.length === 0) {
    console.error('check-secrets: --path needs at least one file or directory');
    return 2;
  }

  let targets;
  try {
    targets = collectTargets(mode, paths);
  } catch (err) {
    console.error(`check-secrets: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  const findings = [];
  let scanned = 0;
  for (const t of targets) {
    if (SKIP_NAMES.has(basename(t.rel))) continue;
    let buf;
    try {
      // Name rules still apply to binaries, so only skip the read for binary extensions.
      buf = isBinaryByName(t.rel) ? Buffer.alloc(0) : t.read();
    } catch (err) {
      console.error(`check-secrets: cannot read ${t.rel}: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
    scanned++;
    findings.push(...scanBuffer(t.rel, buf));
  }

  if (findings.length === 0) {
    console.log(`check-secrets: OK (${scanned} file${scanned === 1 ? '' : 's'} scanned, mode=${mode})`);
    return 0;
  }
  console.error(`check-secrets: ${findings.length} possible secret(s) found:`);
  for (const f of findings) {
    const loc = f.line > 0 ? `${f.file}:${f.line}` : f.file;
    console.error(`  ${loc}  [${f.rule}]  ${f.excerpt}`);
  }
  console.error(
    '\nRemove the secret (rotate it if it was ever pushed), move it to an untracked env file,\n' +
      `or, if it is a false positive, add a "${ALLOW_MARKER}" comment on that line.`,
  );
  return 1;
}

// Only run the CLI when executed directly, so scanBuffer can be imported by tests.
if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === SELF.toLowerCase()) {
  process.exitCode = main(process.argv.slice(2));
}
