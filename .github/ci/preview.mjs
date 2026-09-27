import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {cleanEnvironment} from './supabase.mjs';
import {fileURLToPath} from 'node:url';
import {readConfig,validatePreview,validatePreviewTree,within} from './lib.mjs';
export async function previewSmoke(root,config,env=process.env) {
  if (!config.preview) {console.log('Preview smoke not configured'); return;}
  const p=config.preview;
  if (!env.GITHUB_TOKEN || !/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY) || !/^[a-f0-9]{40}$/.test(env.PREVIEW_SHA || '')) throw Error('Exact preview SHA and read-only GitHub access required');
  validatePreviewTree(root,env.PREVIEW_SHA);
  const api=async endpoint=>{
    const r=await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/${endpoint}`,{headers:{Authorization:`Bearer ${env.GITHUB_TOKEN}`,Accept:'application/vnd.github+json'},redirect:'error',signal:AbortSignal.timeout(15000)});
    if (!r.ok) throw Error(`GitHub deployment evidence unavailable: ${r.status}`); return r.json();
  };
  const deployments=await api(`deployments?sha=${env.PREVIEW_SHA}&per_page=100`);
  let origin;
  for (const deployment of deployments) {
    const statuses=await api(`deployments/${deployment.id}/statuses?per_page=1`);
    if (!statuses.length) continue;
    try {origin=validatePreview(deployment,statuses[0],p,env.PREVIEW_SHA);break;} catch { /* Other integrations are not evidence. */ }
  }
  if (!origin) throw Error('No successful trusted exact-SHA/project preview; retry when deployment is ready');
  const require=createRequire(path.join(within(root,config.workingDirectory),'package.json'));
  execFileSync(process.execPath,[require.resolve('playwright/cli'),'install','--with-deps','chromium'],{env:cleanEnvironment(),stdio:'inherit',timeout:180000});
  const {chromium}=require('playwright');
  const browser=await chromium.launch();
  try {
    const context=await browser.newContext({serviceWorkers:'block'});
    await context.routeWebSocket('**/*',socket=>socket.close());
    await context.route('**/*',route=>{
      const request=route.request(); const url=new URL(request.url());
      return ['GET','HEAD'].includes(request.method()) && url.origin === origin ? route.continue() : route.abort();
    });
    const page=await context.newPage();
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    for(const route of p.routes) {
      const pathname=route.path;
      const url=new URL(pathname,origin);
      if (url.origin !== origin) throw Error('Preview path escapes deployment');
      const probe=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(15000)});
      if (!probe.ok || probe.status >= 300) throw Error(`Preview route rejected: ${pathname} ${probe.status}`);
      const response=await page.goto(url.href,{waitUntil:'domcontentloaded',timeout:30000});
      if (!response?.ok() || new URL(page.url()).origin !== origin) throw Error(`Preview browser route failed: ${pathname}`);
      const content=page.locator(route.selector);
      await content.waitFor({state:'visible',timeout:10000});
      if (!(await content.innerText()).includes(route.text)) throw Error(`Preview content assertion failed: ${pathname}`);
      if (errors.length) throw Error(`Preview JavaScript error: ${errors.join('; ')}`);
    }
  } finally {await browser.close();}
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {await previewSmoke(process.cwd(),readConfig(process.cwd(),process.argv[2] || '.github/ci/config.json'));} catch(error){console.error(error.message);process.exitCode=1;}
}
