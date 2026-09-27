import fs from 'node:fs';
import path from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readConfig,within,migrationHistory} from './lib.mjs';
import {checkEnvDocs} from './env-docs.mjs';
import {cleanEnvironment,startDatabase,stopDatabase} from './supabase.mjs';
import {verifyManifest} from './vendor.mjs';
const root=process.cwd();
const canonical=path.dirname(fileURLToPath(import.meta.url)) === path.join(root,'ci');
const verify=()=>{if (!canonical) verifyManifest(root);};
const [mode='run',filename='.github/ci/config.json']=process.argv.slice(2);
function run(cmd,args,cwd,env=cleanEnvironment()) {
  const r=spawnSync(cmd,args,{cwd,env,stdio:'inherit'});
  if (r.error || r.status !== 0) throw Error(`${cmd} ${args.join(' ')} failed (${r.status ?? r.error?.message})`);
}
try {
  if (mode === 'cleanup') {stopDatabase(root);process.exit(0);}
  const c=readConfig(root,filename),cwd=within(root,c.workingDirectory);
  const pm=c.packageManager;
  if (mode === 'configure') {
    verify();
    if (!process.env.GITHUB_OUTPUT) throw Error('GITHUB_OUTPUT required');
    fs.appendFileSync(process.env.GITHUB_OUTPUT,`node=${c.nodeVersion}\nmanager=${pm.name}\nversion=${pm.version}\nlockfile=${pm.lockfile}\n`);
  } else if (mode === 'bootstrap') {
    run('npm',['install','--global',`${pm.name}@${pm.version}`],root);
    const args=pm.name === 'pnpm'?['store','path','--silent']:pm.name === 'yarn'?['cache','dir']:['config','get','cache'];
    const cache=execFileSync(pm.name,args,{cwd,env:cleanEnvironment(),encoding:'utf8'}).trim();
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT,`cache=${cache}\n`);
  } else if (mode === 'install') {
    run(pm.name,pm.name === 'npm'?['ci']:['install','--frozen-lockfile'],cwd);
  } else if (mode === 'docs') checkEnvDocs(root,c);
  else if (mode === 'run') {
    verify(); checkEnvDocs(root,c);
    if (canonical) run(process.execPath,['--test','ci/tests/foundation.test.mjs'],root);
    const script=(name,env)=>run(pm.name,['run',name],cwd,env);
    const env=cleanEnvironment();
    if (c.scripts.typecheck) script(c.scripts.typecheck,env);
    if (c.scripts.lint) script(c.scripts.lint,env);
    for (const name of c.additionalChecks || []) script(name,env);
    let testenv=env;
    if (c.supabase) {
      let base;
      if (process.env.GITHUB_EVENT_PATH) {
        const event=JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH,'utf8'));
        base=event.pull_request?.base?.sha || event.before;
        if (/^0+$/.test(base || '')) base=undefined;
      }
      migrationHistory(root,c.supabase.migrations,base || c.supabase.baselineSha);
      testenv=startDatabase(root,c.supabase);
    }
    try {
      script(c.scripts.test,testenv);
      if (c.scripts.build) script(c.scripts.build,testenv);
      if (c.sanity) {
        const sanityDir=within(root,c.sanity.workingDirectory);
        if (sanityDir !== cwd) throw Error('Separate Sanity installs require a dedicated validated config');
        if (!c.sanity.script) throw Error('Sanity script required');
        script(c.sanity.script,testenv);
      }
    } finally { if(c.supabase) stopDatabase(root); }
  } else throw Error(`Unknown mode: ${mode}`);
} catch(error) {console.error(error.message);process.exitCode=1;}
