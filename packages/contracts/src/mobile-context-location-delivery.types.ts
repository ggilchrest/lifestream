// Data shapes only. An issuer, currentness, SQL commit and acknowledgement are separate owners.
import type {mobileLocationPin} from './mobile-context-location.pin.ts';
export type LocationDeliveryBinding={humanId:string;endpointId:string;enrollmentId:string;enrollmentRevision:number;collector:'coreLocation'|'androidLocation';sourceNamespace:string;sourceEpoch:string;policyRevision:number;policyBindingDigest:string;policyRef:string;classificationRuleRef:string;retentionPolicyRef:string;useScopeRef:string};
export type LocationDeliveryItem={schemaVersion:'1.0.0';binding:LocationDeliveryBinding;eventId:string;attemptId:string;rawProducerPin:typeof mobileLocationPin;observationUtf8Base64:string;observationSha256:string;requestDigest:string};
export type LocationDeliveryBatch={schemaVersion:'1.0.0';items:LocationDeliveryItem[]};
type LocationReceiptIdentity={schemaVersion:'1.0.0';binding:LocationDeliveryBinding;eventId:string;attemptId:string;observationSha256:string;requestDigest:string;receiptDigest:string};
export type LocationDeliveryReceipt=LocationReceiptIdentity&({outcome:'accepted';code:'stored';durability:'sqlCommit'}|{outcome:'duplicate';code:'sameOriginal';durability:'sqlCommit'}|{outcome:'rejected';code:'invalid'|'scope'|'policyChanged'|'suppressed'|'conflict'|'quota'|'unavailable';durability:null}|{outcome:'unknown';code:'unavailable';durability:null});
type LocationEnrollmentIdentity={schemaVersion:'1.0.0';enrollmentId:string;humanId:string;endpointId:string;collector:LocationDeliveryBinding['collector'];revision:number};
export type LocationEnrollmentDescriptor=LocationEnrollmentIdentity&({state:'unbound';sourceNamespace:null}|{state:'active'|'disconnected';sourceNamespace:string});
export type LocationPolicyDescriptor={schemaVersion:'1.0.0';binding:LocationDeliveryBinding;allowedObservationKinds:('position'|'regionTransition'|'unavailable')[];collectionAllowed:boolean;useAllowed:boolean};
