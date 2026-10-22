import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
export const hash = text => crypto.createHash('sha256').update(text).digest('hex');
export function within(root, value) {
  if (typeof value !== 'string' || !value || /[\r\n\0]/.test(value) || path.isAbsolute(value)) throw Error('Expected repository-relative path');
  const result = path.resolve(root, value);
  if (result !== root && !result.startsWith(root + path.sep)) throw Error(`Path escapes repository: ${value}`);
  return result;
}
export function readConfig(root, filename) {
  const c = JSON.parse(fs.readFileSync(within(root, filename), 'utf8'));
  if (c.schemaVersion !== 1 || !/^\d+(\.\d+){0,2}$/.test(c.nodeVersion)) throw Error('Invalid schemaVersion/nodeVersion');
  const pm = c.packageManager;
  if (!pm || !['npm','yarn','pnpm'].includes(pm.name) || !/^\d+\.\d+\.\d+$/.test(pm.version)) throw Error('Pin the package manager to an exact version');
  const cwd = within(root, c.workingDirectory);
  const lock = within(root, pm.lockfile);
  if (!fs.existsSync(lock) || path.dirname(lock) !== cwd) throw Error('Authoritative lockfile must exist in workingDirectory');
  const expected = {npm:'package-lock.json',yarn:'yarn.lock',pnpm:'pnpm-lock.yaml'}[pm.name];
  if (path.basename(lock) !== expected) throw Error('Package manager/lockfile mismatch');
  if (pm.name === 'yarn' && !pm.version.startsWith('1.')) throw Error('Only pinned Yarn Classic is currently supported');
  const pkg = JSON.parse(fs.readFileSync(path.join(cwd,'package.json'),'utf8'));
  if (c.notApplicable !== undefined) {
    if (c.notApplicable === null || typeof c.notApplicable !== 'object' || Array.isArray(c.notApplicable)) throw Error('notApplicable must be an object of phase reasons');
    for (const [phase,reason] of Object.entries(c.notApplicable)) {
      if (!['typecheck','lint','build'].includes(phase) || typeof reason !== 'string' || !reason.trim()) throw Error(`Invalid notApplicable reason: ${phase}`);
    }
  }
  for (const phase of ['typecheck','lint','test','build']) {
    if (c.notApplicable?.[phase]) {
      if (!['infra','salesforce'].includes(c.profile) || !['typecheck','lint','build'].includes(phase) || c.scripts?.[phase]) throw Error(`Invalid notApplicable: ${phase}`);
      continue;
    }
    if (!c.scripts?.[phase] || !pkg.scripts?.[c.scripts[phase]]) throw Error(`Required script missing: ${phase}`);
  }
  for (const script of [...Object.values(c.scripts || {}), ...(c.additionalChecks || [])]) {
    if (!pkg.scripts?.[script] || /--(if-present|passWithNoTests)\b/.test(pkg.scripts[script])) throw Error(`Missing or permissive script: ${script}`);
  }
  if (!c.envDocs || !Array.isArray(c.envDocs.roots) || !c.envDocs.roots.length) throw Error('envDocs roots required');
  within(root,c.envDocs.readme);
  for (const p of c.envDocs.roots) within(root,p);
  if (c.supabase) {
    if (c.supabase.baselineSha && !/^[a-f0-9]{40}$/.test(c.supabase.baselineSha)) throw Error('Migration baseline must be an exact SHA');
    if (!/^\d+\.\d+\.\d+$/.test(c.supabase.version)) throw Error('Pin Supabase CLI version');
    if (![15,17].includes(c.supabase.databaseMajor) || typeof c.supabase.authSignup !== 'boolean') throw Error('Declare disposable databaseMajor (15/17) and authSignup');
    within(root,c.supabase.migrations);
    if (!fs.existsSync(within(root,c.supabase.migrations))) throw Error('Missing migrations');
  }
  if (c.preview) {
    const p=c.preview;
    if (typeof p.projectId !== 'string' || !p.projectId.trim() || !p.hostnamePattern?.startsWith('^') || !p.hostnamePattern.endsWith('$') || !Array.isArray(p.productionHosts) || !p.productionHosts.length) throw Error('Explicit preview project and host constraints required');
    new RegExp(p.hostnamePattern);
    if (!Array.isArray(p.routes) || !p.routes.length || p.routes.some(r=>typeof r.path !== 'string' || !r.path.startsWith('/') || r.path.startsWith('//') || /[?#]/.test(r.path) || typeof r.selector !== 'string' || !r.selector.trim() || typeof r.text !== 'string' || !r.text.trim())) throw Error('Preview routes need safe paths and content assertions');
  }
  return c;
}
export function validateLocalDatabase(env) {
  for (const key of ['TEST_DATABASE_URL','NEXT_PUBLIC_SUPABASE_URL']) {
    const u = new URL(env[key]);
    if (!['127.0.0.1','localhost','[::1]'].includes(u.hostname) || !u.port || !['postgres:','postgresql:','http:'].includes(u.protocol)) throw Error(`Non-disposable database target: ${key}`);
  }
}
export function migrationHistory(root, directory, base) {
  const names = fs.readdirSync(within(root,directory)).filter(n=>n.endsWith('.sql'));
  if (!names.length || names.some(n=>!/^\d+_.+\.sql$/.test(n))) throw Error('Missing or malformed migrations');
  if (new Set(names.map(n=>n.split('_')[0])).size !== names.length) throw Error('Duplicate migration timestamp');
  if (!base) throw Error('Explicit migration baseline SHA required');
  const untracked=execFileSync('git',['ls-files','--others','--exclude-standard','--',directory],{cwd:root,encoding:'utf8'}).trim();
  if (untracked) throw Error('Stage new migration files before local validation');
  if (!/^[a-f0-9]{40}$/.test(base)) throw Error('Invalid migration base SHA');
  try {execFileSync('git',['merge-base','--is-ancestor',base,'HEAD'],{cwd:root,stdio:'pipe'});} catch {throw Error('Migration baseline must resolve and be an ancestor of HEAD');}
  const changes = execFileSync('git',['diff','--name-status',base,'--',directory],{cwd:root,encoding:'utf8'}).trim();
  if (changes.split('\n').some(line=>line && !line.startsWith('A\t'))) throw Error('Previously applied migration modified/deleted; add a forward migration');
}
export function validatePreview(deployment,status,config,sha) {
  if (typeof config.projectId !== 'string' || !config.projectId.trim() || typeof deployment.payload?.projectId !== 'string' || !deployment.payload.projectId.trim()) throw Error('Preview project identity required');
  if (deployment.sha !== sha || deployment.creator?.login !== 'vercel[bot]' || deployment.production_environment !== false || !/^preview$/i.test(deployment.environment)) throw Error('Untrusted preview deployment identity');
  if (deployment.payload?.projectId !== config.projectId || status.state !== 'success') throw Error('Preview project/status mismatch');
  const url = new URL(status.environment_url);
  const hasCredentials = Boolean(url.username || url.password);
  if (url.protocol !== 'https:' || hasCredentials || url.port || !url.hostname.endsWith('.vercel.app') || !config.hostnamePattern?.startsWith('^') || !config.hostnamePattern.endsWith('$') || !(new RegExp(config.hostnamePattern)).test(url.hostname) || (config.productionHosts || []).includes(url.hostname)) throw Error('Unsafe preview hostname');
  return url.origin;
}

export function validatePreviewTree(root,sha) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw Error('Exact preview SHA required');
  const tree=ref=>execFileSync('git',['rev-parse',`${ref}^{tree}`],{cwd:root,encoding:'utf8'}).trim();
  if (tree('HEAD') !== tree(sha)) throw Error('Preview source tree differs from tested checkout');
}
