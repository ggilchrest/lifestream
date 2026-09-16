import {parentPort,workerData} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
// Isolated benchmark-owned database only; this worker is never a runtime service.
const db=new DatabaseSync(workerData.path);db.exec('PRAGMA busy_timeout=100');
const rows=db.prepare('SELECT * FROM understanding_projection ORDER BY projection_id LIMIT 16').all();
const remove=db.prepare('DELETE FROM understanding_projection WHERE projection_id=?');
const insert=db.prepare('INSERT INTO understanding_projection(projection_id,artifact_id,scope_key,boundary,content,fresh_until_ms,qualification_revision) VALUES (?,?,?,?,?,?,?)');
let running=true,batches=0;
parentPort.on('message',()=>{running=false;});
function step(){
 if(!running){db.close();parentPort.postMessage({stopped:true,batches});parentPort.close();return;}
 try{db.exec('BEGIN IMMEDIATE');for(const row of rows){remove.run(row.projection_id);insert.run(row.projection_id,row.artifact_id,row.scope_key,row.boundary,row.content,row.fresh_until_ms,row.qualification_revision);}db.exec('COMMIT');batches++;}
 catch(error){try{db.exec('ROLLBACK');}catch{}db.close();parentPort.postMessage({error:error.message,batches});parentPort.close();return;}
 if(batches===1)parentPort.postMessage({ready:true});
 setImmediate(step);
}
step();
