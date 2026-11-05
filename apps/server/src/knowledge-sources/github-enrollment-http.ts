import {AuthenticationError} from '../auth/local-auth.ts';
import type {LocalContext} from '../auth/local-auth.ts';
import {GitHubPublicEnrollmentService} from './github-public.ts';

export class GitHubEnrollmentHttp {
 constructor(private readonly service:GitHubPublicEnrollmentService){}
 static matches(path:string){return /^\/api\/admin\/v1\/assistants\/[0-9a-f-]+\/github-enrollment$/.test(path);}
 async handle(method:string,path:string,local:LocalContext,input:Record<string,unknown>,signal:AbortSignal,current:()=>boolean){
  const assistant=path.split('/')[5]!;if(!current()||!local.owner||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(assistant))throw new AuthenticationError(403,'github_private_owner_required');
  try{if(method==='GET')return {status:200,body:this.service.status(local.principalId,assistant)};
   if(method!=='POST')throw new AuthenticationError(405,'github_enrollment_method');
   if(!Number.isSafeInteger(input.expectedRevision)||Number(input.expectedRevision)<0)throw new AuthenticationError(422,'github_enrollment_invalid');
   const expected=Number(input.expectedRevision);
   if(input.operation==='revoke'){if(Object.keys(input).sort().join(',')!=='expectedRevision,operation')throw new AuthenticationError(422,'github_enrollment_invalid');this.service.revoke(local.principalId,assistant,expected);}
   else if(input.operation==='enroll'||input.operation==='reauth'){if(Object.keys(input).sort().join(',')!=='commit,context,expectedRevision,operation,repository'||input.repository!=='ggilchrest/lifestream'||input.context!=='personal'||typeof input.commit!=='string')throw new AuthenticationError(422,'github_enrollment_invalid');if(input.operation==='enroll'&&expected!==0||input.operation==='reauth'&&expected===0)throw new AuthenticationError(409,'github_enrollment_conflict');await this.service.enroll(local.principalId,assistant,expected,input.commit,signal,current);}
   else throw new AuthenticationError(422,'github_enrollment_invalid');
   if(!current()||signal.aborted)throw new AuthenticationError(403,'github_scope_changed');return {status:200,body:this.service.status(local.principalId,assistant)};
  }catch(error){if(error instanceof AuthenticationError)throw error;throw new AuthenticationError(409,'github_verification_unavailable');}
 }
}
