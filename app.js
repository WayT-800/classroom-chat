const $ = (selector, root = document) => root.querySelector(selector);
const app = $('#app');
const rooms = [{id:'room-1',name:'채팅방 1'}, {id:'room-2',name:'채팅방 2'}];
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const readLocal = key => { try { return localStorage.getItem(key); } catch { return null; } };
const storeLocal = (key,value) => { try { localStorage.setItem(key,value); } catch {} };
const readJson = key => { try { return JSON.parse(readLocal(key)); } catch { return null; } };
let config = window.CHAT_CONFIG?.supabaseUrl ? window.CHAT_CONFIG : readJson('class-chat-config');
let client, user, room, selected = new URL(location.href).searchParams.get('room') === 'room-2' ? 'room-2' : 'room-1';
let admin = false, nickname = '', demo = false, channel, timer, messages = [], people = [];
let moreHistory = false, fetching = false, refreshing = false, switching = false, connection = '연결 중', toastTimer, kickTarget;
let activityAt=Date.now(), activityDirty=false, idleTimer;
let pendingSend = null, generation = 0, clearedThrough = 0;

function toast(text) { const target = $('#toast'); target.textContent=text; target.hidden=false; clearTimeout(toastTimer); toastTimer=setTimeout(()=>target.hidden=true,4500); }
function errorText(error) {
  const message = error?.message || String(error || '알 수 없는 오류');
  if (/anonymous.*disabled/i.test(message)) return 'Supabase에서 Anonymous Sign-Ins(익명 로그인)를 먼저 켜주세요.';
  if (/rate.limit|too many requests/i.test(message)) return '접속 요청이 많습니다. 잠시 후 다시 시도하거나 운영자에게 문의하세요.';
  if (/fetch|network|load failed/i.test(message)) return '연결할 수 없습니다. 인터넷 연결과 프로젝트 주소를 확인하세요.';
  if (/schema cache|chat_.*not.*exist|could not find.*function/i.test(message)) return 'Supabase SQL Editor에서 schema.sql과 초기 비밀번호 설정을 실행해 주세요.';
  if (/invalid api key|invalid jwt/i.test(message)) return '프로젝트 주소와 공개용 키를 다시 확인해 주세요.';
  return message;
}
async function rpc(name,args={}) { const {data,error}=await client.rpc(name,args); if(error) throw error; if(data?.ok===false) { const failure=new Error(data.error); failure.state=data.state; throw failure; } return data; }
async function busy(form,action,errorSelector) {
  const submit=$('button[type="submit"]',form); submit.disabled=true; const error=$(errorSelector); error.textContent='';
  try { await action(); } catch(e) { error.textContent=errorText(e); } finally { submit.disabled=false; }
}
function showDialog(id) { $(id).showModal(); }
document.querySelectorAll('[data-close]').forEach(button=>button.addEventListener('click',()=>button.closest('dialog').close()));
function brand() { return '<div class="brand"><img src="favicon.svg" alt="">우리반 톡</div>'; }
function roomName(id=room) { return rooms.find(item=>item.id===id)?.name || '채팅방'; }
function validateConfig(url,key) {
  let parsed; try { parsed=new URL(url); } catch { throw new Error('올바른 프로젝트 URL을 입력하세요.'); }
  if(parsed.protocol!=='https:' || !/^[a-z0-9-]+\.supabase\.co$/i.test(parsed.hostname) || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash || !['','/'].includes(parsed.pathname)) throw new Error('https://프로젝트ID.supabase.co 형식의 주소를 입력하세요.');
  if(key.startsWith('sb_secret_')) throw new Error('비밀 키는 사용할 수 없습니다. Publishable key를 입력하세요.');
  if(key.startsWith('eyJ')) {
    try { const payload=JSON.parse(atob(key.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))); if(payload.role!=='anon') throw new Error(); } catch { throw new Error('이 키는 공개용 anon key가 아닙니다. Publishable key를 사용하세요.'); }
  } else if(!key.startsWith('sb_publishable_')) throw new Error('Publishable key 또는 공개용 anon key를 입력하세요.');
  return {supabaseUrl:parsed.origin,publishableKey:key};
}
async function connect() {
  if(!config) return false;
  config=validateConfig(config.supabaseUrl,config.publishableKey);
  if(!window.supabase) throw new Error('라이브러리를 불러오지 못했습니다. 페이지를 새로고침해 주세요.');
  client=window.supabase.createClient(config.supabaseUrl,config.publishableKey,{auth:{storageKey:'class-chat-auth-'+new URL(config.supabaseUrl).hostname}});
  const result=await client.auth.getSession(); if(result.error) throw result.error;
  let session=result.data.session;
  if(!session) { const result=await client.auth.signInAnonymously(); if(result.error) throw result.error; session=result.data.session; }
  user=session.user;
  const {data,error}=await client.from('chat_rooms').select('id,name').order('id');
  if(error) throw error;
  if(data.length!==2) throw new Error('채팅방 설정이 필요합니다. schema.sql을 실행해 주세요.');
  data.forEach(item=>{ const local=rooms.find(r=>r.id===item.id); if(local) local.name=item.name; });
  return true;
}
function openSettings() { const form=$('#settings-form'); form.elements.url.value=config?.supabaseUrl || ''; form.elements.key.value=config?.publishableKey || ''; $('#settings-error').textContent=''; showDialog('#settings-dialog'); }
function renderLobby() {
  app.innerHTML=`<header class="site-header">${brand()}<div class="header-actions"><span class="pill">교육용 채팅</span><button class="text-button" id="settings-open">연결 설정</button></div></header>
    ${!client || !user ? '<div class="setup-banner"><span>아직 Supabase에 연결되지 않았어요. 설정을 마치면 함께 대화할 수 있습니다.</span><button id="preview" class="text-button">화면 미리보기</button></div>' : ''}
    <section class="lobby"><div class="intro"><p class="eyebrow">OUR CLASS, OUR CONVERSATION</p><h1>같이 이야기할까요?</h1><p>이야기할 방을 고르고,<br>친구들이 알아볼 별명으로 들어오세요.</p>
      <div class="rooms" role="group" aria-label="채팅방 선택">${rooms.map((r,i)=>`<button class="room-choice ${r.id===selected?'selected':''}" data-room="${r.id}" aria-pressed="${r.id===selected}"><span class="room-number">0${i+1}</span><span><span class="room-label">${escapeHtml(r.name)}</span><span class="room-caption">최대 10명 · 비밀번호</span></span><span class="room-radio"></span></button>`).join('')}</div>
      <p class="lobby-note">대화는 저장되어 다시 들어와도 이어서 볼 수 있어요.</p></div>
    <div class="join-card"><h2 id="join-title">${escapeHtml(roomName(selected))} 입장</h2><p class="muted">별명과 방 비밀번호만 있으면 돼요.</p>
      <form id="join-form"><label>별명<input name="nickname" autocomplete="nickname" maxlength="16" placeholder="어떤 이름으로 불러드릴까요?" value="${escapeHtml(readLocal('class-chat-nickname') || '')}" required></label>
      <label>방 비밀번호<input name="password" type="password" autocomplete="off" placeholder="선생님이 알려준 비밀번호" required></label>
      <p class="form-error" id="join-error" role="alert"></p><button class="button primary" type="submit">채팅방 입장</button><p class="field-note">함께 쓰는 공간이에요. 서로를 존중하며 이야기해요.</p></form>
      <div class="join-footer"><span class="small muted">방을 관리하시나요?</span><button class="text-button" id="admin-open">관리자 입장</button></div></div></section>
      <footer class="lobby-footer">우리반 톡 · 두 개의 작은 대화 공간</footer>`;
  $('#settings-open').onclick=openSettings;
  $('#preview')?.addEventListener('click',startDemo);
  $('[data-room="'+selected+'"]')?.setAttribute('aria-pressed','true');
  document.querySelectorAll('[data-room]').forEach(button=>button.onclick=()=>{
    selected=button.dataset.room;
    document.querySelectorAll('[data-room]').forEach(b=>{b.classList.toggle('selected',b===button);b.setAttribute('aria-pressed',String(b===button));});
    $('#join-title').textContent=roomName(selected)+' 입장';
    const url=new URL(location.href);url.searchParams.set('room',selected);history.replaceState(null,'',url);
  });
  $('#admin-open').onclick=()=>{ if(!client||!user) return openSettings(); $('#admin-error').textContent=''; $('#admin-form').reset(); showDialog('#admin-dialog'); };
  $('#join-form').onsubmit=event=>{event.preventDefault();const form=event.currentTarget;if(!client||!user) return openSettings();busy(form,async()=>{
    const name=form.elements.nickname.value.trim();
    await rpc('chat_join',{p_room:selected,p_nickname:name,p_password:form.elements.password.value});
    storeLocal('class-chat-nickname',name); nickname=name;admin=false;await enterRoom(selected);
  },'#join-error');};
}
function renderChat() {
  app.innerHTML=`<section class="chat-shell"><aside class="sidebar">${brand()}<div class="sidebar-label">우리의 채팅방</div>
    ${rooms.map((r,i)=>`<button class="nav-room ${r.id===room?'active':''}" data-switch="${r.id}"><span class="room-number">0${i+1}</span><span><strong>${escapeHtml(r.name)}</strong><small>${r.id===room?'현재 대화 중':'방 바꾸기'}</small></span></button>`).join('')}
    <div class="sidebar-bottom"><div class="me-card"><div class="avatar me">${escapeHtml(nickname.slice(0,1))}</div><div><strong>${escapeHtml(nickname)}</strong><small>${admin?'관리자':'나의 별명'}</small></div></div><button class="text-button" id="leave">방 나가기</button>${admin?'<button class="text-button" id="admin-logout">관리자 로그아웃</button>':''}</div></aside>
    <section class="chat-main" aria-label="대화"><header class="chat-header"><button class="icon-button mobile-back" id="mobile-leave" aria-label="방 나가기">‹</button><div class="chat-title-wrap"><h1>${escapeHtml(roomName())}</h1><div class="connection" id="connection">${demo?'화면 미리보기':escapeHtml(connection)}</div></div><div class="chat-tools"><button class="text-button" id="share">초대 링크</button>${admin?'<button class="text-button" id="export">기록 저장</button><button class="text-button" id="clear-chat">대화 청소</button>':''}<button class="text-button mobile-people" id="toggle-people" aria-expanded="false" aria-controls="people-panel">참여자</button></div></header>
    ${demo?'<div class="preview-banner">미리보기 · 샘플 대화입니다. 여기서 보낸 메시지는 저장되거나 다른 사람에게 전달되지 않습니다.</div>':''}
    <div class="message-area" id="messages" role="log" aria-label="채팅 메시지" aria-live="polite"></div>
    <form class="composer" id="send-form"><div class="composer-row"><textarea id="message-input" name="body" rows="1" maxlength="2000" aria-label="메시지" placeholder="메시지를 입력하세요" required></textarea><button class="button send-button" type="submit">전송</button></div><div class="composer-footer"><span>Enter 전송 · Shift + Enter 줄바꿈</span><span id="char-count">0 / 2,000</span></div><p class="form-error" id="send-error" role="alert"></p></form></section>
    <aside class="participants" id="people-panel" aria-label="참여자 목록"><h2>함께하는 사람 <span class="participant-count" id="people-count"></span></h2><div id="people"></div><p class="people-note">${admin?'관리자는 정원에 포함되지 않습니다. 내보내기를 누르면 해당 접속의 참여가 차단됩니다.':'한 방에 최대 10명까지 함께할 수 있어요. 대화 기록은 나간 후에도 보관됩니다.'}</p></aside></section>`;
  $('#leave').onclick=leaveToLobby;$('#mobile-leave').onclick=leaveToLobby;
  $('#admin-logout')?.addEventListener('click',async()=>{try{await rpc('chat_admin_logout');admin=false;await leaveToLobby();toast('관리자 로그아웃되었습니다.');}catch(e){toast(errorText(e));}});
  document.querySelectorAll('[data-switch]').forEach(button=>button.onclick=async()=>{
    if(button.dataset.switch===room || switching) return;
    if(admin&&!demo) {switching=true;try{await enterRoom(button.dataset.switch);}catch(e){toast(errorText(e));}finally{switching=false;}}
    else {selected=button.dataset.switch;await leaveToLobby();}
  });
  $('#toggle-people').onclick=()=>{const open=$('#people-panel').classList.toggle('open');$('#toggle-people').setAttribute('aria-expanded',String(open));};
  $('#share').onclick=async()=>{if(demo)return toast('Supabase 연결 후 실제 방 링크를 공유할 수 있어요.');const url=new URL(location.href);url.searchParams.set('room',room);try{await navigator.clipboard.writeText(url.href);toast('초대 링크를 복사했습니다. 비밀번호는 따로 알려주세요.');}catch{toast('주소창의 링크를 복사해 주세요.');}};
  $('#export')?.addEventListener('click',exportHistory);
  $('#clear-chat')?.addEventListener('click',()=>{ $('#clear-description').textContent=roomName()+'의 모든 대화와 입퇴장 알림을 삭제합니다. 참여자는 그대로 유지됩니다.'; $('#clear-error').textContent=''; showDialog('#clear-dialog'); });
  const input=$('#message-input');
  input.oninput=()=>{$('#char-count').textContent=input.value.length.toLocaleString()+' / 2,000';input.style.height='auto';input.style.height=Math.min(input.scrollHeight,150)+'px';};
  input.onkeydown=event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&event.keyCode!==229){event.preventDefault();$('#send-form').requestSubmit();}};
  $('#send-form').onsubmit=sendMessage;
  renderMessages(true);renderPeople();
}
function renderPeople() {
  if(!$('#people'))return;
  $('#people-count').textContent=people.length+' / 10';
  $('#people').innerHTML=people.map(person=>`<div class="person"><div class="avatar ${person.user_id===user?.id?'me':''}">${escapeHtml(person.nickname.slice(0,1))}</div><span class="person-name">${escapeHtml(person.nickname)}${person.user_id===user?.id?' <span class="muted">(나)</span>':''}</span>${admin&&person.user_id!==user?.id?`<button class="text-button" data-kick="${escapeHtml(person.user_id)}" aria-label="${escapeHtml(person.nickname)} 내보내기">내보내기</button>`:''}</div>`).join('') || '<p class="small muted">아직 입장한 사람이 없어요.</p>';
  document.querySelectorAll('[data-kick]').forEach(button=>button.onclick=()=>{kickTarget=people.find(p=>p.user_id===button.dataset.kick);$('#kick-description').textContent=kickTarget.nickname+' 님을 '+roomName()+'에서 내보냅니다.';$('#kick-error').textContent='';showDialog('#kick-dialog');});
}
function renderMessages(scroll=false) {
  const area=$('#messages');if(!area)return;
  const atBottom=area.scrollHeight-area.scrollTop-area.clientHeight<100;
  const oldHeight=area.scrollHeight,oldTop=area.scrollTop;
  const list=[...messages].sort((a,b)=>a.id-b.id);let lastDay='';
  let html=moreHistory?'<button class="history-button" id="more-history">이전 대화 보기</button>':'';
  for(const message of list){
    const date=new Date(message.created_at);const day=date.toLocaleDateString('ko-KR',{month:'long',day:'numeric',weekday:'short'});
    if(day!==lastDay){html+=`<div class="day-divider"><span>${escapeHtml(day)}</span></div>`;lastDay=day;}
    if(message.kind==='system'||message.kind==='clear'){html+=`<div class="system-message">${escapeHtml(message.body)}</div>`;continue;}
    const own=message.user_id===user?.id;
    html+=`<article class="message ${own?'own':''}">${own?'':`<div class="avatar">${escapeHtml(message.nickname.slice(0,1))}</div>`}<div class="message-stack">${own?'':`<span class="message-name">${escapeHtml(message.nickname)}${message.is_admin?'<span class="admin-mark">관리자</span>':''}</span>`}<div class="message-body-row"><div class="bubble">${escapeHtml(message.body)}</div><time class="message-time" datetime="${escapeHtml(message.created_at)}">${date.toLocaleTimeString('ko-KR',{hour:'numeric',minute:'2-digit'})}</time></div></div></article>`;
  }
  area.innerHTML=html || '<div class="empty-chat"><div class="empty-mark">톡</div><p>아직 대화가 없어요.<br>첫 인사를 건네보세요!</p></div>';
  $('#more-history')?.addEventListener('click',loadOlder);
  if(scroll||atBottom) area.scrollTop=area.scrollHeight;else area.scrollTop=oldTop+(area.scrollHeight-oldHeight);
}
function applyClear(cutoff){clearedThrough=Math.max(clearedThrough,Number(cutoff)||0);messages=messages.filter(m=>Number(m.id)>clearedThrough);if(clearedThrough)moreHistory=false;}
function mergeMessages(newMessages) {for(const m of newMessages)if(m.kind==='clear')applyClear(Number(m.id)-1);newMessages=newMessages.filter(m=>Number(m.id)>clearedThrough);const map=new Map(messages.map(m=>[m.id,m]));newMessages.forEach(m=>map.set(m.id,m));messages=[...map.values()].sort((a,b)=>a.id-b.id);}
function setConnection(text,offline=false){connection=text;const target=$('#connection');if(target&&!demo){target.textContent=text;target.classList.toggle('offline-line',offline);}}
async function cleanupRoom(){generation++;clearInterval(idleTimer);$('#idle-dialog').close();clearInterval(timer);timer=null;if(channel&&client){const old=channel;channel=null;await client.removeChannel(old);} }
async function enterRoom(id){
  await cleanupRoom();room=id;selected=id;demo=false;messages=[];people=[];moreHistory=false;clearedThrough=0;
  const status=await rpc('chat_status',{p_room:id,p_touch:true});admin=status.is_admin;nickname=status.nickname;people=status.participants;applyClear(status.cleared_through);
  const url=new URL(location.href);url.searchParams.set('room',id);history.replaceState(null,'',url);storeLocal('class-chat-room',id);
  connection='대화 불러오는 중';renderChat();
  activityAt=status.activity_at?new Date(status.activity_at).getTime():Date.now();activityDirty=false;
  idleTimer=setInterval(checkIdle,1000);
  const gen=generation;
  channel=client.channel('chat-'+id+'-'+crypto.randomUUID()).on('postgres_changes',{event:'INSERT',schema:'public',table:'chat_messages',filter:'room_id=eq.'+id},payload=>{
    if(generation!==gen)return;mergeMessages([payload.new]);renderMessages();
  }).subscribe(async state=>{
    if(generation!==gen)return;
    if(state==='SUBSCRIBED'){setConnection('실시간으로 연결됨');try{await syncLatest(gen);}catch(e){setConnection(errorText(e),true);}}
    else if(state==='CHANNEL_ERROR'||state==='TIMED_OUT'||state==='CLOSED'){setConnection('연결 확인 중 · 다시 연결되면 대화를 불러옵니다',true);}
  });
  try{await syncLatest(gen,true);}catch(e){setConnection(errorText(e),true);}
  timer=setInterval(()=>refreshStatus(gen),10000);
}
async function syncLatest(gen=generation,initial=false){
  if(demo||!room)return;
  let query=client.from('chat_messages').select('*').eq('room_id',room);
  const last=messages.length?Math.max(...messages.map(m=>m.id)):null;
  if(last&&!initial) query=query.gt('id',last).order('id',{ascending:true}).limit(1000);
  else query=query.order('id',{ascending:false}).limit(100);
  const {data,error}=await query;if(generation!==gen)return;if(error)throw error;
  if(!last||initial)moreHistory=data.length===100;
  mergeMessages(data);renderMessages(initial);
  if(last&&!initial&&data.length===1000)await syncLatest(gen);
}
async function refreshStatus(gen=generation){
  if(refreshing||demo||!room||generation!==gen)return;refreshing=true;
  try{
    if(activityDirty&&!admin){activityDirty=false;try{await rpc('chat_activity',{p_room:room});}catch(e){activityDirty=true;throw e;}if(generation!==gen)return;}
    const status=await rpc('chat_status',{p_room:room,p_touch:true});if(generation!==gen)return;
    if(status.activity_at)activityAt=Math.max(activityAt,new Date(status.activity_at).getTime());
    people=status.participants;applyClear(status.cleared_through);
    if(admin&&!status.is_admin){await leaveToLobby(false);toast('관리자 접속이 만료되었습니다. 다시 로그인하세요.');return;}
    renderPeople();renderMessages();
    if(!channel || connection!=='실시간으로 연결됨')await syncLatest(gen);
  }catch(e){if(generation!==gen)return;if(e.state){await leaveToLobby(false);toast(errorText(e));}else setConnection(errorText(e),true);}
  finally{refreshing=false;}
}
async function loadOlder(){
  if(fetching||demo||!messages.length)return;fetching=true;const gen=generation;
  try{const {data,error}=await client.from('chat_messages').select('*').eq('room_id',room).lt('id',Math.min(...messages.map(m=>m.id))).order('id',{ascending:false}).limit(100);if(error)throw error;if(gen!==generation)return;moreHistory=data.length===100;mergeMessages(data);renderMessages();}catch(e){toast(errorText(e));}finally{fetching=false;}
}
async function sendMessage(event){
  event.preventDefault();const form=event.currentTarget;const input=form.elements.body;const body=input.value.trim();if(!body||$('button[type="submit"]',form).disabled)return;
  const gen=generation;
  await busy(form,async()=>{
    if(demo){mergeMessages([{id:Date.now(),room_id:room,user_id:user.id,nickname,body,created_at:new Date().toISOString(),is_admin:false}]);}
    else{
      if(!pendingSend||pendingSend.body!==body||pendingSend.room!==room)pendingSend={body,room,nonce:crypto.randomUUID()};
      const result=await rpc('chat_send',{p_room:room,p_body:body,p_nonce:pendingSend.nonce});
      if(gen!==generation)return;
      mergeMessages([result.message]);pendingSend=null;
    }
    input.value='';input.style.height='auto';$('#char-count').textContent='0 / 2,000';renderMessages(true);input.focus();
  },'#send-error');
}
async function leaveToLobby(notifyServer=true){
  const oldRoom=room,wasDemo=demo;
  await cleanupRoom();room=null;pendingSend=null;
  if(notifyServer&&!wasDemo&&oldRoom&&client){try{await rpc('chat_leave',{p_room:oldRoom});}catch{toast('연결이 끊겨 접속 정리는 최대 90초 뒤 반영됩니다.');}}
  if(admin&&!wasDemo&&client){try{await rpc('chat_admin_logout');}catch{toast('관리자 로그아웃을 확인하지 못했습니다. 연결 후 다시 로그아웃해 주세요.');}}admin=false;
  storeLocal('class-chat-room','');demo=false;
  if(wasDemo){user=null;client=null;if(config){try{await connect();}catch(e){toast(errorText(e));}}}
  renderLobby();
}
async function exportHistory(){
  if(demo)return;const button=$('#export');button.disabled=true;const exportRoom=room;
  try{
    const all=[];let last=0;const status=await rpc('chat_status',{p_room:exportRoom});if(!status.is_admin)throw new Error('관리자 권한이 필요합니다.');
    while(true){const {data,error}=await client.from('chat_messages').select('*').eq('room_id',exportRoom).gt('id',last).order('id',{ascending:true}).limit(1000);if(error)throw error;all.push(...data);if(data.length<1000)break;last=data.at(-1).id;}
    const text=roomName(exportRoom)+' 대화 기록\n저장 시각: '+new Date().toLocaleString('ko-KR')+'\n\n'+all.map(m=>'['+new Date(m.created_at).toLocaleString('ko-KR')+'] '+m.nickname+(m.is_admin?' (관리자)':'')+'\n'+m.body).join('\n\n');
    const url=URL.createObjectURL(new Blob(['\uFEFF'+text],{type:'text/plain;charset=utf-8'}));const anchor=document.createElement('a');anchor.href=url;anchor.download=exportRoom+'-'+new Date().toISOString().slice(0,10)+'.txt';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast(all.length.toLocaleString()+'개의 메시지를 저장했습니다.');
  }catch(e){toast(errorText(e));}finally{button.disabled=false;}
}
function startDemo(){
  demo=true;admin=false;room=selected;nickname='나';user={id:'demo-me'};
  people=[{user_id:'demo-teacher',nickname:'선생님'},{user_id:'demo-1',nickname:'하늘'},{user_id:'demo-2',nickname:'지우'},{user_id:'demo-me',nickname:'나'}];
  const now=Date.now();messages=[
    {id:1,user_id:'demo-teacher',nickname:'선생님',body:'우리 반 채팅방에 오신 걸 환영해요!\n오늘 함께 나누고 싶은 생각을 적어볼까요?',is_admin:true,created_at:new Date(now-240000).toISOString()},
    {id:2,user_id:'demo-1',nickname:'하늘',body:'안녕하세요! 👋',created_at:new Date(now-180000).toISOString()},
    {id:3,user_id:'demo-me',nickname:'나',body:'반가워요. 오늘 수업도 잘 부탁해요 🙂',created_at:new Date(now-120000).toISOString()},
    {id:4,user_id:'demo-2',nickname:'지우',body:'같이 이야기하니까 더 재미있을 것 같아요!',created_at:new Date(now-60000).toISOString()}
  ];moreHistory=false;renderChat();
}
$('#clear-form').onsubmit=event=>{event.preventDefault();const form=event.currentTarget;const gen=generation;busy(form,async()=>{const result=await rpc('chat_clear',{p_room:room});if(gen!==generation)return;mergeMessages([result.message]);renderMessages(true);$('#clear-dialog').close();toast('대화방을 청소했습니다.');},'#clear-error');};

function noteActivity(event){
  if(event && !event.isTrusted)return;
  if(!room||demo||admin||$('#idle-dialog').open)return;
  activityAt=Date.now();activityDirty=true;
}
async function checkIdle(){
  if(!room||demo||admin)return;
  const remaining=31*60*1000-(Date.now()-activityAt);
  if(remaining<=0){await leaveToLobby();toast('30분간 활동이 없어 대기 후 자동 퇴장되었습니다. 다시 입장할 수 있어요.');return;}
  if(remaining<=60000){$('#idle-countdown').textContent=Math.ceil(remaining/1000)+'초 후 자동 퇴장됩니다.';if(!$('#idle-dialog').open)showDialog('#idle-dialog');}
}
for(const event of ['pointerdown','keydown','input','scroll'])document.addEventListener(event,noteActivity,{capture:true,passive:true});
$('#idle-continue').onclick=async()=>{
  const button=$('#idle-continue');button.disabled=true;
  try{await rpc('chat_activity',{p_room:room});await refreshStatus();if(room){activityAt=Date.now();activityDirty=false;$('#idle-dialog').close();}}
  catch(e){toast(errorText(e));}finally{button.disabled=false;}
};
$('#idle-dialog').addEventListener('cancel',event=>event.preventDefault());

$('#settings-form').onsubmit=event=>{event.preventDefault();const form=event.currentTarget;busy(form,async()=>{
  const next=validateConfig(form.elements.url.value.trim(),form.elements.key.value.trim());
  await cleanupRoom();room=null;demo=false;user=null;client=null;config=next;
  try{await connect();storeLocal('class-chat-config',JSON.stringify(config));$('#settings-dialog').close();renderLobby();toast('연결되었습니다. 방 비밀번호를 입력해 입장하세요.');}catch(e){user=null;client=null;renderLobby();throw e;}
},'#settings-error');};
$('#admin-form').onsubmit=event=>{event.preventDefault();const form=event.currentTarget;busy(form,async()=>{await rpc('chat_admin_login',{p_password:form.elements.password.value});form.reset();$('#admin-dialog').close();admin=true;await enterRoom(selected);},'#admin-error');};
$('#kick-form').onsubmit=event=>{event.preventDefault();const form=event.currentTarget;busy(form,async()=>{await rpc('chat_kick',{p_room:room,p_user:kickTarget.user_id});$('#kick-dialog').close();toast(kickTarget.nickname+' 님을 내보냈습니다.');await refreshStatus();},'#kick-error');};
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&room&&!demo){refreshStatus();syncLatest().catch(e=>setConnection(errorText(e),true));}});
window.addEventListener('online',()=>{if(room&&!demo){refreshStatus();syncLatest().catch(e=>toast(errorText(e)));}});
window.addEventListener('offline',()=>setConnection('인터넷 연결이 끊겼습니다. 입력 중인 메시지는 그대로 유지됩니다.',true));

async function init(){
  if(!config)return renderLobby();
  app.innerHTML='<div class="loading-state"><img src="favicon.svg" alt=""><p>우리반 톡에 연결하고 있어요…</p></div>';
  try{await connect();const last=readLocal('class-chat-room');if(last===selected&&rooms.some(r=>r.id===last)){try{await enterRoom(last);return;}catch{await cleanupRoom();room=null;storeLocal('class-chat-room','');}}renderLobby();}
  catch(e){client=null;user=null;renderLobby();toast(errorText(e));}
}
init();
