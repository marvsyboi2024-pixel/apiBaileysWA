content = open('dashboard.html', encoding='utf-8').read()
changes = []

def rep(old, new, label, n=1):
    global content
    c = content.count(old)
    if c == 0:
        print(f"[SKIP] not found: {label}")
        return
    if c > n:
        print(f"[WARN] '{label}' appears {c}x, only replacing {n}")
    content = content.replace(old, new, n)
    changes.append(label)

rep(
    ".coming-soon{",
    ".anti-block{grid-column:1 / -1;background:var(--surface-raised);border:1px solid var(--line);border-radius:8px;overflow:hidden}\n"
    ".anti-sub{display:none;padding:10px 11px;border-top:1px solid var(--line);gap:8px}\n"
    ".anti-sub.open{display:flex}\n"
    ".anti-sub select{margin:0;flex:1;padding:7px 9px;font-size:12px}\n"
    ".chip{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;background:var(--surface-raised);border:1px solid var(--line);border-radius:999px;font-size:12px;font-family:var(--font-mono);margin:3px 4px 0 0}\n"
    ".chip button{background:none;border:none;color:var(--ink-faint);cursor:pointer;font-size:13px;padding:0}\n"
    ".coming-soon{",
    "CSS for anti-toggle sub-dropdowns and blacklist chips"
)

rep(
    """        <div class="coming-soon" style="margin-top:14px">Welcome / Goodbye / Birthday message text and images aren't wired to the bot yet — coming in the next update.</div>
        <label>Welcome message</label><input type="text" disabled placeholder="Not wired yet">
        <label>Goodbye message</label><input type="text" disabled placeholder="Not wired yet">
        <label>Birthday message</label><input type="text" disabled placeholder="Not wired yet">""",
    """        <div class="logo-row">
            <label style="margin:0;flex:0 0 auto">Birthday logo</label>
            <input type="file" id="birthdayLogoFile" accept="image/*">
            <button class="btn btn-sm" id="birthdayLogoBtn">Upload</button>
        </div>
        <label style="margin-top:14px">Birthday message (blank = random quote)</label>
        <input type="text" id="birthdayMsgInput" maxlength="300" placeholder="Happy birthday{name}.">""",
    "Settings: real birthday message + image upload"
)

rep(
    """<div class="drawer-item locked" data-page="developer">""",
    """<div class="drawer-item locked" data-page="protection"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 3 L20 7 V12 C20 17 16.5 20 12 21 C7.5 20 4 17 4 12 V7 Z"/><path d="M9 12 L11 14 L15 10"/></svg>Protection</div>
        <div class="drawer-item locked" data-page="developer">""",
    "drawer: add Protection item"
)

rep(
    """<div class="page" id="page-developer">""",
    """<div class="page" id="page-protection">
    <div class="page-title">Protection</div>
    <div class="panel">
        <label>Group</label>
        <select id="groupPick"><option value="">Loading groups...</option></select>
        <div id="groupBody" style="display:none">
            <div class="toggle-grid" id="antiToggles" style="margin-top:6px"></div>
            <label style="margin-top:14px">Slowmode (seconds)</label>
            <input type="number" id="slowmodeInput" min="0" value="0">
            <label>Badword blacklist</label>
            <div id="blacklistChips"></div>
            <div style="display:flex;gap:8px;margin-top:8px">
                <input type="text" id="blacklistAdd" placeholder="Add a word" style="margin:0">
                <button class="btn btn-sm" id="blacklistAddBtn">Add</button>
            </div>
            <div class="subhead" style="margin-top:18px">Welcome / Goodbye (this group)</div>
            <div class="toggle-grid">
                <div class="toggle">Welcome<span class="switch"><input type="checkbox" id="welcomeToggle"><span class="track"></span><span class="knob"></span></span></div>
                <div class="toggle">Goodbye<span class="switch"><input type="checkbox" id="goodbyeToggle"><span class="track"></span><span class="knob"></span></span></div>
            </div>
            <label style="margin-top:12px">Welcome message</label>
            <input type="text" id="welcomeMsgInput" maxlength="500" placeholder="Welcome @user to the realm.">
            <label>Goodbye message</label>
            <input type="text" id="goodbyeMsgInput" maxlength="500" placeholder="@user has left the realm.">
            <button class="btn" id="saveWelcomeMsgBtn" style="margin-top:4px">Save messages</button>
        </div>
    </div>
</div>

<div class="page" id="page-developer">""",
    "new Protection page markup"
)

rep(
    "const LOGIN_GATED=['settings'];",
    "const LOGIN_GATED=['settings','protection'];",
    "gate Protection behind login"
)
rep(
    "    if(name==='settings')loadSettings();",
    "    if(name==='settings')loadSettings();\n    if(name==='protection')loadProtection();",
    "gotoPage: call loadProtection"
)

rep(
    "    document.getElementById('modeSelect').value=cfg.mode||'public';",
    "    document.getElementById('modeSelect').value=cfg.mode||'public';\n    document.getElementById('birthdayMsgInput').value=cfg.birthdayMsg||'';",
    "loadSettings: birthday message"
)
rep(
    "wireUpload('aliveLogoFile','aliveLogoBtn','alive','Alive logo');",
    "wireUpload('aliveLogoFile','aliveLogoBtn','alive','Alive logo');\nwireUpload('birthdayLogoFile','birthdayLogoBtn','birthday','Birthday logo');\n"
    "document.getElementById('birthdayMsgInput').addEventListener('change',async(e)=>{\n"
    "    const rr=await api('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:'birthdayMsg',value:e.target.value})});\n"
    "    toast(rr.ok?'Birthday message saved.':(rr.data.error||'Failed.'));\n"
    "});",
    "birthday image upload + message save"
)

protection_js = """
/* ===== protection (per group) ===== */
const ANTI=[['antilink','Antilink'],['antispam','Antispam'],['antibot','Antibot'],['antimedia','Antimedia'],['antitag','Antitag'],['antiforward','Antiforward'],['antidelete','Antidelete'],['antibadword','Antibadword']];
function limitOptions(){let o='';for(let i=1;i<=10;i++)o+=`<option value="${i}">${i}</option>`;return o+'<option value="none">No Limit</option>'}
let currentGroup='',currentBlacklist=[];
async function gsPost(key,value){
    const r=await api('/api/group-settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({group:currentGroup,key,value})});
    toast(r.ok?'Saved.':(r.data.error||'Failed.'));
    return r;
}
async function loadProtection(){
    const sel=document.getElementById('groupPick');
    const r=await api('/api/group-settings');
    if(!r.ok){sel.innerHTML='<option value="">'+(r.data.error||'Could not load groups')+'</option>';return}
    sel.innerHTML='<option value="">Select a group</option>'+r.data.groups.map(g=>`<option value="${g.id}">${String(g.name).replace(/</g,'&lt;')}</option>`).join('');
}
document.getElementById('groupPick').addEventListener('change',async(e)=>{
    currentGroup=e.target.value;
    const body=document.getElementById('groupBody');
    if(!currentGroup){body.style.display='none';return}
    const r=await api('/api/group-settings?group='+encodeURIComponent(currentGroup));
    if(!r.ok){toast(r.data.error||'Failed.');return}
    const gs=r.data.settings||{}, ws=r.data.welcome||{};
    body.style.display='block';
    document.getElementById('antiToggles').innerHTML=ANTI.map(([k,l])=>{
        const on=!!gs[k];
        return `<div class="anti-block"><div class="toggle" style="border:none;border-radius:0">${l}<span class="switch"><input type="checkbox" data-anti="${k}" ${on?'checked':''}><span class="track"></span><span class="knob"></span></span></div>
            <div class="anti-sub ${on?'open':''}" id="sub-${k}">
                <select data-action="${k}"><option value="warn">Warn</option><option value="kick">Kick</option></select>
                <select data-limit="${k}">${limitOptions()}</select>
            </div></div>`;
    }).join('');
    ANTI.forEach(([k])=>{
        document.querySelector(`[data-action="${k}"]`).value=gs[k+'Action']||'warn';
        document.querySelector(`[data-limit="${k}"]`).value=String(gs[k+'Limit']||3);
    });
    document.querySelectorAll('[data-anti]').forEach(cb=>cb.addEventListener('change',()=>{
        document.getElementById('sub-'+cb.dataset.anti).classList.toggle('open',cb.checked);
        gsPost(cb.dataset.anti,cb.checked);
    }));
    document.querySelectorAll('[data-action]').forEach(s=>s.addEventListener('change',()=>gsPost(s.dataset.action+'Action',s.value)));
    document.querySelectorAll('[data-limit]').forEach(s=>s.addEventListener('change',()=>gsPost(s.dataset.limit+'Limit',s.value)));
    document.getElementById('slowmodeInput').value=gs.slowmode||0;
    currentBlacklist=Array.isArray(gs.blacklist)?gs.blacklist.slice():[];
    renderBlacklist();
    document.getElementById('welcomeToggle').checked=!!ws.welcome;
    document.getElementById('goodbyeToggle').checked=!!ws.goodbye;
    document.getElementById('welcomeMsgInput').value=ws.welcomeMsg||'';
    document.getElementById('goodbyeMsgInput').value=ws.goodbyeMsg||'';
});
document.getElementById('slowmodeInput').addEventListener('change',e=>gsPost('slowmode',e.target.value));
function renderBlacklist(){
    document.getElementById('blacklistChips').innerHTML=currentBlacklist.map((w,i)=>`<span class="chip">${String(w).replace(/</g,'&lt;')}<button data-rmw="${i}">×</button></span>`).join('');
    document.querySelectorAll('[data-rmw]').forEach(b=>b.addEventListener('click',()=>{
        currentBlacklist.splice(+b.dataset.rmw,1);renderBlacklist();gsPost('blacklist',currentBlacklist);
    }));
}
document.getElementById('blacklistAddBtn').addEventListener('click',()=>{
    const v=document.getElementById('blacklistAdd').value.trim();
    if(!v)return;
    currentBlacklist.push(v);document.getElementById('blacklistAdd').value='';
    renderBlacklist();gsPost('blacklist',currentBlacklist);
});
document.getElementById('welcomeToggle').addEventListener('change',e=>gsPost('welcome',e.target.checked));
document.getElementById('goodbyeToggle').addEventListener('change',e=>gsPost('goodbye',e.target.checked));
document.getElementById('saveWelcomeMsgBtn').addEventListener('click',async()=>{
    await gsPost('welcomeMsg',document.getElementById('welcomeMsgInput').value);
    await gsPost('goodbyeMsg',document.getElementById('goodbyeMsgInput').value);
});
"""
rep(
    "setInterval(()=>{if(document.getElementById('page-home')",
    protection_js + "\nsetInterval(()=>{if(document.getElementById('page-home')",
    "Protection page JS"
)

open('dashboard.html', 'w', encoding='utf-8').write(content)
print("\nApplied:", len(changes))
for c in changes: print(" -", c)
