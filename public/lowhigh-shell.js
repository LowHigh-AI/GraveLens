"use strict";var LowHighShell=(()=>{var T=Object.defineProperty;var D=Object.getOwnPropertyDescriptor;var H=Object.getOwnPropertyNames;var P=Object.prototype.hasOwnProperty;var I=(n,s)=>{for(var e in s)T(n,e,{get:s[e],enumerable:!0})},O=(n,s,e,t)=>{if(s&&typeof s=="object"||typeof s=="function")for(let r of H(s))!P.call(n,r)&&r!==e&&T(n,r,{get:()=>s[r],enumerable:!(t=D(s,r))||t.enumerable});return n};var q=n=>O(T({},"__esModule",{value:!0}),n);var V={};I(V,{LowHighLauncher:()=>x,LowHighSupport:()=>w});var k=`
:host {
    --lhs-bg: var(--lhs-bg-override, #101014);
    --lhs-surface: var(--lhs-surface-override, rgba(255, 255, 255, 0.05));
    --lhs-border: var(--lhs-border-override, rgba(255, 255, 255, 0.1));
    --lhs-text: var(--lhs-text-override, #f4f4f5);
    --lhs-muted: var(--lhs-muted-override, #9b9ba3);
    --lhs-accent: var(--lhs-accent-override, #fec43d);
    --lhs-accent-contrast: var(--lhs-accent-contrast-override, #111111);
    --lhs-radius: var(--lhs-radius-override, 14px);
    --lhs-z: var(--lhs-z-override, 2000);
    font-family: var(--lhs-font-override, inherit);
    color: var(--lhs-text);
    box-sizing: border-box;
}
*, *::before, *::after { box-sizing: inherit; }
button { font: inherit; color: inherit; background: none; border: none; cursor: pointer; padding: 0; }
input, textarea, select { font: inherit; }
[hidden] { display: none !important; }

.spinner {
    width: 16px; height: 16px; border-radius: 50%;
    border: 2px solid var(--lhs-accent); border-top-color: transparent;
    animation: lhs-spin 0.7s linear infinite; margin: 0 auto;
}
@keyframes lhs-spin { to { transform: rotate(360deg); } }

.error-note {
    padding: 10px 12px; border-radius: 10px; font-size: 13px; line-height: 1.4;
    background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3);
    color: #f2b8b5;
}

.badge {
    display: inline-flex; align-items: center; gap: 4px;
    font-size: 10.5px; font-weight: 600; letter-spacing: 0.02em;
    padding: 2px 7px; border-radius: 999px; white-space: nowrap;
}
.badge.soon {
    color: var(--lhs-muted);
    background: var(--lhs-surface);
    border: 1px solid var(--lhs-border);
}
`;function B(n,s){var e,t,r,i,o,d,l,c;return n===s?!0:!n||!s?!1:n.supabaseUrl===s.supabaseUrl&&n.supabaseAnonKey===s.supabaseAnonKey&&((e=n.accessToken)!=null?e:null)===((t=s.accessToken)!=null?t:null)&&((r=n.userId)!=null?r:null)===((i=s.userId)!=null?i:null)&&n.appSlug===s.appSlug&&((o=n.hubUrl)!=null?o:null)===((d=s.hubUrl)!=null?d:null)&&((l=n.variant)!=null?l:"trigger")===((c=s.variant)!=null?c:"trigger")}var g=class extends HTMLElement{constructor(){super();this._config=null;this.renderQueued=!1;this.root=this.attachShadow({mode:"open"})}get config(){return this._config}set config(e){let t=this._config;this._config=e,B(t,e)||this.scheduleRender()}scheduleRender(){this.renderQueued||(this.renderQueued=!0,queueMicrotask(()=>{this.renderQueued=!1,this.isConnected&&this.render()}))}connectedCallback(){if(Object.prototype.hasOwnProperty.call(this,"config")){let e=this.config;delete this.config,this.config=e}this.render()}qs(e){return this.root.querySelector(e)}qsa(e){return Array.from(this.root.querySelectorAll(e))}};async function h(n,s,e){let t=await fetch(`${n.supabaseUrl.replace(/\/$/,"")}/rest/v1/${s}`,{...e,headers:{apikey:n.supabaseAnonKey,Authorization:`Bearer ${n.accessToken||n.supabaseAnonKey}`,"Content-Type":"application/json",...(e==null?void 0:e.headers)||{}}});if(!t.ok){let r=`Request failed (${t.status})`;try{let i=await t.json();r=i.message||i.error||r}catch{}throw new Error(r)}if(t.status!==204)return await t.json()}function a(n){return String(n!=null?n:"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;")}function v(n){let s=new Date(n);return Number.isNaN(s.getTime())?"":s.toLocaleDateString(void 0,{month:"short",day:"numeric",year:"numeric"})}var N="slug,name,short_description,icon_url,url,category,included_in_plans,status,featured,featured_copy,popularity,manual_order",j=5*60*1e3,S="lowhigh-shell:catalog:v1",u=null,b=null;function U(n){try{if(typeof localStorage=="undefined")return null;let s=localStorage.getItem(S);if(!s)return null;let e=JSON.parse(s);return!e||e.key!==n||!Array.isArray(e.apps)?null:e.apps}catch{return null}}function K(n,s){try{if(typeof localStorage=="undefined")return;localStorage.setItem(S,JSON.stringify({key:n,at:Date.now(),apps:s}))}catch{}}function $(n){let s=n.supabaseUrl;if(u&&u.key===s)return u.apps;let e=U(s);return e?(u={key:s,at:0,apps:e},e):null}async function A(n){let s=n.supabaseUrl,e=Date.now();return u&&u.key===s&&e-u.at<j?u.apps:b||(b=h(n,`app_catalog?select=${N}`).then(t=>(u={key:s,at:Date.now(),apps:t},K(s,t),t)).finally(()=>{b=null}),b)}function L(n,s){return n.filter(e=>e.status!=="hidden"&&e.status!=="deprecated").sort((e,t)=>{var r,i;return+(t.slug===s)-+(e.slug===s)||((r=e.manual_order)!=null?r:Number.MAX_SAFE_INTEGER)-((i=t.manual_order)!=null?i:Number.MAX_SAFE_INTEGER)||t.popularity-e.popularity||e.name.localeCompare(t.name)})}var M=`${k}
:host { position: relative; display: inline-block; }
:host([data-variant="inline"]) { display: block; }

.trigger {
    width: 36px; height: 36px; border-radius: 12px;
    display: inline-flex; align-items: center; justify-content: center;
    color: var(--lhs-muted); transition: background 0.15s ease, color 0.15s ease;
}
.trigger:hover, .trigger[aria-expanded="true"] { background: var(--lhs-surface); color: var(--lhs-accent); }
.trigger:focus-visible { outline: 2px solid var(--lhs-accent); outline-offset: 2px; }

.panel {
    position: absolute; top: calc(100% + 10px); right: 0; z-index: var(--lhs-z);
    width: min(340px, 92vw);
    background: var(--lhs-bg); border: 1px solid var(--lhs-border);
    border-radius: var(--lhs-radius);
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.45);
    overflow: hidden;
}
/* Inline: the host frames us (e.g. inside an account dropdown), so drop the
   floating chrome and sit flush in flow. */
.panel.inline {
    position: static; width: auto;
    background: none; border: none; border-radius: 0;
    box-shadow: none; overflow: visible;
}
/* The host frames the section with its own "More from LowHigh" row, so the
   panel's own header would just duplicate it. */
.panel.inline .panel-head { display: none; }
.panel.inline .apps { padding: 0; max-height: min(46vh, 320px); }
.panel.inline .app { padding: 8px; }
.panel.inline .app-icon { width: 32px; height: 32px; }
.panel-head {
    display: flex; align-items: center; gap: 8px;
    padding: 11px 14px; text-decoration: none;
    font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--lhs-muted); border-bottom: 1px solid var(--lhs-border);
    transition: color 0.12s ease;
}
a.panel-head:hover, a.panel-head:focus-visible { color: var(--lhs-text); outline: none; }
.head-logo {
    width: 18px; height: 18px; border-radius: 5px; flex-shrink: 0; object-fit: contain;
}
.apps { max-height: min(58vh, 420px); overflow-y: auto; padding: 6px; }
.app {
    display: flex; align-items: center; gap: 11px; width: 100%; text-align: left;
    padding: 10px; border-radius: 11px; text-decoration: none; color: inherit;
    transition: background 0.12s ease;
}
a.app:hover, a.app:focus-visible { background: var(--lhs-surface); outline: none; }
.app.disabled { cursor: default; opacity: 0.75; }
/* Current app: a non-clickable "you are here" marker, not a destination. */
.app.current { cursor: default; background: var(--lhs-surface); }
.app-icon {
    width: 38px; height: 38px; border-radius: 10px; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    background: var(--lhs-surface); border: 1px solid var(--lhs-border);
    font-weight: 700; font-size: 15px; color: var(--lhs-accent);
    overflow: hidden;
}
/* contain (not cover) + padding so a real logo is centered and never cropped,
   regardless of the source aspect ratio or built-in margins. */
.app-icon img { width: 100%; height: 100%; object-fit: contain; padding: 3px; }
.app-main { flex: 1; min-width: 0; }
.app-name-row { display: flex; align-items: center; gap: 7px; }
.app-name { font-size: 14px; font-weight: 600; color: var(--lhs-text); }
.app-desc {
    font-size: 12px; color: var(--lhs-muted); line-height: 1.35; margin-top: 1px;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.current-tag { font-size: 10.5px; font-weight: 600; color: var(--lhs-muted); }
.state { padding: 22px 14px; text-align: center; font-size: 13px; color: var(--lhs-muted); }
`,G="https://www.lowhigh.ai/logo.png",W=`
<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
    <circle cx="5" cy="5" r="1.6"/><circle cx="12" cy="5" r="1.6"/><circle cx="19" cy="5" r="1.6"/>
    <circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>
    <circle cx="5" cy="19" r="1.6"/><circle cx="12" cy="19" r="1.6"/><circle cx="19" cy="19" r="1.6"/>
</svg>`,x=class extends g{constructor(){super(...arguments);this.open=!1;this.loading=!1;this.loadError=null;this.apps=null;this.warmed=!1;this.onDocPointerDown=e=>{this.open&&(e.composedPath().includes(this)||this.toggle(!1))};this.onDocKeyDown=e=>{var t;this.open&&e.key==="Escape"&&(this.toggle(!1),(t=this.qs(".trigger"))==null||t.focus())}}connectedCallback(){super.connectedCallback(),document.addEventListener("pointerdown",this.onDocPointerDown),document.addEventListener("keydown",this.onDocKeyDown)}disconnectedCallback(){document.removeEventListener("pointerdown",this.onDocPointerDown),document.removeEventListener("keydown",this.onDocKeyDown)}toggle(e){this.open!==e&&(this.open=e,e&&!this.apps&&!this.loading&&this.load(),this.scheduleRender())}async load(){let e=this.config;if(e){this.loading=!0,this.loadError=null,this.scheduleRender();try{this.apps=await A(e)}catch(t){this.loadError=t instanceof Error?t.message:"Could not load apps",console.error("[lowhigh-launcher] catalog fetch failed:",t)}finally{this.loading=!1,this.scheduleRender()}}}render(){var r,i,o;let e=this.config;e&&!this.warmed&&(this.warmed=!0,this.apps||(this.apps=$(e)),this.load());let t=(e==null?void 0:e.variant)==="inline";if(t?this.setAttribute("data-variant","inline"):this.removeAttribute("data-variant"),t){this.root.innerHTML=`
                <style>${M}</style>
                ${this.renderPanel((r=e==null?void 0:e.appSlug)!=null?r:"",(e==null?void 0:e.hubUrl)||"https://www.lowhigh.ai",!0)}
            `;return}this.root.innerHTML=`
            <style>${M}</style>
            <button class="trigger" type="button" aria-haspopup="dialog"
                aria-expanded="${this.open}" aria-label="LowHigh apps" title="LowHigh apps">
                ${W}
            </button>
            ${this.open?this.renderPanel((i=e==null?void 0:e.appSlug)!=null?i:"",(e==null?void 0:e.hubUrl)||"https://www.lowhigh.ai"):""}
        `,(o=this.qs(".trigger"))==null||o.addEventListener("click",()=>this.toggle(!this.open))}renderPanel(e,t,r=!1){let i;return this.apps&&this.apps.length>0?i=`<div class="apps" role="list">${L(this.apps,e).map(d=>this.renderApp(d,e)).join("")}</div>`:this.loading?i='<div class="state"><div class="spinner"></div></div>':this.loadError?i='<div class="state">Apps are unavailable right now. Please try again shortly.</div>':i='<div class="state">No apps to show yet.</div>',`
            <div class="panel${r?" inline":""}" role="${r?"group":"dialog"}" aria-label="More from LowHigh">
                <a class="panel-head" href="${a(t)}" target="_blank" rel="noopener noreferrer" title="Go to LowHigh (opens in new tab)">
                    <img class="head-logo" src="${G}" alt="" />
                    More from LowHigh
                </a>
                ${i}
            </div>
        `}renderApp(e,t){let r=e.slug===t,i=e.status==="coming_soon",o=e.icon_url?`<img src="${a(e.icon_url)}" alt="" loading="lazy" />`:a(e.name.charAt(0).toUpperCase()),d=i?'<span class="badge soon">Coming soon</span>':"",l=`
            <span class="app-icon" aria-hidden="true">${o}</span>
            <span class="app-main">
                <span class="app-name-row">
                    <span class="app-name">${a(e.name)}</span>
                    ${r?'<span class="current-tag">Current app</span>':d}
                </span>
                <span class="app-desc">${a(e.short_description)}</span>
            </span>
        `;return i?`<div class="app disabled" role="listitem">${l}</div>`:r?`<div class="app current" role="listitem" aria-current="page">${l}</div>`:`<a class="app" role="listitem" href="${a(e.url)}" target="_blank" rel="noopener noreferrer" aria-label="${a(e.name)} (opens in new tab)">${l}</a>`}};var R=["resolved","closed"],y={bug:"Bug","feature-request":"Feature request",general:"Question"};var Y="id,type,title,app_slug,status,priority,created_at,updated_at,ticket_comments(count)",F="id,user_id,body,is_admin_reply,is_system,created_at",_={open:"Open","in-review":"In review","in-progress":"In progress",resolved:"Resolved",closed:"Closed",duplicate:"Duplicate"},J=`${k}
.backdrop {
    position: fixed; inset: 0; z-index: var(--lhs-z);
    background: rgba(0, 0, 0, 0.55);
}
.sheet {
    position: fixed; z-index: calc(var(--lhs-z) + 1);
    top: 0; right: 0; bottom: 0;
    width: min(430px, 100vw);
    background: var(--lhs-bg);
    border-left: 1px solid var(--lhs-border);
    display: flex; flex-direction: column;
    box-shadow: -18px 0 50px rgba(0, 0, 0, 0.4);
    animation: lhs-slide-in 0.22s ease;
    padding-bottom: env(safe-area-inset-bottom);
}
@keyframes lhs-slide-in { from { transform: translateX(24px); opacity: 0; } to { transform: none; opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .sheet { animation: none; } }

.head {
    display: flex; align-items: center; gap: 10px;
    padding: max(14px, env(safe-area-inset-top)) 16px 12px;
    border-bottom: 1px solid var(--lhs-border); flex-shrink: 0;
}
.head-title { flex: 1; min-width: 0; font-size: 15px; font-weight: 700; }
.head button {
    width: 32px; height: 32px; border-radius: 10px; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center; color: var(--lhs-muted);
}
.head button:hover { background: var(--lhs-surface); color: var(--lhs-text); }
.head button:focus-visible { outline: 2px solid var(--lhs-accent); outline-offset: 1px; }

.body { flex: 1; overflow-y: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }

.primary-btn {
    display: flex; align-items: center; justify-content: center; gap: 7px;
    width: 100%; padding: 11px; border-radius: 12px;
    background: var(--lhs-accent); color: var(--lhs-accent-contrast);
    font-size: 14px; font-weight: 700; transition: filter 0.15s ease;
}
.primary-btn:hover { filter: brightness(1.08); }
.primary-btn:disabled { opacity: 0.55; cursor: default; }
.primary-btn:focus-visible { outline: 2px solid var(--lhs-text); outline-offset: 2px; }

.ticket {
    display: block; width: 100%; text-align: left;
    padding: 12px; border-radius: 12px;
    background: var(--lhs-surface); border: 1px solid var(--lhs-border);
    transition: border-color 0.15s ease;
}
.ticket:hover { border-color: color-mix(in srgb, var(--lhs-accent) 45%, transparent); }
.ticket:focus-visible { outline: 2px solid var(--lhs-accent); outline-offset: 1px; }
.ticket-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.ticket-title { font-size: 13.5px; font-weight: 600; color: var(--lhs-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ticket-meta { margin-top: 4px; font-size: 11.5px; color: var(--lhs-muted); display: flex; gap: 8px; flex-wrap: wrap; }

.status { font-size: 10.5px; font-weight: 700; padding: 2px 8px; border-radius: 999px; flex-shrink: 0; }
.status.open, .status.in-review, .status.in-progress {
    color: var(--lhs-accent);
    background: color-mix(in srgb, var(--lhs-accent) 12%, transparent);
}
.status.resolved { color: #6fcf8f; background: rgba(74, 222, 128, 0.12); }
.status.closed, .status.duplicate { color: var(--lhs-muted); background: var(--lhs-surface); border: 1px solid var(--lhs-border); }

label { font-size: 12px; font-weight: 600; color: var(--lhs-muted); display: block; margin-bottom: 5px; }
.field { margin-bottom: 2px; }
input[type="text"], textarea, select {
    width: 100%; padding: 10px 11px; border-radius: 10px;
    background: var(--lhs-surface); border: 1px solid var(--lhs-border);
    color: var(--lhs-text); font-size: 13.5px;
}
input:focus, textarea:focus, select:focus { outline: 2px solid var(--lhs-accent); outline-offset: -1px; }
textarea { resize: vertical; min-height: 110px; line-height: 1.45; }
select { appearance: none; }

.detail-title { font-size: 15.5px; font-weight: 700; line-height: 1.35; }
.detail-meta { font-size: 12px; color: var(--lhs-muted); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.msg { padding: 11px 12px; border-radius: 12px; font-size: 13px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
.msg.mine { background: var(--lhs-surface); border: 1px solid var(--lhs-border); }
.msg.team { background: color-mix(in srgb, var(--lhs-accent) 8%, transparent); border: 1px solid color-mix(in srgb, var(--lhs-accent) 25%, transparent); }
.msg.system { background: none; border: 1px dashed var(--lhs-border); color: var(--lhs-muted); font-size: 12px; }
.msg-who { font-size: 11px; font-weight: 700; color: var(--lhs-muted); margin-bottom: 3px; }
.msg.team .msg-who { color: var(--lhs-accent); }

.attach {
    display: flex; align-items: center; gap: 10px;
    padding: 8px; border-radius: 12px;
    background: var(--lhs-surface); border: 1px solid var(--lhs-border);
}
.attach-thumb {
    width: 52px; height: 52px; flex-shrink: 0;
    object-fit: cover; border-radius: 8px;
    border: 1px solid var(--lhs-border); background: var(--lhs-bg);
}
.attach-info { flex: 1; min-width: 0; }
.attach-name { font-size: 12.5px; font-weight: 600; color: var(--lhs-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.attach-note { font-size: 11.5px; color: var(--lhs-muted); margin-top: 2px; }
.attach-remove {
    width: 30px; height: 30px; border-radius: 9px; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center; color: var(--lhs-muted);
}
.attach-remove:hover { background: var(--lhs-bg); color: var(--lhs-text); }
.attach-remove:focus-visible { outline: 2px solid var(--lhs-accent); outline-offset: 1px; }

.reply { display: flex; flex-direction: column; gap: 8px; padding-top: 4px; }
.closed-note { font-size: 12.5px; color: var(--lhs-muted); text-align: center; padding: 8px 4px; line-height: 1.5; }
.empty { text-align: center; color: var(--lhs-muted); font-size: 13px; padding: 26px 10px; line-height: 1.5; }
.center { padding: 26px 0; }
`,z='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',Q='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>',w=class extends g{constructor(){super(...arguments);this.view="list";this.tickets=null;this.detail=null;this.comments=[];this.loading=!1;this.submitting=!1;this.errorMsg=null;this.draft={type:"bug",title:"",body:"",reply:""};this._pendingAttachment=null;this.attachmentRemoved=!1;this.onKeyDown=e=>{this.isOpen&&e.key==="Escape"&&this.close()}}static get observedAttributes(){return["open"]}get pendingAttachment(){return this._pendingAttachment}set pendingAttachment(e){this._pendingAttachment=e,this.scheduleRender()}get isOpen(){return this.hasAttribute("open")}attributeChangedCallback(e,t,r){e!=="open"||t===r||(r!==null&&(this.view="list",this.errorMsg=null,this.attachmentRemoved=!1,this.loadTickets()),this.scheduleRender())}connectedCallback(){super.connectedCallback(),document.addEventListener("keydown",this.onKeyDown)}disconnectedCallback(){document.removeEventListener("keydown",this.onKeyDown)}close(){this.removeAttribute("open"),this.dispatchEvent(new CustomEvent("lhs-close",{bubbles:!0,composed:!0}))}async loadTickets(){let e=this.config;if(e!=null&&e.accessToken){this.loading=!0,this.scheduleRender();try{this.tickets=await h(e,`support_tickets?select=${Y}&order=updated_at.desc`),this.errorMsg=null}catch(t){this.errorMsg="Could not load your tickets. Please try again.",console.error("[lowhigh-support] ticket list failed:",t)}finally{this.loading=!1,this.scheduleRender()}}}async openDetail(e){var r;let t=this.config;if(t!=null&&t.accessToken){this.view="detail",this.loading=!0,this.detail=null,this.comments=[],this.draft.reply="",this.scheduleRender();try{let[i,o]=await Promise.all([h(t,`support_tickets?id=eq.${e}&select=*`),h(t,`ticket_comments?ticket_id=eq.${e}&is_internal=eq.false&select=${F}&order=created_at.asc`)]);this.detail=(r=i[0])!=null?r:null,this.comments=o,this.errorMsg=this.detail?null:"Ticket not found."}catch(i){this.errorMsg="Could not load this ticket. Please try again.",console.error("[lowhigh-support] ticket detail failed:",i)}finally{this.loading=!1,this.scheduleRender()}}}async submitTicket(){let e=this.config;if(!(e!=null&&e.accessToken)||!e.userId||this.submitting)return;let t=this.draft.title.trim(),r=this.draft.body.trim();if(!t||!r){this.errorMsg="Please add a title and a description.",this.scheduleRender();return}this.submitting=!0,this.errorMsg=null,this.scheduleRender();try{let i=[];if(this._pendingAttachment&&!this.attachmentRemoved)try{i=[await this._pendingAttachment.upload()]}catch(d){console.warn("[lowhigh-support] attachment upload failed:",d)}let o=await h(e,"support_tickets",{method:"POST",headers:{Prefer:"return=representation"},body:JSON.stringify({user_id:e.userId,type:this.draft.type,title:t,body:r,app_slug:e.appSlug||null,attachments:i,status:"open",priority:"medium"})});this.draft={type:"bug",title:"",body:"",reply:""},this._pendingAttachment=null,this.attachmentRemoved=!1,this.tickets=null,o[0]?await this.openDetail(o[0].id):(this.view="list",await this.loadTickets())}catch(i){this.errorMsg="Could not submit your ticket. Please try again.",console.error("[lowhigh-support] ticket create failed:",i)}finally{this.submitting=!1,this.scheduleRender()}}async submitReply(){let e=this.config,t=this.detail;if(!(e!=null&&e.accessToken)||!e.userId||!t||this.submitting)return;let r=this.draft.reply.trim();if(r){this.submitting=!0,this.errorMsg=null,this.scheduleRender();try{await h(e,"ticket_comments",{method:"POST",body:JSON.stringify({ticket_id:t.id,user_id:e.userId,body:r,is_internal:!1,is_system:!1})});try{await h(e,`support_tickets?id=eq.${t.id}`,{method:"PATCH",body:JSON.stringify({updated_at:new Date().toISOString()})})}catch(i){console.warn("[lowhigh-support] updated_at bump failed:",i)}this.draft.reply="",this.tickets=null,await this.openDetail(t.id)}catch(i){this.errorMsg="Could not send your reply. Please try again.",console.error("[lowhigh-support] reply failed:",i),this.submitting=!1,this.scheduleRender();return}this.submitting=!1,this.scheduleRender()}}render(){var i,o;if(!this.isOpen){this.root.innerHTML="";return}let e=!!((i=this.config)!=null&&i.accessToken&&((o=this.config)!=null&&o.userId)),t={list:"Support tickets",new:"New ticket",detail:"Ticket"},r=this.view!=="list";this.root.innerHTML=`
            <style>${J}</style>
            <div class="backdrop" part="backdrop"></div>
            <div class="sheet" role="dialog" aria-modal="true" aria-label="${t[this.view]}">
                <div class="head">
                    ${r?`<button type="button" data-act="back" aria-label="Back">${Q}</button>`:""}
                    <div class="head-title">${t[this.view]}</div>
                    <button type="button" data-act="close" aria-label="Close support">${z}</button>
                </div>
                <div class="body">
                    ${this.errorMsg?`<div class="error-note" role="alert">${a(this.errorMsg)}</div>`:""}
                    ${e?this.renderView():this.renderSignedOut()}
                </div>
            </div>
        `,this.bind(e)}renderSignedOut(){return'<div class="empty">Sign in to view and submit support tickets. Your tickets follow your LowHigh account across every app.</div>'}renderView(){return this.loading?'<div class="center"><div class="spinner"></div></div>':this.view==="new"?this.renderNew():this.view==="detail"?this.renderDetail():this.renderList()}renderList(){var r;let e=(r=this.tickets)!=null?r:[];return`
            <button type="button" class="primary-btn" data-act="new">New ticket</button>
            ${e.length?e.map(i=>{var d,l,c,m,f;let o=(c=(l=(d=i.ticket_comments)==null?void 0:d[0])==null?void 0:l.count)!=null?c:0;return`
                        <button type="button" class="ticket" data-ticket="${a(i.id)}">
                            <span class="ticket-top">
                                <span class="ticket-title">${a(i.title)}</span>
                                <span class="status ${a(i.status)}">${(m=_[i.status])!=null?m:a(i.status)}</span>
                            </span>
                            <span class="ticket-meta">
                                <span>${(f=y[i.type])!=null?f:a(i.type)}</span>
                                <span>${v(i.updated_at)}</span>
                                ${o?`<span>${o} ${o===1?"reply":"replies"}</span>`:""}
                            </span>
                        </button>`}).join(""):'<div class="empty">No tickets yet. If something is not working or you have a question, we are here to help.</div>'}
        `}renderNew(){return`
            <div class="field">
                <label for="t-type">What is this about?</label>
                <select id="t-type">${Object.keys(y).map(t=>`<option value="${t}" ${this.draft.type===t?"selected":""}>${y[t]}</option>`).join("")}</select>
            </div>
            <div class="field">
                <label for="t-title">Title</label>
                <input id="t-title" type="text" maxlength="140" value="${a(this.draft.title)}"
                    placeholder="A short summary" />
            </div>
            <div class="field">
                <label for="t-body">Description</label>
                <textarea id="t-body" maxlength="5000"
                    placeholder="What happened? What did you expect?">${a(this.draft.body)}</textarea>
            </div>
            ${this.renderAttachment()}
            <button type="button" class="primary-btn" data-act="submit" ${this.submitting?"disabled":""}>
                ${this.submitting?"Submitting":"Submit ticket"}
            </button>
        `}renderAttachment(){let e=this._pendingAttachment;return!e||this.attachmentRemoved?"":`
            <div class="attach" role="group" aria-label="Attached screenshot">
                <img class="attach-thumb" src="${a(e.previewUrl)}" alt="Screenshot of your screen" />
                <div class="attach-info">
                    <div class="attach-name">${a(e.name)}</div>
                    <div class="attach-note">Attached to help us troubleshoot</div>
                </div>
                <button type="button" class="attach-remove" data-act="remove-attachment" aria-label="Remove screenshot">${z}</button>
            </div>
        `}renderDetail(){var o,d;let e=this.detail;if(!e)return'<div class="empty">This ticket could not be loaded.</div>';let t=R.includes(e.status),r=this.comments.map(l=>{if(l.is_system)return`<div class="msg system">${a(l.body)}</div>`;let c=l.is_admin_reply;return`
                    <div class="msg ${c?"team":"mine"}">
                        <div class="msg-who">${c?"LowHigh team":"You"} \xB7 ${v(l.created_at)}</div>
                        ${a(l.body)}
                    </div>`}).join(""),i=t?`<div class="closed-note">This ticket is ${_[e.status].toLowerCase()}. If you need more help, open a new ticket.</div>`:`
                <div class="reply">
                    <textarea id="t-reply" maxlength="5000" placeholder="Write a reply">${a(this.draft.reply)}</textarea>
                    <button type="button" class="primary-btn" data-act="reply" ${this.submitting?"disabled":""}>
                        ${this.submitting?"Sending":"Send reply"}
                    </button>
                </div>`;return`
            <div class="detail-title">${a(e.title)}</div>
            <div class="detail-meta">
                <span class="status ${a(e.status)}">${(o=_[e.status])!=null?o:a(e.status)}</span>
                <span>${(d=y[e.type])!=null?d:a(e.type)}</span>
                <span>${v(e.created_at)}</span>
            </div>
            <div class="msg mine">
                <div class="msg-who">You \xB7 ${v(e.created_at)}</div>
                ${a(e.body)}
            </div>
            ${r}
            ${i}
        `}bind(e){var t,r,i,o,d,l,c,m,f,C,E;(t=this.qs(".backdrop"))==null||t.addEventListener("click",()=>this.close()),(r=this.qs('[data-act="close"]'))==null||r.addEventListener("click",()=>this.close()),(i=this.qs('[data-act="back"]'))==null||i.addEventListener("click",()=>{this.view="list",this.errorMsg=null,this.tickets||this.loadTickets(),this.scheduleRender()}),e&&((o=this.qs('[data-act="new"]'))==null||o.addEventListener("click",()=>{this.view="new",this.errorMsg=null,this.scheduleRender()}),this.qsa("[data-ticket]").forEach(p=>p.addEventListener("click",()=>void this.openDetail(p.dataset.ticket))),(d=this.qs("#t-type"))==null||d.addEventListener("change",p=>{this.draft.type=p.target.value}),(l=this.qs("#t-title"))==null||l.addEventListener("input",p=>{this.draft.title=p.target.value}),(c=this.qs("#t-body"))==null||c.addEventListener("input",p=>{this.draft.body=p.target.value}),(m=this.qs("#t-reply"))==null||m.addEventListener("input",p=>{this.draft.reply=p.target.value}),(f=this.qs('[data-act="remove-attachment"]'))==null||f.addEventListener("click",()=>{this.attachmentRemoved=!0,this.scheduleRender()}),(C=this.qs('[data-act="submit"]'))==null||C.addEventListener("click",()=>void this.submitTicket()),(E=this.qs('[data-act="reply"]'))==null||E.addEventListener("click",()=>void this.submitReply()))}};customElements.get("lowhigh-launcher")||customElements.define("lowhigh-launcher",x);customElements.get("lowhigh-support")||customElements.define("lowhigh-support",w);return q(V);})();
