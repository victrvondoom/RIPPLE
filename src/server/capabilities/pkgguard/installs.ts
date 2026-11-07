/**
 * Install-line parsing (the "Scout" concept: read a chat message, find every package an install command would fetch).
 * Pure and offline. Recognised tools: npm, yarn, pnpm, bun, npx/bunx/pnpm dlx, pip/pip3/python -m pip, uv (pip install / add),
 * poetry add, pipenv install. Anything that is not a registry package name (URLs, git refs, local paths, requirement
 * files, tarballs, npm: aliases) is reported in `skipped` with a reason, never silently dropped.
 */
export type Ecosystem = 'npm' | 'pypi';
export interface PackageRef { ecosystem: Ecosystem; name: string; version?: string; raw: string; tool: string }
export interface InstallParse { packages: PackageRef[]; skipped: { raw: string; reason: string }[]; commands: string[] }

/** Flags that consume the next token as their value (so the value is never mistaken for a package). */
const NPM_VALUE_FLAGS = new Set(['--registry', '--prefix', '-C', '--cwd', '--tag', '--workspace', '-w', '--filter', '--cache', '--userconfig', '-p', '--package']);
const PIP_VALUE_FLAGS = new Set(['-i', '--index-url', '--extra-index-url', '-f', '--find-links', '-t', '--target', '--prefix', '--root', '-c', '--constraint', '--python', '-p', '--group', '--source', '--platform', '--python-version', '--implementation', '--abi', '--cache-dir', '--src', '--trusted-host', '--progress-bar', '--log', '--timeout', '--proxy', '--retries']);
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;
const PY_SPEC = /^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*(?:(===|==|~=|!=|>=|<=|>|<)\s*([^,;\s]+))?.*$/;

function tokenize(cmd: string): string[] {
  const out: string[] = []; let cur = ''; let q: string | null = null;
  for (const ch of cmd) {
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    if (/\s/.test(ch)) { if (cur) out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function npmSpec(tok: string): { name: string; version?: string } | string {
  if (/^(?:https?:|git\+|git:|github:|gitlab:|bitbucket:|file:|link:|workspace:|npm:)/i.test(tok)) return 'not a registry name (URL, git, file, workspace or alias)';
  if (/^[./~]/.test(tok) || /\.(?:tgz|tar\.gz)$/i.test(tok)) return 'local path or tarball';
  if (/^[\w.-]+\/[\w.-]+$/.test(tok) && !tok.startsWith('@')) return 'GitHub shorthand (user/repo), not a registry name';
  const at = tok.lastIndexOf('@');
  const name = at > 0 ? tok.slice(0, at) : tok;
  const version = at > 0 ? tok.slice(at + 1) : undefined;
  if (!NPM_NAME.test(name)) return 'not a valid npm package name';
  return { name: name.toLowerCase(), version: version || undefined };
}

function pySpec(tok: string): { name: string; version?: string } | string {
  if (/^(?:https?:|git\+|file:|svn\+|hg\+)/i.test(tok) || tok.includes('://')) return 'not a registry name (URL or VCS)';
  if (/^[./~]/.test(tok) || /\.(?:whl|tar\.gz|zip)$/i.test(tok)) return 'local path or archive';
  const m = PY_SPEC.exec(tok);
  if (!m) return 'not a valid Python requirement';
  // PEP 503 normalisation: case-insensitive, runs of -, _ and . are equivalent.
  const name = m[1].toLowerCase().replace(/[-_.]+/g, '-');
  const version = m[3] === '==' || m[3] === '===' ? m[4] : undefined;
  return { name, version };
}

interface Tool { re: RegExp; eco: Ecosystem; tool: string; valueFlags: Set<string>; single?: boolean }
// Each pattern matches the command words; the remainder of the command is the argument list.
const TOOLS: Tool[] = [
  { re: /^(?:sudo\s+)?npm\s+(?:install|i|add|isntall|in)\b/, eco: 'npm', tool: 'npm', valueFlags: NPM_VALUE_FLAGS },
  { re: /^(?:sudo\s+)?yarn\s+(?:global\s+)?add\b/, eco: 'npm', tool: 'yarn', valueFlags: NPM_VALUE_FLAGS },
  { re: /^(?:sudo\s+)?pnpm\s+(?:add|install|i)\b/, eco: 'npm', tool: 'pnpm', valueFlags: NPM_VALUE_FLAGS },
  { re: /^(?:sudo\s+)?bun\s+(?:add|install|i)\b/, eco: 'npm', tool: 'bun', valueFlags: NPM_VALUE_FLAGS },
  { re: /^(?:npx|bunx|pnpm\s+dlx|yarn\s+dlx)\b/, eco: 'npm', tool: 'npx', valueFlags: NPM_VALUE_FLAGS, single: true },
  { re: /^(?:sudo\s+)?(?:uv\s+pip|python3?\s+-m\s+pip|py\s+-m\s+pip|pip3?)\s+install\b/, eco: 'pypi', tool: 'pip', valueFlags: PIP_VALUE_FLAGS },
  { re: /^uv\s+add\b/, eco: 'pypi', tool: 'uv', valueFlags: PIP_VALUE_FLAGS },
  { re: /^poetry\s+add\b/, eco: 'pypi', tool: 'poetry', valueFlags: PIP_VALUE_FLAGS },
  { re: /^pipenv\s+install\b/, eco: 'pypi', tool: 'pipenv', valueFlags: PIP_VALUE_FLAGS },
];

/** Splits a message into shell commands (lines, &&, ||, ;, |) and strips prompts and code fences. */
export function commandsIn(text: string): string[] {
  return text.replace(/```[a-z]*\n?/gi, '\n').split(/\n|&&|\|\||;|\|/)
    .map((c) => c.trim().replace(/^(?:\$|>|#)\s+/, '').replace(/^`|`$/g, '').trim())
    .filter(Boolean);
}

export function parseInstalls(text: string): InstallParse {
  const res: InstallParse = { packages: [], skipped: [], commands: [] };
  for (const cmd of commandsIn(text)) {
    // The tool may sit mid-sentence ("please run npm i foo"), so search for it after a word boundary.
    let tool: Tool | undefined; let rest = '';
    for (const t of TOOLS) {
      const m = new RegExp(`(?:^|[\\s\`(])(?:${t.re.source.slice(1)})`).exec(cmd);
      if (m) { tool = t; rest = cmd.slice(m.index + m[0].length); break; }
    }
    if (!tool) continue;
    res.commands.push(cmd);
    const args = tokenize(rest);
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a.startsWith('-')) {
        if (tool.eco === 'pypi' && (a === '-r' || a === '--requirement' || a === '-e' || a === '--editable')) { res.skipped.push({ raw: `${a} ${args[i + 1] ?? ''}`.trim(), reason: 'requirement file or editable install: the file is not read here' }); i++; continue; }
        // npx -p <pkg> is a package, not a flag value.
        if (tool.single && (a === '-p' || a === '--package') && args[i + 1]) { const s = npmSpec(args[++i]); if (typeof s === 'string') res.skipped.push({ raw: args[i], reason: s }); else res.packages.push({ ecosystem: 'npm', ...s, raw: args[i], tool: tool.tool }); continue; }
        if (tool.valueFlags.has(a) && !a.includes('=')) i++;
        continue;
      }
      const s = tool.eco === 'npm' ? npmSpec(a) : pySpec(a);
      if (typeof s === 'string') res.skipped.push({ raw: a, reason: s });
      else res.packages.push({ ecosystem: tool.eco, ...s, raw: a, tool: tool.tool });
      if (tool.single) break; // npx runs one package; the rest are that package's own arguments
    }
  }
  return res;
}
