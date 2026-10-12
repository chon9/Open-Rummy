#!/usr/bin/env node
// Installs a git pre-commit hook that runs scripts/check-secrets.mjs on staged files.
// Run once after cloning:  node scripts/install-hooks.mjs
// Works with Git for Windows (Git Bash runs hooks through sh) as well as Linux/macOS.

import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const MARKER = '# open-rummy: check-secrets hook';

const HOOK = `#!/bin/sh
${MARKER}
# Installed by scripts/install-hooks.mjs. Blocks commits that contain likely secrets.
# Bypass only for a verified false positive:  git commit --no-verify
cd "$(git rev-parse --show-toplevel)" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "pre-commit: node not found on PATH; cannot run the secret scan" >&2
  exit 1
fi
exec node scripts/check-secrets.mjs
`;

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

let root;
try {
  root = git(['rev-parse', '--show-toplevel']);
} catch {
  console.error('install-hooks: not inside a git repository');
  process.exit(1);
}

// --git-path honours core.hooksPath and worktrees; it may return a path relative to the cwd.
let hooksDir = git(['rev-parse', '--git-path', 'hooks']);
if (!isAbsolute(hooksDir)) hooksDir = join(process.cwd(), hooksDir);
mkdirSync(hooksDir, { recursive: true });

const hookPath = join(hooksDir, 'pre-commit');
if (existsSync(hookPath)) {
  const current = readFileSync(hookPath, 'utf8');
  if (!current.includes(MARKER)) {
    // Someone else's hook: keep a copy instead of silently clobbering it.
    copyFileSync(hookPath, `${hookPath}.bak`);
    console.log(`install-hooks: existing pre-commit hook backed up to ${hookPath}.bak`);
  }
}

// LF line endings matter: sh on Linux chokes on CRLF shebangs.
writeFileSync(hookPath, HOOK, { encoding: 'utf8' });
try {
  chmodSync(hookPath, 0o755);
} catch {
  // chmod is a no-op on some Windows filesystems; Git for Windows runs hooks regardless.
}
console.log(`install-hooks: pre-commit hook installed at ${hookPath} (repo: ${root})`);
