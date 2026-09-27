import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {hash} from './lib.mjs';
export const helpers=['lib.mjs','env-docs.mjs','supabase.mjs','preview.mjs','run.mjs','vendor.mjs'];
export function verifyManifest(root) {
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'.github/ci/manifest.json'),'utf8'));
  const expected=['.github/workflows/node-ci.yml',...helpers.map(f=>'.github/ci/'+f)].sort();
  if (manifest.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(manifest.canonicalRevision) || JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(expected)) throw Error('Invalid vendor manifest');
  for (const [file,digest] of Object.entries(manifest.files)) if (hash(fs.readFileSync(path.join(root,file))) !== digest) throw Error(`Vendored CI file changed: ${file}`);
  return manifest;
}
export function vendor(source,target,revision,check=false) {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw Error('Canonical full commit SHA required');
  const contents={};
  const mapping={'.github/workflows/node-ci.yml':'.github/workflows/node-ci.yml',...Object.fromEntries(helpers.map(f=>['.github/ci/'+f,'ci/'+f]))};
  for(const [dest,src] of Object.entries(mapping)) contents[dest]=execFileSync('git',['show',`${revision}:${src}`],{cwd:source});
  const manifest={schemaVersion:1,canonicalRepository:'Rhize-Media/rhize-infra',canonicalRevision:revision,files:Object.fromEntries(Object.entries(contents).map(([name,data])=>[name,hash(data)]))};
  contents['.github/ci/manifest.json']=Buffer.from(JSON.stringify(manifest,null,2)+'\n');
  for(const [dest,data] of Object.entries(contents)) {
    const output=path.join(target,dest);
    if (check) {if (!fs.existsSync(output) || !fs.readFileSync(output).equals(data)) throw Error(`Outdated canonical copy: ${dest}`);}
    else {fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,data);}
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [source,target,revision,flag]=process.argv.slice(2);
  if (!source || !target || !revision) throw Error('Usage: node ci/vendor.mjs SOURCE_REPO TARGET_REPO FULL_SHA [--check]');
  vendor(path.resolve(source),path.resolve(target),revision,flag === '--check');
}
