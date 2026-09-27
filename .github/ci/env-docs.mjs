import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {within,hash} from './lib.mjs';
export function scanSource(ts, text, filename='input.ts') {
  const file = ts.createSourceFile(filename,text,ts.ScriptTarget.Latest,true);
  const names = new Set(); const dynamic = [];
  const property = n => ts.isPropertyAccessExpression(n) ? n.name.text : ts.isElementAccessExpression(n) && n.argumentExpression && ts.isStringLiteralLike(n.argumentExpression) ? n.argumentExpression.text : undefined;
  const isProcess = n => ts.isIdentifier(n) && n.text === 'process' || property(n) === 'process' && ts.isIdentifier(n.expression) && n.expression.text === 'globalThis';
  const isEnv = n => property(n) === 'env' && (isProcess(n.expression) || n.expression.getText(file) === 'import.meta');
  const unresolved = n => dynamic.push(file.getLineAndCharacterOfPosition(n.getStart(file)).line+1);
  function visit(n) {
    if (ts.isPropertyAccessExpression(n) && isEnv(n.expression)) names.add(n.name.text);
    if (ts.isElementAccessExpression(n) && isEnv(n.expression)) {
      if (n.argumentExpression && ts.isStringLiteralLike(n.argumentExpression)) names.add(n.argumentExpression.text);
      else dynamic.push(file.getLineAndCharacterOfPosition(n.getStart(file)).line+1);
    }
    if (ts.isVariableDeclaration(n) && n.initializer && isEnv(n.initializer)) {
      if (ts.isObjectBindingPattern(n.name)) {
        for (const item of n.name.elements) {
          const name = item.propertyName || item.name;
          if (item.dotDotDotToken || !ts.isIdentifier(name) && !ts.isStringLiteralLike(name)) dynamic.push(file.getLineAndCharacterOfPosition(item.getStart(file)).line+1);
          else names.add(name.text);
        }
      } else dynamic.push(file.getLineAndCharacterOfPosition(n.getStart(file)).line+1);
    }
    if (ts.isVariableDeclaration(n) && n.initializer && isProcess(n.initializer)) {
      // Destructuring or aliasing process can otherwise hide subsequent env reads.
      if (!ts.isObjectBindingPattern(n.name) || n.name.elements.some(item=>item.dotDotDotToken || item.propertyName && ts.isComputedPropertyName(item.propertyName) || (item.propertyName || item.name).text === 'env')) unresolved(n);
    }
    if (ts.isElementAccessExpression(n) && isProcess(n.expression) && !property(n)) unresolved(n);
    // Passing the entire environment or aliasing it cannot establish a static contract.
    if (isEnv(n) && !ts.isPropertyAccessExpression(n.parent) && !ts.isElementAccessExpression(n.parent) && !ts.isVariableDeclaration(n.parent)) dynamic.push(file.getLineAndCharacterOfPosition(n.getStart(file)).line+1);
    ts.forEachChild(n,visit);
  }
  visit(file); return {names:[...names].sort(),dynamic:[...new Set(dynamic)].map(line=>({line,sourceHash:hash(text)}))};
}
export function checkEnvDocs(root,config) {
  const require = createRequire(path.join(within(root,config.workingDirectory),'package.json'));
  const ts = require('typescript');
  const readme = fs.readFileSync(within(root,config.envDocs.readme),'utf8');
  const documented = new Set(); let header;
  for (const line of readme.split('\n')) {
    if (!line.trim().startsWith('|')) {header=undefined;continue;}
    const cells=line.split('|').slice(1,-1).map(cell=>cell.trim());
    if (/^(variable|name|environment variable)$/i.test(cells[0] || '')) {
      header={purpose:cells.findIndex(c=>/^(purpose|description|scope|notes)$/i.test(c)),requirement:cells.findIndex(c=>/^(requirement|required\??|status)$/i.test(c))};continue;
    }
    const name=/^`([A-Z][A-Z0-9_]*)`$/.exec(cells[0] || '');
    if (name && header && header.purpose >= 0 && header.requirement >= 0 && cells[header.purpose] && /\b(required|optional|conditional)\b/i.test(cells[header.requirement] || '')) documented.add(name[1]);
  }
  const allow = new Set(['NODE_ENV','CI',...(config.envDocs.allow || [])]);
  const ignore = config.envDocs.ignore || [];
  const tracked = execFileSync('git',['ls-files','-z','--',...config.envDocs.roots],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean);
  const failures = []; let count = 0;
  for (const filename of tracked) {
    if (!/\.(?:[cm]?[jt]sx?)$/.test(filename) || ignore.some(p=>filename === p || filename.startsWith(p.replace(/\/$/,'')+'/'))) continue;
    const result = scanSource(ts,fs.readFileSync(within(root,filename),'utf8'),filename); count++;
    for (const name of result.names) if (!allow.has(name) && !documented.has(name)) failures.push(`${filename}: README does not document ${name}`);
    const permitted = config.envDocs.dynamicAccess?.[filename] || [];
    for (const access of result.dynamic) {
      const exception=permitted.find(item=>item.sourceHash === access.sourceHash && Array.isArray(item.names) && item.names.length && typeof item.reason === 'string' && item.reason.length > 15);
      if (!exception) failures.push(`${filename}:${access.line}: unresolved dynamic env access (sourceHash ${access.sourceHash})`);
      else for (const name of exception.names) if (!documented.has(name) && !allow.has(name)) failures.push(`${filename}: dynamic env name undocumented: ${name}`);
    }
  }
  if (!count) throw Error('No active tracked source files scanned');
  if (failures.length) throw Error(failures.join('\n'));
  console.log(`Environment documentation: ${count} tracked source files checked`);
}
