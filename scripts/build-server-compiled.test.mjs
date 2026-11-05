// Run after the isolated full build. Imports are inert; no server/DB/native owner
// is constructed. The test validates the actual emitted runtime graph.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve,dirname,extname} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const entries=['apps/server/dist/runtime/ubuntu-game-composition.mjs','apps/server/dist/runtime/ubuntu-game-join.mjs'];
test('actual compiled game companions have a closed compiled dependency graph without source TypeScript imports',()=>{
 const seen=new Set();
 const visit=path=>{path=realpathSync(path);assert(path.startsWith(root),'Compiled dependency escaped isolated source root');if(seen.has(path)||!['.js','.mjs'].includes(extname(path)))return;seen.add(path);const text=readFileSync(path,'utf8');for(const match of text.matchAll(/(?:from\s*|import\s*\()\s*['"](\.[^'"]+)['"]/g)){assert(!match[1].endsWith('.ts'),'Unmapped TypeScript runtime dependency: '+match[1]);visit(resolve(dirname(path),match[1]));}};
 for(const name of entries)visit(resolve(root,name));assert(seen.size>10,'Actual runtime dependency graph was not traversed');
});
test('actual compiled composition and join import successfully and retain their inert constructor APIs',async()=>{
 const composition=await import(new URL('../'+entries[0],import.meta.url)),join=await import(new URL('../'+entries[1],import.meta.url));
 assert.equal(typeof composition.createUbuntuGameComposition,'function');assert.equal(typeof join.createUbuntuGameHostJoin,'function');assert.equal(typeof join.waitForGameClientQuiescence,'function');
});
