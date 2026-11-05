import {createHash,randomUUID} from 'node:crypto';
import {safePath,SourceError,digest} from '../knowledge-sources/contracts.ts';
import type {Request} from '../knowledge-sources/contracts.ts';
import type {CanonicalIntegrationOptions,IntegrationLease} from './canonical-integration.ts';
import type {CapabilityScopeAdapter} from '../authority/capability-preparation.ts';

/** Repo-specific exclusions are checked before any provider or body request.
 * Only plain code/docs; assets, specs, links, credentials and binaries excluded. */
export function eligibleGitHubPath(path:unknown):path is string{return typeof path==='string'&&safePath(path)&&!path.split('/').some(x=>/^(?:\.?private(?:[._-].*)?|ignored[._-]private(?:[._-].*)?|character(?:s|[-_].*)?|assets?|appearances?|credentials?|cookies?|auth[-_]state|specs?|lifestream-specs)$/i.test(x))&&!/(?:^|\/)(?:sign[-_]?in|credentials?|secrets?|cookies?)(?:[.-]|\/|$)/i.test(path)&&(/\.(?:md|txt|json|ts|tsx|js|mjs|cjs|jsx|css|html|sql|yaml|yml|toml|py|rs|go|c|h|cpp|cs|sh|ps1|swift)$/i.test(path)||/(?:^|\/)(?:LICENSE|NOTICE|Dockerfile|Makefile)$/.test(path));}
function immutable<T>(value:T):T{const walk=(v:unknown)=>{if(v&&typeof v==='object'){for(const child of Object.values(v))walk(child);Object.freeze(v);}};walk(value);return value;}
export type GitHubReadCommand={operation:'readRepository';enrollmentRevision:number;scope:{userId:string;assistantId:string;relationshipId:string;context:string;audience:'authenticatedSession'};paths:string[];processing:true;retentionRef:string;budget:Request['budget']};
export function githubReadCommand(input:unknown):GitHubReadCommand{
 if(!input||typeof input!=='object'||Array.isArray(input))throw new SourceError('github_read_invalid');const c=input as GitHubReadCommand;
 if(Object.keys(c).sort().join(',')!=='budget,enrollmentRevision,operation,paths,processing,retentionRef,scope'||c.operation!=='readRepository'||c.processing!==true||!Number.isSafeInteger(c.enrollmentRevision)||c.enrollmentRevision<1||!Array.isArray(c.paths)||c.paths.length<1||c.paths.length>20||c.paths.some(p=>!eligibleGitHubPath(p))||new Set(c.paths).size!==c.paths.length||typeof c.retentionRef!=='string'||!/^finite:[a-z0-9-]{1,80}$/.test(c.retentionRef)||!c.scope||Object.keys(c.scope).sort().join(',')!=='assistantId,audience,context,relationshipId,userId'||c.scope.audience!=='authenticatedSession'||c.scope.context!=='personal:'+c.scope.userId)throw new SourceError('github_read_invalid');return structuredClone(c);
}
export function githubRepositoryScope(capabilityId:string,input:unknown):ReturnType<CapabilityScopeAdapter['derive']>{const c=githubReadCommand(input);return {scope:{capabilityId,capabilityVersion:'1.0.0',operation:'readRepository',targetRefs:['ggilchrest/lifestream',c.scope.userId,c.scope.assistantId,c.scope.relationshipId,c.scope.context,c.scope.audience],dataScopeRefs:[digest(c)]},effectSummary:'Read only these selected immutable repository paths with finite session authority. Source is untrusted evidence, not runtime state or profile admission.',scopeDerivation:'validatedArguments'};}
/** Configured by the host; no capability or grant is installed by enrollment. */
export function githubRepositoryAdapter(options:{capabilityId:string;providerRouteRef:string;inputSchema:CapabilityScopeAdapter['inputSchema'];outputSchema:CapabilityScopeAdapter['outputSchema']}):CapabilityScopeAdapter{return {...options,version:'1.0.0',revision:'github-repository:1.0.0',allowedGrantClasses:['allowSession'],derive:input=>githubRepositoryScope(options.capabilityId,input)};}
