import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,realpath,lstat} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {dirname,join} from 'node:path';

/** Trusted operator-main code, never renderer/model/HTTP configuration. The
 * explicit reviewed digest pins the selected module; its independent source,
 * admission, save and model owners remain responsible for their own custody. */
export async function loadCandidateGameplayOwners(path,sha256){
 assert.match(sha256??'',/^[a-f0-9]{64}$/,'Reviewed gameplay owner module digest required');
 const selected=await realpath(path),info=await lstat(path);
 assert.ok(info.isFile()&&!info.isSymbolicLink()&&info.size<=262144,'Gameplay owner module must be a bounded regular file');
 for(let p=dirname(selected);;p=dirname(p)){assert.equal(existsSync(join(p,'.git')),false,'Operator gameplay owner code must be outside Git roots');if(dirname(p)===p)break;}
 const bytes=await readFile(selected);
 assert.equal(createHash('sha256').update(bytes).digest('hex'),sha256,'Gameplay owner module changed');
 // Execute the exact bytes reviewed above, without reopening a mutable path.
 // Operator modules use node: or absolute file: imports for their source owners.
 const module=await import('data:text/javascript;base64,'+bytes.toString('base64'));
 assert.ok(module.gameplayOwners&&typeof module.gameplayOwners==='object','Trusted gameplayOwners export required');
 return module.gameplayOwners;
}
