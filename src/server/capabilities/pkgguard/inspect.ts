/**
 * Static code rules (the "Inspector" concept): read a package archive as text, in memory, and report what malware does.
 * Nothing is installed, extracted to disk, imported or executed. The output is a list of rule hits with file and line,
 * never code excerpts, so a report can be stored and shared without carrying the payload.
 *
 * The rule table is the whole method. `INSPECT_RULES_VERSION` changes whenever a rule or threshold changes, and the
 * benchmark records which version produced each number.
 */
import { asText, readArchive, type ArchiveEntry } from './archive.js';
import type { Ecosystem } from './installs.js';

export const INSPECT_RULES_VERSION = 'inspect@2';
/**
 * Change log (each change was made on the 30% TUNING split only; see bench/pkgguard/README.md):
 *  inspect@1  first rule table, written before any data was read.
 *  inspect@2  docs (README, PKG-INFO, .md/.rst/.txt/.html) are read only for agent-directed text; test, docs, example and CI
 *             folders count only rules of weight >= 5; credential-file paths no longer count as "collects" for
 *             collect-and-send; Discord/Telegram APIs split out as a weaker `messaging_api`; new `py_fetch_exec`,
 *             `js_fetch_eval` and `pip_install_url` rules; .pth files no longer get the install-time bonus.
 */
export const INSPECT_THRESHOLDS = { review: 4, malicious: 7, hookBonus: 2, collectAndSendBonus: 3 } as const;

type Lang = 'js' | 'py' | 'any';
interface Rule { id: string; lang: Lang; weight: number; re: RegExp; what: string; minCount?: number; setupOnly?: boolean; docsOnly?: boolean }

const PRIVATE_IP = String.raw`(?!(?:127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|255\.))`;
export const RULES: Rule[] = [
  // ----- any language -----
  { id: 'exfil_endpoint', lang: 'any', weight: 4, what: 'sends data to a request-capture / out-of-band service', re: /webhook\.site|pipedream\.net|requestbin\.|\.oast\.(?:fun|me|pro|live|site|online)|\binteract\.sh|burpcollaborator\.net|\.ngrok(?:-free)?\.(?:io|app)|canarytokens\.|beeceptor\.com|hookbin\.com|requestcatcher\.com/i },
  { id: 'messaging_api', lang: 'any', weight: 2, what: 'posts to a Discord webhook or Telegram bot (a common exfiltration channel, also used by legitimate integrations)', re: /discord(?:app)?\.com\/api\/webhooks|api\.telegram\.org\/bot/i },
  { id: 'pip_install_url', lang: 'any', weight: 4, what: 'installs another package from a URL at run time', re: /(?:subprocess\.\w+|os\.system|exec\w*|spawn\w*)\s*\([^)\n]{0,160}(?:pip['"]?\s*,?\s*['"]?install|npm['"]?\s*,?\s*['"]?(?:install|i)\b)[^)\n]{0,160}(?:https?:\/\/|git\+|\b[A-Z_]{3,}_URL\b)/ },
  { id: 'raw_ip_url', lang: 'any', weight: 2, what: 'talks to a hard-coded public IP address', re: new RegExp(String.raw`https?:\/\/${PRIVATE_IP}(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?`) },
  { id: 'credential_paths', lang: 'any', weight: 2, what: 'reads developer credential files (.npmrc, ~/.ssh, ~/.aws, .git-credentials, kube/docker config)', re: /\.ssh[/\\](?:id_[a-z0-9]+|authorized_keys)|\.aws[/\\]credentials|\.git-credentials|\.docker[/\\]config\.json|\.kube[/\\]config|\.config[/\\]gcloud|['"`/\\]\.pypirc|['"`/\\]\.npmrc['"`]/ },
  { id: 'browser_data', lang: 'any', weight: 3, what: 'reads browser password / cookie / token stores', re: /Login Data['"]|Local State['"]|Local Storage[/\\]+leveldb|User Data[/\\]+Default|cookies\.sqlite|key4\.db/ },
  { id: 'wallet_files', lang: 'any', weight: 3, what: 'reads crypto-wallet files or wallet extensions', re: /wallet\.dat|[Ee]thereum[/\\]+keystore|Exodus[/\\]|nkbihfbeogaeaoehlefnkodbefgpgknn|\.electrum|solana[/\\]+id\.json|Atomic[/\\]+Local Storage/ },
  { id: 'reverse_shell', lang: 'any', weight: 5, what: 'opens a reverse shell', re: /\/dev\/tcp\/\S|bash -i >&|\bnc(?:at)? -e \/bin|mkfifo \/tmp\/\w+;/ },
  { id: 'persistence', lang: 'any', weight: 3, what: 'installs itself to run at login / boot', re: /CurrentVersion\\{1,2}Run\b|Start Menu\\{1,2}Programs\\{1,2}Startup|schtasks(?:\.exe)? \/create|Library\/LaunchAgents\/|\/etc\/systemd\/system\/[\w.-]+\.service/i },
  { id: 'powershell_hidden', lang: 'any', weight: 4, what: 'runs hidden or encoded PowerShell', re: /powershell(?:\.exe)?[^\n]{0,60}\s-(?:e|en|enc|encodedcommand|w(?:indowstyle)?\s+hidden|nop)\b/i },
  { id: 'download_and_run', lang: 'any', weight: 4, what: 'downloads something and runs it', re: /(?:curl|wget)\s[^\n]{0,200}\|\s*(?:sudo\s+)?(?:ba|z)?sh\b|certutil[^\n]{0,30}-urlcache|bitsadmin[^\n]{0,30}\/transfer|\biwr\b[^\n]{0,150}\|\s*iex\b|Invoke-WebRequest[^\n]{0,200}\.exe/i },
  { id: 'agent_hidden_text', lang: 'any', weight: 4, what: 'hides text in invisible Unicode tag characters (not emoji flags)', re: /(?:^|[^\u{1F3F4}\u{E0061}-\u{E007A}])[\u{E0020}-\u{E007E}]{4,}/u },
  { id: 'agent_directives', lang: 'any', weight: 3, docsOnly: true, what: 'package text tells an AI agent to act against its user', re: /ignore (?:all |any |the )?(?:previous|prior|above) (?:instructions|rules)|(?:do not|don't) (?:tell|mention (?:this )?to|inform) the user|<IMPORTANT>|before using this tool,? (?:read|send|include)/ },
  // ----- JavaScript -----
  { id: 'js_decode_exec', lang: 'js', weight: 5, what: 'decodes a string and executes it', re: /\beval\s*\(\s*(?:atob|Buffer\.from|unescape|decodeURIComponent|String\.fromCharCode)\s*\(|new Function\s*\([^)]{0,120}(?:atob|Buffer\.from|base64)|\beval\s*\(\s*["'`][A-Za-z0-9+/=]{200,}/ },
  { id: 'js_shell_tools', lang: 'js', weight: 4, what: 'runs curl/wget/PowerShell/shell from code', re: /\b(?:exec|execSync|spawn|spawnSync|execFile)\s*\(\s*['"`][^'"`\n]{0,200}?(?:\bcurl\s|\bwget\s|powershell|\bbash -c|\bsh -c|cmd(?:\.exe)? \/c|nslookup\s|certutil)/ },
  { id: 'js_fingerprint', lang: 'js', weight: 2, minCount: 3, what: 'collects machine and user details', re: /os\.hostname\(\)|os\.userInfo\(\)|os\.networkInterfaces\(\)|os\.homedir\(\)|os\.platform\(\)|os\.type\(\)|process\.env\.(?:USER|USERNAME|HOME)\b|os\.release\(\)/g },
  { id: 'js_env_dump', lang: 'js', weight: 3, what: 'serialises the whole environment (all secrets in it)', re: /JSON\.stringify\(\s*process\.env\s*\)|(?:Object\.(?:keys|entries)\(\s*process\.env\s*\))[^\n]{0,80}(?:send|write|post|request|push)/ },
  { id: 'js_network', lang: 'js', weight: 1, what: 'makes network requests', re: /require\(\s*['"](?:node:)?(?:https?|net|dns|tls|dgram)['"]\s*\)|from\s+['"](?:node:)?(?:https?|net|dns)['"]|\bfetch\s*\(\s*['"`]https?:|axios\.(?:get|post)\s*\(\s*['"`]https?:/ },
  { id: 'js_dns_exfil', lang: 'js', weight: 4, what: 'encodes data into DNS lookups', re: /dns\.(?:lookup|resolve\w*)\s*\([^)\n]{0,120}(?:\+|\$\{)/ },
  { id: 'js_fetch_eval', lang: 'js', weight: 4, what: 'fetches code and evaluates it', re: /(?:\beval|new Function|vm\.runIn\w+Context|vm\.Script)\s*\(\s*(?:await\s+)?(?:\w+\.(?:data|body|text)\b|res\w*\b|body\b|data\b|payload\b|code\b)/ },
  { id: 'js_obfuscator', lang: 'js', weight: 3, minCount: 30, what: 'machine-obfuscated code (javascript-obfuscator style)', re: /\b_0x[0-9a-f]{4,6}\b/g },
  // ----- Python -----
  { id: 'py_decode_exec', lang: 'py', weight: 5, what: 'decodes a string and executes it', re: /\b(?:exec|eval)\s*\(\s*(?:base64\.b(?:64|32|16|85)decode|zlib\.decompress|marshal\.loads|bytes\.fromhex|codecs\.decode|lzma\.decompress|bz2\.decompress|__import__\(\s*['"](?:base64|zlib|marshal|codecs)['"]\))|\bexec\s*\(\s*['"]{2}\.join\(|\bexec\s*\(\s*\w+\.decode\(\s*['"](?:base64|hex|rot13)/ },
  { id: 'py_fetch_exec', lang: 'py', weight: 5, what: 'downloads code and executes it', re: /\bexec\s*\(\s*(?:compile\s*\(|(?:requests|httpx)\.get\(|urlopen\(|\w+\.(?:read|text|content|decode)\b|(?:src|code|payload|script|resp|response|r|data)\s*[,)])/ },
  { id: 'py_import_system', lang: 'py', weight: 3, what: 'hides a shell call behind __import__', re: /__import__\(\s*['"](?:os|subprocess)['"]\s*\)\s*\.\s*(?:system|popen|Popen|call|run|check_output)/ },
  { id: 'py_fingerprint', lang: 'py', weight: 2, minCount: 2, what: 'collects machine and user details', re: /platform\.node\(\)|getpass\.getuser\(\)|socket\.gethostname\(\)|os\.getlogin\(\)|platform\.uname\(\)|uuid\.getnode\(\)/g },
  { id: 'py_env_dump', lang: 'py', weight: 3, what: 'serialises the whole environment', re: /json\.dumps\(\s*(?:dict\()?os\.environ|str\(\s*os\.environ\s*\)|dict\(\s*os\.environ\s*\)[^\n]{0,60}(?:post|send|urlopen)/ },
  { id: 'py_network', lang: 'py', weight: 1, what: 'makes network requests', re: /^\s*(?:import requests|from requests|import urllib\.request|from urllib\.request|import http\.client|import socket)\b|urlopen\(/m },
  { id: 'py_setup_override', lang: 'py', weight: 2, setupOnly: true, what: 'setup.py overrides the install command', re: /class \w+\(\s*(?:install|develop|egg_info|_install|build_py)\s*\)/ },
  { id: 'py_setup_runs', lang: 'py', weight: 2, setupOnly: true, what: 'setup.py runs commands or downloads at install time', re: /os\.system\(|subprocess\.(?:Popen|call|run|check_call)\(\s*(?!\[\s*['"](?:git|cmake|make|gcc|pkg-config)['"])|urlopen\(|requests\.(?:get|post)\(|urlretrieve\(/ },
  { id: 'py_pyarmor', lang: 'py', weight: 3, what: 'PyArmor-obfuscated code', re: /__pyarmor__|pyarmor_runtime|from pytransform import/ },
  { id: 'py_startfile', lang: 'py', weight: 3, what: 'launches a downloaded executable', re: /os\.startfile\(|subprocess\.Popen\([^)\n]{0,100}\.exe['"]/ },
];

export interface CodeHit { rule: string; weight: number; file: string; line: number; what: string }
export interface InspectResult {
  version: string; score: number; verdict: 'clean' | 'review' | 'malicious-looking';
  hits: CodeHit[]; installHook: string | null; hookFiles: string[]; filesScanned: number; filesSkipped: number; textBytes: number;
  /** JavaScript/Python files read. 0 means the package has no code to read (manifest/README only). */
  codeFiles: number;
}

/** Folders whose files a package does not run on install or import. Only rules of weight >= 5 count there. */
const NON_RUNTIME = /(?:^|\/)(?:tests?|testing|docs?|examples?|samples?|benchmarks?|\.github|\.circleci|ci|\.gitlab)\//i;
const BENIGN_HOOK = /^(?:node-gyp(?:-build)? rebuild|node-gyp-build|prebuild-install|node-pre-gyp install|cmake-js|husky(?: install)?|patch-package|opencollective(?:-postinstall)?|is-ci|echo\b|exit 0|tsc\b|npm run build|node-gyp-build-optional)/;
const lineOf = (text: string, idx: number) => { let n = 1; for (let i = 0; i < idx && i < text.length; i++) if (text.charCodeAt(i) === 10) n++; return n; };
const langOf = (path: string): Lang | null => (/\.(?:[cm]?js|jsx|ts|tsx)$/i.test(path) ? 'js' : /\.(?:py|pyw|pth)$/i.test(path) || /(?:^|\/)setup\.py$/.test(path) ? 'py' : null);
const isDoc = (path: string) => /\.(?:md|markdown|txt|rst|json)$/i.test(path) || /(?:^|\/)(?:README|PKG-INFO|METADATA)/i.test(path);

/** Scans decoded entries. `ecosystem` decides which manifest is read for install hooks. */
export function inspectEntries(ecosystem: Ecosystem, entries: ArchiveEntry[], skippedCount = 0): InspectResult {
  const hits: CodeHit[] = []; let filesScanned = 0; let textBytes = 0; let filesSkipped = skippedCount; let codeFiles = 0;
  let installHook: string | null = null; const hookFiles = new Set<string>();
  const strip = (p: string) => p.replace(/^[^/]+\//, ''); // npm tarballs live under package/, sdists under name-version/

  if (ecosystem === 'npm') {
    const manifest = entries.find((e) => strip(e.path) === 'package.json');
    if (manifest) {
      try {
        const pj = JSON.parse(manifest.data.toString('utf8')) as { scripts?: Record<string, string> };
        const hooks = ['preinstall', 'install', 'postinstall'].map((k) => pj.scripts?.[k]).filter((s): s is string => typeof s === 'string' && s.trim().length > 0);
        const risky = hooks.filter((h) => !BENIGN_HOOK.test(h.trim()));
        if (risky.length) {
          installHook = risky.join(' && ');
          for (const m of installHook.matchAll(/\bnode\s+(?:-e\s+)?['"]?([\w./-]+\.[cm]?js|[\w./-]+)/g)) hookFiles.add(m[1].replace(/^\.\//, ''));
          hits.push({ rule: 'npm_install_hook', weight: 2, file: 'package.json', line: 1, what: 'runs a script when installed' });
          if (/\b(?:curl|wget|powershell|bash|sh)\b|https?:\/\//.test(installHook)) hits.push({ rule: 'npm_hook_runs_remote', weight: 5, file: 'package.json', line: 1, what: 'install script calls a shell or a URL directly' });
          if (/\bnode\s+-e\b/.test(installHook)) hits.push({ rule: 'npm_hook_inline_code', weight: 3, file: 'package.json', line: 1, what: 'install script runs inline code (node -e)' });
        }
      } catch { hits.push({ rule: 'npm_manifest_unreadable', weight: 1, file: 'package.json', line: 1, what: 'package.json could not be parsed' }); }
    }
  }

  for (const e of entries) {
    const text = asText(e);
    if (text === null) { filesSkipped++; continue; }
    filesScanned++; textBytes += text.length;
    const rel = strip(e.path); const lang = langOf(rel); const doc = isDoc(rel);
    const isSetup = /^setup\.py$/.test(rel); const isHookFile = hookFiles.has(rel) || isSetup;
    const nonRuntime = NON_RUNTIME.test(rel);
    // py_fetch_exec needs both a fetch and an exec in the same file.
    const fetches = /urlopen\(|requests\.get\(|httpx\.get\(|urllib\.request|https?\.get\(|\bfetch\(/.test(text);
    const fileHits: CodeHit[] = [];
    for (const r of RULES) {
      if (r.lang !== 'any' && r.lang !== lang) continue;
      if (r.setupOnly && !isSetup) continue;
      if (r.docsOnly && !doc) continue;
      if (doc && !r.docsOnly && r.id !== 'agent_hidden_text') continue; // docs are read for agent-directed text only
      if (nonRuntime && r.weight < 5) continue;
      if ((r.id === 'py_fetch_exec' || r.id === 'js_fetch_eval') && !fetches) continue;
      if (r.minCount) {
        const all = [...text.matchAll(r.re)];
        const distinct = r.id === 'js_obfuscator' ? all.length : new Set(all.map((m) => m[0])).size;
        if (distinct >= r.minCount) fileHits.push({ rule: r.id, weight: r.weight, file: rel, line: lineOf(text, all[0].index ?? 0), what: r.what });
      } else {
        const m = r.re.exec(text);
        if (m) fileHits.push({ rule: r.id, weight: r.weight, file: rel, line: lineOf(text, m.index), what: r.what });
      }
    }
    if (lang === 'js' || lang === 'py') codeFiles++;
    if (/\.pth$/.test(rel) && /^\s*import\s/m.test(text)) fileHits.push({ rule: 'py_pth_import', weight: 3, file: rel, line: 1, what: '.pth file runs code at every Python start-up' });
    const ids = new Set(fileHits.map((h) => h.rule));
    const collects = ['js_fingerprint', 'js_env_dump', 'py_fingerprint', 'py_env_dump', 'browser_data', 'wallet_files'].some((k) => ids.has(k));
    const sends = ['js_network', 'py_network', 'exfil_endpoint', 'messaging_api', 'raw_ip_url', 'js_dns_exfil'].some((k) => ids.has(k));
    if (collects && sends) fileHits.push({ rule: 'collect_and_send', weight: INSPECT_THRESHOLDS.collectAndSendBonus, file: rel, line: fileHits[0].line, what: 'the same file collects local data and has a way to send it' });
    if (isHookFile && fileHits.some((h) => h.weight >= 3)) fileHits.push({ rule: 'runs_at_install', weight: INSPECT_THRESHOLDS.hookBonus, file: rel, line: 1, what: 'the risky code runs at install time' });
    hits.push(...fileHits);
  }
  // Each rule counts once (its highest weight), so a package with 500 copies of one pattern is not 500x worse.
  const best = new Map<string, number>();
  for (const h of hits) best.set(h.rule, Math.max(best.get(h.rule) ?? 0, h.weight));
  const score = [...best.values()].reduce((a, b) => a + b, 0);
  const verdict = score >= INSPECT_THRESHOLDS.malicious ? 'malicious-looking' : score >= INSPECT_THRESHOLDS.review ? 'review' : 'clean';
  return { version: INSPECT_RULES_VERSION, score, verdict, hits, installHook, hookFiles: [...hookFiles], filesScanned, filesSkipped, textBytes, codeFiles };
}

/** Reads an archive from memory and scans it. */
export function inspectArchive(ecosystem: Ecosystem, archive: Buffer): InspectResult & { archiveFormat: string } {
  const a = readArchive(archive);
  return { ...inspectEntries(ecosystem, a.entries, a.skipped.length), archiveFormat: a.format };
}
