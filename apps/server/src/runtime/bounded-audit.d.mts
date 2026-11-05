export const audit: {
 start():void;
 suppressContent():void;suppressSocketContent(socket:any):void;
 status(scope?:any):any; request(req:any,res:any,work:()=>Promise<void>,scope?:()=>any):Promise<void>;
 bindSocket(socket:any,request:any,scope?:()=>any,discovery?:()=>any):void; runTurn(socket:any,input:any,work:()=>Promise<void>):Promise<void>;
 controlMessage(socket:any,message:any):boolean;socketClosed(socket:any):void;
 bindTrace(id:string):void;bindPrepared(input:any):void; currentness(input:any,fields:any):void;
 event(stage:string,fields?:any,context?:any):void;forTrace(id:string|undefined,stage:string,fields?:any):void;
 content(stage:string,text:string,role?:string):void;pcm(stage:string,frame:any):void;socketMessage(socket:any,message:any):any;socketSent(socket:any,message:any):void;
 context():any;runContext(context:any,work:any):any;cleanup():boolean;close():void;
};
export function createAudit(options?:any):typeof audit;
export function redactText(value:unknown):string;
export const auditRoot:string;
