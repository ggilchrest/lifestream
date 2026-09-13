import {buildDatasetManifest,routeAdapter,type AdapterManifest,type AdapterRouteRequest,type AdapterRoute} from '@lifestream/runtime/training';
// Contract simulator only: no model loading, weight mutation or training dispatch.
export const fixtureTrainingProvider={prepareDataset:buildDatasetManifest,route:routeAdapter};
export class FixtureAdapterSession {
 readonly caches={kv:new Map<string,string>(),prefix:new Map<string,string>(),response:new Map<string,string>()};
 private pending=new Set<AbortController>();private identity='';
 route(manifest:AdapterManifest,request:AdapterRouteRequest):AdapterRoute {
  const result=routeAdapter(manifest,request),next=JSON.stringify([request.subjectId,request.assistantId,request.audience,result.route,result.artifactId,result.artifactRevision,request.datasetDigest,request.baseModelRevision,request.activeDependencies,request.revokedDependencies??[]]);
  if(next!==this.identity||result.route==='fallback'){this.invalidate();this.identity=next;}return result;
 }
 begin():AbortController{const controller=new AbortController();this.pending.add(controller);controller.signal.addEventListener('abort',()=>this.pending.delete(controller),{once:true});return controller;}
 complete(controller:AbortController):void{this.pending.delete(controller);}
 invalidate():void{for(const cache of Object.values(this.caches))cache.clear();for(const controller of this.pending)controller.abort('Adapter route or dependency changed');this.pending.clear();}
}
