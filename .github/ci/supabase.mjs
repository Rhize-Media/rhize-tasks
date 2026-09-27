import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {within,validateLocalDatabase} from './lib.mjs';
export function cleanEnvironment(input=process.env) {
  const env={CI:'true',NEXT_TELEMETRY_DISABLED:'1'};
  for (const key of ['PATH','HOME','TMPDIR','TEMP','TMP','SHELL','SystemRoot','RUNNER_TEMP','RUNNER_OS','GITHUB_ACTIONS','GITHUB_WORKSPACE','GITHUB_SHA','GITHUB_REF','GITHUB_EVENT_NAME','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','GITHUB_REPOSITORY','npm_config_cache','COREPACK_HOME']) if (input[key]) env[key]=input[key];
  return env;
}
function cli(version,workdir,args,{capture=false,allowFailure=false,env=cleanEnvironment()}={}) {
  if (!capture) console.log(`Disposable Supabase: ${args.slice(0,2).join(' ')}`);
  const result=spawnSync('npx',['--yes',`supabase@${version}`,...args,'--workdir',workdir],{env,stdio:['ignore','pipe','pipe'],encoding:'utf8',timeout:600000});
  if (allowFailure && !result.error && result.status !== null) return result;
  if (result.error || result.status !== 0) throw Error(`Supabase ${args[0]} failed (${result.status ?? result.error?.message})${result.stderr ? ': '+result.stderr.replace(/eyJ[A-Za-z0-9_.-]+/g,'[local JWT redacted]').replace(/sb_(secret|publishable)_[A-Za-z0-9_-]+/g,'[local key redacted]').replace(/(postgres(?:ql)?:\/\/[^:]+:)[^@]+@/g,'$1[redacted]@').slice(-4000) : ''}`);
  return result.stdout;
}
export function copyMigrations(root,directory,target) {
  const source=within(root,directory);
  if (!fs.lstatSync(source).isDirectory() || fs.realpathSync(source) !== within(fs.realpathSync(root),directory)) throw Error('Migration directory must be a real repository directory');
  const names=fs.readdirSync(source).filter(name=>name.endsWith('.sql')).sort();
  if (!names.length || names.some(name=>!/^\d+_.+\.sql$/.test(name)) || new Set(names.map(name=>name.split('_')[0])).size !== names.length) throw Error('Missing, malformed or duplicate migrations');
  for (const name of names) if (!fs.lstatSync(path.join(source,name)).isFile()) throw Error(`Migration must be a regular SQL file: ${name}`);
  fs.mkdirSync(target,{recursive:true});
  for (const name of names) fs.copyFileSync(path.join(source,name),path.join(target,name),fs.constants.COPYFILE_EXCL);
}
export function createDatabaseState(root,version) {
  const statefile=path.join(root,'.github/ci/.supabase-state.json');
  // Reject an unusable state directory before allocating any temporary work.
  fs.mkdirSync(path.dirname(statefile),{recursive:true});
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'rhize-ci-db-'));
  let fd;
  try {
    // Never replace another unfinished run's cleanup receipt.
    fd=fs.openSync(statefile,'wx',0o600);
    fs.writeFileSync(fd,JSON.stringify({workdir:temp,version}));
  } catch(error) {
    if (fd !== undefined) fs.unlinkSync(statefile);
    fs.rmSync(temp,{recursive:true,force:true});
    throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
  return temp;
}
export function startDatabase(root,config) {
  const temp=createDatabaseState(root,config.version);
  try {
    cli(config.version,temp,['init']);
    const configFile=path.join(temp,'supabase/config.toml');
    let text=fs.readFileSync(configFile,'utf8');
    const project='rhize-ci-'+crypto.randomBytes(8).toString('hex');
    const published=spawnSync('docker',['ps','--format','{{.Ports}}'],{env:cleanEnvironment(),encoding:'utf8',timeout:30000});
    if (published.error || published.status !== 0) throw Error('Cannot inspect published local Docker ports');
    const usedPorts=new Set([...published.stdout.matchAll(/:(\d+)->/g)].map(m=>Number(m[1])));
    let offset;
    for (let attempt=0; attempt<20; attempt++) {
      const candidate=crypto.randomInt(1,90)*100;
      const ports=[...new Set([...text.matchAll(/\b(54\d{3})\b/g)].map(m=>Number(m[1])+candidate))];
      if (ports.some(port=>usedPorts.has(port))) continue;
      const probe=spawnSync(process.execPath,['--input-type=module','-e',`import net from 'node:net'; const servers=[]; try {for(const port of ${JSON.stringify(ports)}) {await new Promise((resolve,reject)=>{const server=net.createServer(); servers.push(server);server.once('error',reject);server.listen(port,'0.0.0.0',resolve);});}} catch {process.exitCode=1;} finally {for(const server of servers) server.close();}`],{stdio:'ignore'});
      if(probe.status === 0) {offset=candidate;break;}
    }
    if (!offset) throw Error('No free disposable Supabase port block');
    text=text.replace(/^project_id = .+$/m,`project_id = "${project}"`).replace(/\b(54\d{3})\b/g,(_,port)=>String(Number(port)+offset));
    // The CLI's fresh config supplies compatible auth/storage defaults. No repo config,
    // .env, remote project link or seed SQL enters this disposable working directory.
    text=text.replace(/(\[db\.seed\][\s\S]*?enabled = )true/, '$1false');
    if (config.databaseMajor) text=text.replace(/^(major_version = )\d+$/m,`$1${config.databaseMajor}`);
    if (typeof config.authSignup === 'boolean') text=text.replace(/(\[auth\][\s\S]*?enable_signup = )(true|false)/,`$1${config.authSignup}`);
    fs.writeFileSync(configFile,text);
    copyMigrations(root,config.migrations,path.join(temp,'supabase/migrations'));
    cli(config.version,temp,['start','--exclude','studio,mailpit,logflare,vector,supavisor,edge-runtime']);
    cli(config.version,temp,['db','reset','--local','--no-seed']);
    lintDatabase(config.version,temp,project);
    const values=JSON.parse(cli(config.version,temp,['status','--output','json'],{capture:true}));
    const env=cleanEnvironment();
    env.TEST_DATABASE_URL=values.DB_URL;
    env.NEXT_PUBLIC_SUPABASE_URL=values.API_URL;
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=values.PUBLISHABLE_KEY || values.ANON_KEY;
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY=values.ANON_KEY;
    env.SUPABASE_SECRET_KEY=values.SECRET_KEY || values.SERVICE_ROLE_KEY;
    env.SUPABASE_SERVICE_ROLE_KEY=values.SERVICE_ROLE_KEY;
    env.SUPABASE_JWT_SECRET=values.JWT_SECRET;
    if (Object.values(env).some(v=>typeof v !== 'string' || !v)) throw Error('Disposable Supabase credentials incomplete');
    validateLocalDatabase(env);
    if (Number(new URL(env.TEST_DATABASE_URL).port) !== 54322+offset || Number(new URL(env.NEXT_PUBLIC_SUPABASE_URL).port) !== 54321+offset) throw Error('Supabase status does not match this disposable stack');
    return env;
  } catch(error) { stopDatabase(root); throw error; }
}
export function stopDatabase(root) {
  const statefile=path.join(root,'.github/ci/.supabase-state.json');
  if (!fs.existsSync(statefile)) return;
  const state=JSON.parse(fs.readFileSync(statefile,'utf8'));
  const tmp=path.resolve(os.tmpdir())+path.sep;
  if (!path.resolve(state.workdir).startsWith(tmp+'rhize-ci-db-') || !/^\d+\.\d+\.\d+$/.test(state.version)) throw Error('Unsafe cleanup state');
  cli(state.version,state.workdir,['stop','--no-backup']);
  fs.rmSync(state.workdir,{recursive:true,force:true}); fs.unlinkSync(statefile);
}

export function applicationLintFindings(findings,ownership) {
  if (!Array.isArray(findings) || !Array.isArray(ownership)) throw Error('Invalid SQL lint/ownership evidence');
  const extensionOnly=new Set(ownership.filter(row=>row.extension_owned === true).map(row=>row.function));
  return findings.filter(item=>{
    if (typeof item.function !== 'string' || !Array.isArray(item.issues)) throw Error('Unknown SQL lint finding shape');
    return !extensionOnly.has(item.function) && item.issues.length > 0;
  });
}
export function parseLintOutput(stdout,status,stderr='') {
  if (![0,1].includes(status)) throw Error(`Unexpected SQL lint exit status: ${status}`);
  const text=stdout.trim();
  // CLI 2.114 emits this documented success sentence even with --output json.
  const stderrLines=stderr.replace(/\u001b\[[0-9;]*m/g,'').split('\n').map(line=>line.trim());
  if (status === 0 && (text === 'No schema errors found' || text === '' && stderrLines.includes('No schema errors found'))) return [];
  let findings;
  try {findings=JSON.parse(text);} catch {
    throw Error(`SQL lint output unrecognized (exit ${status}): ${JSON.stringify(text.slice(0,500))}; stderr ${JSON.stringify(stderr.slice(0,500))}`);
  }
  if (!Array.isArray(findings)) throw Error('SQL lint output must be a findings array');
  if (status !== 0 && findings.length === 0) throw Error(`SQL lint failed without findings (exit ${status})`);
  return findings;
}
function lintDatabase(version,workdir,project) {
  const result=cli(version,workdir,['db','lint','--local','--level','warning','--fail-on','warning','--output','json'],{capture:true,allowFailure:true});
  const findings=parseLintOutput(result.stdout,result.status,result.stderr);
  if (!/^rhize-ci-[a-f0-9]{16}$/.test(project)) throw Error('Unsafe disposable project identity');
  const sql=`SELECT coalesce(json_agg(row_to_json(x)), '[]'::json) FROM (
    SELECT n.nspname || '.' || p.proname AS function,
      bool_and(EXISTS (SELECT 1 FROM pg_depend d JOIN pg_extension e ON e.oid=d.refobjid
        WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.refclassid='pg_extension'::regclass AND d.deptype='e')) AS extension_owned
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    GROUP BY n.nspname,p.proname) x;`;
  const query=spawnSync('docker',['exec',`supabase_db_${project}`,'psql','-U','postgres','-d','postgres','-At','-c',sql],{env:cleanEnvironment(),encoding:'utf8',timeout:30000});
  if (query.error || query.status !== 0) throw Error('Cannot verify extension ownership in disposable database');
  const actionable=applicationLintFindings(findings,JSON.parse(query.stdout));
  if (actionable.length) throw Error(`Application SQL lint failed: ${JSON.stringify(actionable)}`);
  if (result.status !== 0 && !findings.some(item=>item.issues?.length)) throw Error(`SQL lint failed without classified findings (exit ${result.status})`);
  console.log(`SQL lint: ${findings.filter(item=>item.issues?.length).length} extension-owned function reports; no application findings`);
}
