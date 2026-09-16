import type {AuthorityRequest} from '@lifestream/contracts/provider-messages';
import type {PwceApprovalExpectation} from './approval-evidence.ts';
export type PwceApprovalIntent={invocationId:string;producerKey:string;expectation:PwceApprovalExpectation;request:AuthorityRequest;confirmationDigest:string};
export type PwceApprovalObservation={proofJson:string;sha256:string};
export type PwceApprovalRecord={intent:PwceApprovalIntent;latest:PwceApprovalObservation|null;observationCount:number};
/** An original reservation must commit before an approval request is sent.
 * Absence of proof is uncertainty, never permission to send again. */
export interface PwceApprovalCustody {
 read(producerKey:string):PwceApprovalRecord|undefined;
 reserve(intent:PwceApprovalIntent):boolean;
 observe(producerKey:string,proofJson:string):PwceApprovalRecord;
 readProof(producerKey:string,sha256:string):PwceApprovalObservation|undefined;
}
