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

# 1. CSS
rep(
    ".coming-soon{",
    ".gtabs{display:flex;gap:6px;margin:14px 0 4px}\n"
    ".gtab{flex:1;padding:9px 0;border:1px solid var(--line);background:var(--surface-raised);color:var(--ink-dim);border-radius:8px;font-size:12.5px;font-weight:600;cursor:pointer}\n"
    ".gtab.active{background:var(--crimson-dim);color:var(--ink);border-color:var(--crimson)}\n"
    ".gpanel{display:none;padding-top:6px}\n"
    ".gpanel.active{display:block}\n"
    ".ginfo{border:1px solid var(--line);border-radius:8px;padding:11px 13px;background:var(--surface-raised);font-size:12.5px;line-height:1.7;margin-bottom:6px}\n"
    ".ginfo b{font-family:var(--font-display);font-size:15px;font-weight:400}\n"
    ".cmd-row{display:flex;gap:8px;margin-bottom:10px}\n"
    ".cmd-row input{margin:0;flex:1}\n"
    ".cmd-row .btn{width:auto;flex:0 0 auto}\n"
    ".member-row{display:flex;align-items:center;gap:8px;padding:9px 0;border-bottom:1px solid var(--line);font-size:12.5px;flex-wrap:wrap}\n"
    ".member-row:last-child{border-bottom:none}\n"
    ".member-row .mnum{font-family:var(--font-mono);flex:1;min-width:130px}\n"
    ".member-row .mtag{font-size:10px;padding:2px 7px;border-radius:999px;border:1px solid var(--gold-dim);color:var(--gold)}\n"
    ".btn-xs{padding:5px 10px;font-size:11.5px;width:auto}\n"
    ".link-out{font-family:var(--font-mono);font-size:12px;word-break:break-all;color:var(--gold);margin:6px 0 10px}\n"
    ".coming-soon{",
    "CSS for group tabs, command rows and member list"
)

# 2. Markup: tabs + Commands panel; the existing anti controls move into a Protection panel
rep(
    """        <div id="groupBody" style="display:none">
            <div class="toggle-grid" id="antiToggles" style="margin-top:6px"></div>""",
    """        <div id="groupBody" style="display:none">
            <div class="gtabs">
                <button class="gtab active" data-gtab="commands">Commands</button>
                <button class="gtab" data-gtab="anti">Protection</button>
                <button class="gtab" data-gtab="welcome">Welcome</button>
            </div>
            <div class="gpanel active" id="gpanel-commands">
                <div class="ginfo" id="groupInfoCard">Loading group...</div>
                <div class="btn-row">
                    <button class="btn btn-sm" id="gaMute">Mute group</button>
                    <button class="btn btn-sm" id="gaLink">Get link</button>
                    <button class="btn btn-sm" id="gaRevoke">Reset link</button>
                </div>
                <div id="gaLinkOut"></div>
                <div class="subhead">Tag members</div>
                <input type="text" id="gaTagText" maxlength="300" placeholder="Message (optional)">
                <div class="btn-row" style="margin-top:0">
                    <button class="btn btn-sm" id="gaTagAll">Tag all</button>
                    <button class="btn btn-sm" id="gaHideTag">Hidetag</button>
                    <button class="btn btn-sm" id="gaTagAdmins">Tag admins</button>
                </div>
                <div class="subhead">Group details</div>
                <div class="cmd-row"><input type="text" id="gaName" maxlength="100" placeholder="New group name"><button class="btn btn-sm" id="gaRenameBtn">Rename</button></div>
                <div class="cmd-row"><input type="text" id="gaDesc" maxlength="2000" placeholder="New description"><button class="btn btn-sm" id="gaDescBtn">Save</button></div>
                <div class="subhead">Add a member</div>
                <div class="cmd-row"><input type="tel" id="gaAddNum" placeholder="Number with country code"><button class="btn btn-sm" id="gaAddBtn">Add</button></div>
                <div class="subhead" id="gaMembersTitle">Members</div>
                <div id="gaMembers"></div>
                <div class="subhead">Danger zone</div>
                <button class="btn danger" id="gaLeave">Leave group</button>
            </div>
            <div class="gpanel" id="gpanel-anti">
            <div class="toggle-grid" id="antiToggles" style="margin-top:6px"></div>
            <div style="font-size:11px;color:var(--ink-faint);margin-top:8px">Antibot catches bots that use the older Baileys message signature. Antidelete reposts deleted messages and has no warn or kick.</div>""",
    "group panel: tabs and the Commands panel"
)
rep(
    """            <div class="subhead" style="margin-top:18px">Welcome / Goodbye (this group)</div>""",
    """            </div>
            <div class="gpanel" id="gpanel-welcome">
            <div class="subhead" style="margin-top:6px">Welcome / Goodbye for this group. Overrides the all-groups toggle in Settings.</div>""",
    "group panel: Welcome tab"
)
rep(
    """            <button class="btn" id="saveWelcomeMsgBtn" style="margin-top:4px">Save messages</button>
        </div>""",
    """            <button class="btn" id="saveWelcomeMsgBtn" style="margin-top:4px">Save messages</button>
            </div>
        </div>""",
    "group panel: close Welcome tab"
)

# 3. Naming
rep("</svg>Protection</div>", "</svg>Groups</div>", "drawer label: Protection -> Groups")
rep('<div class="page-title">Protection</div>', '<div class="page-title">Groups</div>', "page title: Protection -> Groups")
rep("['eventsWelcome','Welcome messages'],['eventsGoodbye','Goodbye messages']",
    "['eventsWelcome','Welcome (all groups)'],['eventsGoodbye','Goodbye (all groups)']",
    "Settings labels: make clear these are the all-groups defaults")

# 4. Antidelete is a notifier: no Action/Limit dropdowns for it; guard the value-setting loop
rep(
    """        return `<div class="anti-block"><div class="toggle" style="border:none;border-radius:0">${l}<span class="switch"><input type="checkbox" data-anti="${k}" ${on?'checked':''}><span class="track"></span><span class="knob"></span></span></div>
            <div class="anti-sub ${on?'open':''}" id="sub-${k}">
                <select data-action="${k}"><option value="warn">Warn</option><option value="kick">Kick</option></select>
                <select data-limit="${k}">${limitOptions()}</select>
            </div></div>`;""",
    """        const sub=k==='antidelete'
            ?`<div class="anti-sub ${on?'open':''}" id="sub-${k}"><span style="font-size:12px;color:var(--ink-faint)">Reposts deleted messages. No warn or kick.</span></div>`
            :`<div class="anti-sub ${on?'open':''}" id="sub-${k}">
                <select data-action="${k}"><option value="warn">Warn</option><option value="kick">Kick</option></select>
                <select data-limit="${k}">${limitOptions()}</select>
            </div>`;
        return `<div class="anti-block"><div class="toggle" style="border:none;border-radius:0">${l}<span class="switch"><input type="checkbox" data-anti="${k}" ${on?'checked':''}><span class="track"></span><span class="knob"></span></span></div>${sub}</div>`;""",
    "antidelete: toggle only, no fake Action/Limit controls"
)
rep(
    """    ANTI.forEach(([k])=>{
        document.querySelector(`[data-action="${k}"]`).value=gs[k+'Action']||'warn';
        document.querySelector(`[data-limit="${k}"]`).value=String(gs[k+'Limit']||3);
    });""",
    """    ANTI.forEach(([k])=>{
        const a=document.querySelector(`[data-action="${k}"]`),l=document.querySelector(`[data-limit="${k}"]`);
        if(a)a.value=gs[k+'Action']||'warn';
        if(l)l.value=String(gs[k+'Limit']||3);
    });""",
    "guard the Action/Limit value loop"
)

# 5. Load the group's info/commands when a group is picked
rep(
    """    body.style.display='block';
    document.getElementById('antiToggles').innerHTML=""",
    """    body.style.display='block';
    showGTab('commands');
    loadGroupInfo();
    document.getElementById('antiToggles').innerHTML=""",
    "group picker: open on Commands tab and load live group info"
)

# 6. Group command JS
group_js = r"""/* ===== group commands (per group) ===== */
const escHtml=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let groupMeta=null;
function showGTab(name){
    document.querySelectorAll('.gtab').forEach(x=>x.classList.toggle('active',x.dataset.gtab===name));
    document.querySelectorAll('.gpanel').forEach(x=>x.classList.toggle('active',x.id==='gpanel-'+name));
}
document.querySelectorAll('[data-gtab]').forEach(b=>b.addEventListener('click',()=>showGTab(b.dataset.gtab)));
async function gaPost(action,extra){
    const r=await api('/api/group-action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({group:currentGroup,action},extra||{}))});
    toast(r.ok?(r.data.message||'Done.'):(r.data.error||'Failed.'));
    return r;
}
async function loadGroupInfo(){
    const card=document.getElementById('groupInfoCard');
    card.textContent='Loading group...';
    document.getElementById('gaLinkOut').innerHTML='';
    const r=await api('/api/group-info?group='+encodeURIComponent(currentGroup));
    if(!r.ok){card.textContent=r.data.error||'Could not load this group.';return}
    groupMeta=r.data;
    const admins=groupMeta.members.filter(m=>m.admin).length;
    card.innerHTML='<b>'+escHtml(groupMeta.name)+'</b><br>'+groupMeta.members.length+' members · '+admins+' admins · '+(groupMeta.muted?'muted (admins only)':'open to everyone')
        +(groupMeta.desc?'<br><span style="color:var(--ink-faint)">'+escHtml(groupMeta.desc.slice(0,160))+'</span>':'');
    document.getElementById('gaMute').textContent=groupMeta.muted?'Unmute group':'Mute group';
    document.getElementById('gaMembersTitle').textContent='Members ('+groupMeta.members.length+')';
    document.getElementById('gaMembers').innerHTML=groupMeta.members.map((m,i)=>{
        const label=m.number?('+'+m.number):('Hidden number ····'+String(m.id).split('@')[0].slice(-4));
        const tag=m.me?'<span class="mtag">you</span>':(m.admin?'<span class="mtag">admin</span>':'');
        const acts=m.me?'':(m.admin
            ?'<button class="btn btn-xs" data-ma="demote" data-mi="'+i+'">Demote</button>'
            :'<button class="btn btn-xs" data-ma="promote" data-mi="'+i+'">Promote</button><button class="btn btn-xs danger" data-ma="kick" data-mi="'+i+'">Kick</button>');
        return '<div class="member-row"><span class="mnum">'+escHtml(label)+'</span>'+tag+acts+'</div>';
    }).join('');
    document.querySelectorAll('[data-ma]').forEach(b=>b.addEventListener('click',async()=>{
        const m=groupMeta.members[+b.dataset.mi];
        if(b.dataset.ma==='kick'&&!confirm('Remove this member from the group?'))return;
        const rr=await gaPost(b.dataset.ma,{targets:[m.id]});
        if(rr.ok)loadGroupInfo();
    }));
}
document.getElementById('gaMute').addEventListener('click',async()=>{
    const r=await gaPost(groupMeta&&groupMeta.muted?'unmute':'mute');
    if(r.ok)loadGroupInfo();
});
async function showLink(action){
    const r=await gaPost(action);
    if(r.ok&&r.data.link){
        document.getElementById('gaLinkOut').innerHTML='<div class="link-out">'+escHtml(r.data.link)+'</div><button class="btn btn-xs" id="gaCopyLink">Copy link</button>';
        document.getElementById('gaCopyLink').addEventListener('click',()=>{navigator.clipboard?.writeText(r.data.link).catch(()=>{});toast('Link copied.')});
    }
}
document.getElementById('gaLink').addEventListener('click',()=>showLink('link'));
document.getElementById('gaRevoke').addEventListener('click',()=>{if(confirm('Reset the invite link? The old one stops working.'))showLink('revoke')});
[['gaTagAll','tagall'],['gaHideTag','hidetag'],['gaTagAdmins','tagadmins']].forEach(([id,action])=>{
    document.getElementById(id).addEventListener('click',()=>gaPost(action,{text:document.getElementById('gaTagText').value}));
});
document.getElementById('gaRenameBtn').addEventListener('click',async()=>{
    const name=document.getElementById('gaName').value;
    const r=await gaPost('setname',{text:name});
    if(r.ok){
        document.getElementById('gaName').value='';
        const o=document.querySelector('#groupPick option:checked');if(o)o.textContent=name.trim();
        loadGroupInfo();
    }
});
document.getElementById('gaDescBtn').addEventListener('click',async()=>{
    const r=await gaPost('setdesc',{text:document.getElementById('gaDesc').value});
    if(r.ok){document.getElementById('gaDesc').value='';loadGroupInfo()}
});
document.getElementById('gaAddBtn').addEventListener('click',async()=>{
    const r=await gaPost('add',{number:document.getElementById('gaAddNum').value});
    if(r.ok){document.getElementById('gaAddNum').value='';loadGroupInfo()}
});
document.getElementById('gaLeave').addEventListener('click',async()=>{
    if(!confirm('Make this number leave the group? This cannot be undone from here.'))return;
    const r=await gaPost('leave',{confirm:true});
    if(r.ok){document.getElementById('groupBody').style.display='none';currentGroup='';loadProtection()}
});
"""
rep(
    "document.getElementById('slowmodeInput').addEventListener(",
    group_js + "document.getElementById('slowmodeInput').addEventListener(",
    "group command JS: info card, mute, link, tags, rename, description, add, members, leave"
)

open('dashboard.html', 'w', encoding='utf-8').write(content)
print("\nApplied:", len(changes))
for c in changes: print(" -", c)
