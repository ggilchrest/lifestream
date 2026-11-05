import {PresentationRuntime} from '../../control-web/presentation-runtime.js';
import {adjustMobileView,defaultView,findBodyAnchor,frameMobileCamera,installMobileGestures} from './mobile-camera.js';

export class MobilePresentationRuntime extends PresentationRuntime {
 constructor(canvas,options){
  super(canvas,options);this.view=defaultView();this.onViewChanged=options.onViewChanged??(()=>{});this.onViewReset=options.onViewReset??(()=>{});
  this.gestures=installMobileGestures(canvas,{adjust:change=>this.adjustView(change),reset:()=>this.resetView(),active:()=>!this.disposed&&!document.hidden&&!!this.current});
  this.onVisibility=()=>{this.gestures?.cancel();if(document.hidden)this.current?.adapter?.suspend();else this.last=performance.now();};document.addEventListener('visibilitychange',this.onVisibility);
  this.frame(this.current);
 }
 commit(value){this.gestures?.cancel();this.view=defaultView();if(!value.motionAnchor&&this.currentItem?.mobileView!=='authored')value.motionAnchor=findBodyAnchor(value);super.commit(value);}
 frame(value){if(!value)return;this.view??=defaultView();this.motionAnchorAt=frameMobileCamera(this.camera,value,this.view,this.currentItem?.mobileView==='authored');}
 adjustView(change){if(this.disposed||!this.current||!adjustMobileView(this.view,change))return false;this.frame(this.current);this.onViewChanged?.();return true;}
 resetView(){if(this.disposed||!this.current)return false;this.gestures?.cancel();this.view=defaultView();this.frame(this.current);this.onViewReset?.();return true;}
 pause(){this.gestures?.cancel();this.current?.adapter?.suspend();super.pause();}
 dispose(){this.gestures?.dispose();if(this.onVisibility)document.removeEventListener('visibilitychange',this.onVisibility);super.dispose();}
}
