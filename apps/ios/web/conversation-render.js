// A visual group never merges or changes the identities held by history.
function trimToLimit(list){
 const size=()=>[...list.children].reduce((n,item)=>n+(item.dataset.voiceGroup==='true'?item.querySelectorAll('[data-message-id]').length:1),0);
 while(size()>100){const first=list.firstElementChild;if(first.dataset.voiceGroup==='true'){const parts=first.querySelectorAll('[data-message-id]');if(parts.length>1){parts[0].remove();const next=parts[1];if(next.textContent.startsWith(' '))next.textContent=next.textContent.slice(1);}else first.remove();}else first.remove();}
}
export function appendConversationMessage(list,{role,text,trace,append=false,groupVoice=false}){
 const following=list.scrollHeight-list.clientHeight-list.scrollTop <= 64;
 const items=[...list.children];
 if(groupVoice&&items.some(item=>[...item.querySelectorAll('[data-message-id]')].some(part=>part.dataset.messageId===trace)))return;
 if(role==='assistant'&&!text)return;
 let entry=append?items.find(item=>item.dataset.trace===trace&&item.dataset.role===role):null;
 if(!entry&&groupVoice){const last=list.lastElementChild;if(last?.dataset.role==='user'&&last.dataset.voiceGroup==='true')entry=last;}
 if(!entry){entry=document.createElement('li');entry.dataset.role=role;entry.dataset.trace=trace;if(groupVoice)entry.dataset.voiceGroup='true';entry.append(document.createElement('strong'),document.createElement('p'));entry.firstChild.textContent=role==='user'?'You':'Assistant';list.append(entry);}
 if(groupVoice){const part=document.createElement('span');part.dataset.messageId=trace;const existing=entry.lastChild.textContent,separator=existing&&!/\s$/.test(existing)&&!/^\s|^[,.;:!?]/.test(text)?' ':'';part.textContent=separator+text;entry.lastChild.append(part);}
 else entry.lastChild.textContent=((append?entry.lastChild.textContent:'')+text).slice(-64000);
 trimToLimit(list);if(following)list.scrollTop=list.scrollHeight;
}

// Follow viewport changes only while the reader is already at the end.
export function trackConversationViewport(list){
 let following=true;
 list.addEventListener('scroll',()=>{following=list.scrollHeight-list.clientHeight-list.scrollTop<=64;},{passive:true});
 const observer=new ResizeObserver(()=>{if(following)list.scrollTop=list.scrollHeight;});
 observer.observe(list);return ()=>observer.disconnect();
}
