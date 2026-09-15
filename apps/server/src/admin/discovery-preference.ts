import {understandingDigest} from '@lifestream/storage-sqlite';

export type FavoriteEvidence={ref:string;revision:number;content:string;basis:string};
export const favoriteMethod='discovery-explicit-favorite:1';
export const evidenceDependency=(evidence:FavoriteEvidence):string=>`evidence:${understandingDigest([evidence.ref,evidence.revision,evidence.content,evidence.basis])}`;
const normalized=(value:string)=>value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/[-_]/gu,' ').replace(/\s+/gu,' ').trim();
/** A deliberately explicit grammar, not sentiment analysis or a general claim about taste. */
export function favoriteSupport(topicRefs:readonly string[],evidence:readonly FavoriteEvidence[],dependencies:readonly string[]):FavoriteEvidence[] {
 if(evidence.length>24)return [];
 const topics=new Set(topicRefs.map(ref=>normalized(ref.replace(/^topic:/u,''))));
 return evidence.filter(record=>{
  if(record.basis!=='userDeclaration'||!Number.isInteger(record.revision)||record.revision<1||record.content.length>300||!dependencies.includes(evidenceDependency(record)))return false;
  // Whole statements only: qualifiers, negation, quotations, conditional/hypothetical and
  // imported prose cannot be silently stripped to manufacture a direct assertion.
  const statement=record.content.trim().replace(/[.!]$/u,'').trim();
  const match=/^([\p{L}\p{N}][\p{L}\p{N} '_-]{0,150}) is my favou?rite$/iu.exec(statement)??/^my favou?rite is ([\p{L}\p{N}][\p{L}\p{N} '_-]{0,150})$/iu.exec(statement);
  return !!match&&topics.has(normalized(match[1]!));
 });
}
