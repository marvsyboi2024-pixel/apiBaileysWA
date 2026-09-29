
(function(){
var cv=document.getElementById('c');
var ctx=cv.getContext('2d');
var W=cv.width,H=cv.height;
var HORIZON=55;
var PLAYER_Y=H-60;
var scoreEl=document.getElementById('score');
var bestEl=document.getElementById('best');
var speedEl=document.getElementById('speed');
var overlay=document.getElementById('overlay');
var ovTitle=document.getElementById('ovTitle');
var overlayMsg=document.getElementById('overlayMsg');
var score,best,speed,dead,started;
var lane,laneTarget,laneOffsetX;
var jumping,jumpY,jumpV;
var rolling,rollTimer;
var obstacles,coins,clouds,trackOffset;
var spawnTimer,coinTimer;
var copZ,copBob,copLane;
var lastTime,raf;
best=parseInt(localStorage.getItem('subway_best')||'0',10);
bestEl.textContent=pad(best);
function pad(n){n=String(n);while(n.length<4)n='0'+n;return n;}
function reset(){
score=0;speed=0.28;dead=false;started=false;
lane=1;laneTarget=1;laneOffsetX=1;
jumping=false;jumpY=0;jumpV=0;rolling=false;rollTimer=0;
obstacles=[];coins=[];clouds=[];
for(var i=0;i<5;i++)clouds.push({x:Math.random()*W,y:10+Math.random()*30,s:0.5+Math.random()*0.5});
trackOffset=0;spawnTimer=0;coinTimer=0;
copZ=0.85;copBob=0;copLane=1;
scoreEl.textContent=pad(0);speedEl.textContent='1';
overlay.style.display='none';
lastTime=performance.now();
cancelAnimationFrame(raf);
raf=requestAnimationFrame(tick);
}
function project(z,laneOffset,worldY){
if(z<0)z=0;if(z>1)z=1;
var persp=1-z;
var scale=0.15+persp*0.85;
var y=HORIZON+(PLAYER_Y-HORIZON)*(1-scale*0.35)-(worldY||0)*scale;
var x=W/2+laneOffset*W*0.32*scale;
return {x:x,y:y,scale:scale};
}
function spawnObstacle(){
var l=Math.floor(Math.random()*3);
var roll=Math.random();
var type=roll<0.4?'barrier':roll<0.75?'train':'lowbar';
obstacles.push({lane:l,z:1,type:type});
}
function spawnCoins(){
var l=Math.floor(Math.random()*3);
var n=2+Math.floor(Math.random()*2);
for(var i=0;i<n;i++)coins.push({lane:l,z:1+i*0.04});
}
<body>
<div class="app">
<div class="header">
<div class="title">🚇 Subway Surf</div>
<div class="best">🏆 BEST <span id="best">0000</span></div>
</div>
<div class="divider"></div>
<div class="card">
<div class="scorebar">
<span>Score <span id="score">0000</span></span>
<span>Speed <span id="speed">1</span></span>
</div>
<div class="playfield">
<canvas id="c" width="336" height="240"></canvas>
<div class="overlay" id="overlay">
<h2 id="ovTitle">Game Over</h2>
<p id="overlayMsg">Your score: 0000.</p>
<div class="sect"><button id="restart">Play Again</button></div>
</div>
</div>
</div>
<div class="dpad">
<button class="up" data-dir="up">▲</button>
<button class="left" data-dir="left">◀</button>
<button class="right" data-dir="right">▶</button>
<button class="down" data-dir="down">▼</button>
</div>
<div class="hint">Swipe or tap to dodge. Don't let the cop catch you!</div>
</div>
<script>
(function(){
var cv=document.getElementById('c');
var ctx=cv.getContext('2d');
var W=cv.width,H=cv.height;
var HORIZON=55;
var PLAYER_Y=H-60;
var scoreEl=document.getElementById('score');
var bestEl=document.getElementById('best');
var speedEl=document.getElementById('speed');
var overlay=document.getElementById('overlay');
var ovTitle=document.getElementById('ovTitle');
var overlayMsg=document.getElementById('overlayMsg');
var score,best,speed,dead,started;
var lane,laneTarget,laneOffsetX;
var jumping,jumpY,jumpV;
var rolling,rollTimer;
var obstacles,coins,clouds,trackOffset;
var spawnTimer,coinTimer;
var copZ,copBob,copLane;
var lastTime,raf;
best=parseInt(localStorage.getItem('subway_best')||'0',10);
bestEl.textContent=pad(best);
function pad(n){n=String(n);while(n.length<4)n='0'+n;return n;}
function reset(){
score=0;speed=0.28;dead=false;started=false;
lane=1;laneTarget=1;laneOffsetX=1;
jumping=false;jumpY=0;jumpV=0;rolling=false;rollTimer=0;
obstacles=[];coins=[];clouds=[];
for(var i=0;i<5;i++)clouds.push({x:Math.random()*W,y:10+Math.random()*30,s:0.5+Math.random()*0.5});
trackOffset=0;spawnTimer=0;coinTimer=0;
copZ=0.85;copBob=0;copLane=1;
scoreEl.textContent=pad(0);speedEl.textContent='1';
overlay.style.display='none';
lastTime=performance.now();
cancelAnimationFrame(raf);
raf=requestAnimationFrame(tick);
}
function project(z,laneOffset,worldY){
if(z<0)z=0;if(z>1)z=1;
var persp=1-z;
var scale=0.15+persp*0.85;
var y=HORIZON+(PLAYER_Y-HORIZON)*(1-scale*0.35)-(worldY||0)*scale;
var x=W/2+laneOffset*W*0.32*scale;
return {x:x,y:y,scale:scale};
}
function spawnObstacle(){
var l=Math.floor(Math.random()*3);
var roll=Math.random();
var type=roll<0.4?'barrier':roll<0.75?'train':'lowbar';
obstacles.push({lane:l,z:1,type:type});
}
function spawnCoins(){
var l=Math.floor(Math.random()*3);
var n=2+Math.floor(Math.random()*2);
for(var i=0;i<n;i++)coins.push({lane:l,z:1+i*0.04});
}
function tick(now){
if(dead)return;
var dt=Math.min(0.05,(now-lastTime)/1000);
lastTime=now;
if(started){
speed+=0.008*dt;if(speed>0.9)speed=0.9;
trackOffset=(trackOffset+speed*dt*4)%0.1;
}
laneOffsetX+=(lane-laneOffsetX)*Math.min(1,dt*12);
if(Math.abs(lane-laneOffsetX)<0.02)laneOffsetX=lane;
if(jumping){jumpV-=9.5*dt;jumpY+=jumpV*dt;if(jumpY<=0){jumpY=0;jumping=false;jumpV=0;}}
if(rolling){rollTimer-=dt;if(rollTimer<=0)rolling=false;}
spawnTimer+=dt;
if(spawnTimer>0.75){spawnTimer=0;if(started)spawnObstacle();}
coinTimer+=dt;
if(coinTimer>1.6){coinTimer=0;if(started)spawnCoins();}
for(var i=obstacles.length-1;i>=0;i--){
var o=obstacles[i];o.z-=speed*dt*1.4;
if(o.z<-0.08){obstacles.splice(i,1);continue;}
if(o.z<0.06&&o.z>-0.08){
var pl=Math.round(laneOffsetX);
if(o.lane===pl){
var hit=false;
if(o.type==='barrier')hit=jumpY<12;
else if(o.type==='train')hit=true;
else if(o.type==='lowbar')hit=!rolling;
if(hit){copZ-=0.15;hitEffect();if(copZ<=0)return caught();}
}
}
}
for(var j=coins.length-1;j>=0;j--){
var c=coins[j];c.z-=speed*dt*1.4;
if(c.z<-0.08){coins.splice(j,1);continue;}
if(c.z<0.06&&c.z>-0.06){
var pl2=Math.round(laneOffsetX);
if(c.lane===pl2){coins.splice(j,1);score+=10;scoreEl.textContent=pad(score);copZ=Math.min(1,copZ+0.06);}
}
}
if(started){score+=speed*dt*20;scoreEl.textContent=pad(Math.floor(score));}
if(started&&speed<0.4)copZ-=0.05*dt;
copBob+=dt*8;
for(var k=0;k<clouds.length;k++){
clouds[k].x-=speed*dt*30;
if(clouds[k].x<-30){clouds[k].x=W+20;clouds[k].y=10+Math.random()*30;}
}
if(dead)return;
var lv=Math.floor(score/200)+1;
speedEl.textContent=lv;
draw();
raf=requestAnimationFrame(tick);
}
function hitEffect(){score=Math.max(0,score-5);speed=Math.max(0.25,speed-0.1);}
function caught(){
dead=true;cancelAnimationFrame(raf);
if(score>best){best=Math.floor(score);localStorage.setItem('subway_best',best);bestEl.textContent=pad(best);}
ovTitle.textContent='Caught!';
overlayMsg.textContent='Your score: '+pad(Math.floor(score))+'.';
overlay.style.display='block';
draw();
}
function draw(){
var sky=ctx.createLinearGradient(0,0,0,HORIZON);
sky.addColorStop(0,'#8ab4e8');sky.addColorStop(1,'#c4cd9d');
ctx.fillStyle=sky;ctx.fillRect(0,0,W,HORIZON);
ctx.fillStyle='rgba(255,255,255,0.85)';
for(var c=0;c<clouds.length;c++){var cl=clouds[c];ctx.beginPath();ctx.arc(cl.x,cl.y,7*cl.s,0,Math.PI*2);ctx.arc(cl.x+7*cl.s,cl.y+2,5*cl.s,0,Math.PI*2);ctx.arc(cl.x-7*cl.s,cl.y+2,5*cl.s,0,Math.PI*2);ctx.fill();}
var gg=ctx.createLinearGradient(0,HORIZON,0,H);
gg.addColorStop(0,'#8a9468');gg.addColorStop(1,'#5a6440');
ctx.fillStyle=gg;ctx.fillRect(0,HORIZON,W,H-HORIZON);
ctx.beginPath();
ctx.moveTo(W/2-14,HORIZON);ctx.lineTo(W/2+14,HORIZON);ctx.lineTo(W-15,H);ctx.lineTo(15,H);ctx.closePath();
var rg=ctx.createLinearGradient(0,HORIZON,0,H);
rg.addColorStop(0,'#6a6a4a');rg.addColorStop(1,'#3a3a2a');
ctx.fillStyle=rg;ctx.fill();
for(var lane2=-1;lane2<=1;lane2+=2){
ctx.strokeStyle='rgba(200,200,150,0.5)';ctx.lineWidth=1.5;
var p1=project(0.02,lane2*0.5,0);var p2=project(0.98,lane2*0.5,0);
ctx.beginPath();ctx.moveTo(p1.x,p1.y);ctx.lineTo(p2.x,p2.y);ctx.stroke();
}
for(var z=-trackOffset;z<1;z+=0.1){
var zz=z<0?z+1:z;if(zz<0.02)continue;
var pl=project(zz,-1,0);var pr=project(zz,1,0);
ctx.strokeStyle='rgba(120,120,90,'+(0.15+(1-zz)*0.3)+')';
ctx.lineWidth=1+(1-zz)*2;
ctx.beginPath();ctx.moveTo(pl.x,pl.y);ctx.lineTo(pr.x,pr.y);ctx.stroke();
}
var renderables=[];
for(var i=0;i<obstacles.length;i++)renderables.push({z:obstacles[i].z,kind:'obs',data:obstacles[i]});
for(var i=0;i<coins.length;i++)renderables.push({z:coins[i].z,kind:'coin',data:coins[i]});
renderables.push({z:0,kind:'player'});
renderables.push({z:-copZ*0.12,kind:'cop'});
renderables.sort(function(a,b){return b.z-a.z;});
for(var r=0;r<renderables.length;r++){
var it=renderables[r];
if(it.kind==='obs')drawObstacle(it.data);
else if(it.kind==='coin')drawCoin(it.data);
else if(it.kind==='cop')drawCop();
else drawPlayer();
}
}
function drawObstacle(o){
if(o.z<0||o.z>1)return;
var p=project(o.z,o.lane-1,0);
if(p.scale<0.05)return;
var w=30*p.scale,h=26*p.scale;
if(o.type==='barrier'){
ctx.fillStyle='#8a3a1a';ctx.fillRect(p.x-w/2,p.y-h,w,h);
ctx.fillStyle='#ffcc00';
for(var s=0;s<3;s++)ctx.fillRect(p.x-w/2+s*(w/3),p.y-h+4*p.scale,w/6,h-6*p.scale);
ctx.fillStyle='#5a2a1a';ctx.fillRect(p.x-w/2,p.y-h,w,3*p.scale);
}else if(o.type==='train'){
var tw=34*p.scale,th=60*p.scale;
ctx.fillStyle='#3a3a5a';ctx.fillRect(p.x-tw/2,p.y-th,tw,th);
ctx.fillStyle='#5a5a7a';ctx.fillRect(p.x-tw/2,p.y-th,tw,5*p.scale);
ctx.fillStyle='#88bbff';
ctx.fillRect(p.x-tw/2+3*p.scale,p.y-th+10*p.scale,tw-6*p.scale,6*p.scale);
ctx.fillRect(p.x-tw/2+3*p.scale,p.y-th+22*p.scale,tw-6*p.scale,6*p.scale);
ctx.fillStyle='#ffcc00';ctx.fillRect(p.x-tw/2,p.y-2*p.scale,tw,2*p.scale);
}else{
ctx.fillStyle='#aa2a2a';ctx.fillRect(p.x-w/2,p.y-12*p.scale,w,8*p.scale);
ctx.fillStyle='#5a0a0a';ctx.fillRect(p.x-w/2,p.y-4*p.scale,w,4*p.scale);
ctx.fillStyle='#ff6666';ctx.fillRect(p.x-w/2,p.y-12*p.scale,w,2*p.scale);
}
}
function drawCoin(c){
if(c.z<0||c.z>1)return;
var p=project(c.z,c.lane-1,14);
if(p.scale<0.05)return;
var r=5*p.scale;
var spin=Math.sin(Date.now()/100+c.z*10);
ctx.fillStyle='#ffd700';
ctx.beginPath();ctx.ellipse(p.x,p.y,r*Math.abs(spin)*0.8+r*0.2,r,0,0,Math.PI*2);ctx.fill();
ctx.fillStyle='#ffaa00';
ctx.beginPath();ctx.ellipse(p.x,p.y,r*0.5,r*0.6,0,0,Math.PI*2);ctx.fill();
}
function drawPlayer(){
var p=project(0,laneOffsetX-1,0);
var x=p.x,baseY=PLAYER_Y;
var bodyH=rolling?16:30;
ctx.fillStyle='rgba(0,0,0,0.35)';
ctx.beginPath();ctx.ellipse(x,baseY+4,12,3,0,0,Math.PI*2);ctx.fill();
var yTop=baseY-bodyH-jumpY*1.2;
ctx.fillStyle='#2a3a5a';
if(jumping){ctx.fillRect(x-7,baseY-6,5,6);ctx.fillRect(x+2,baseY-8,5,8);}
else{var legPhase=Math.sin(Date.now()/90)*3;ctx.fillRect(x-6,baseY-8,5,8+legPhase);ctx.fillRect(x+1,baseY-8,5,8-legPhase);}
ctx.fillStyle='#d84040';ctx.fillRect(x-8,yTop,16,bodyH-8);
ctx.fillStyle='#2a1a1a';ctx.fillRect(x-6,yTop+2,3,bodyH-10);
ctx.fillStyle='#e8c8a0';ctx.beginPath();ctx.arc(x,yTop-6,7,0,Math.PI*2);ctx.fill();
ctx.fillStyle='#2a1a1a';ctx.fillRect(x-7,yTop-13,14,5);ctx.fillRect(x-7,yTop-10,4,5);
ctx.fillStyle='#d84040';
if(jumping){ctx.fillRect(x-10,yTop+2,4,8);ctx.fillRect(x+6,yTop+2,4,8);}
else{var armPhase=Math.sin(Date.now()/90)*2;ctx.fillRect(x-11,yTop+4+armPhase,4,10);ctx.fillRect(x+7,yTop+4-armPhase,4,10);}
}
function drawCop(){
var visible=copZ<0.55;
if(!visible)return;
var x=W/2+(copLane-1)*40;
var y=H+(copZ*80)-20;
var bob=Math.sin(copBob)*2;
var flash=Math.floor(Date.now()/200)%2===0;
ctx.fillStyle=flash?'rgba(255,60,60,0.6)':'rgba(60,60,255,0.6)';
ctx.beginPath();ctx.arc(x-10,y-25+bob,4,0,Math.PI*2);ctx.arc(x+10,y-25+bob,4,0,Math.PI*2);ctx.fill();
ctx.fillStyle='#1a2a5a';ctx.fillRect(x-8,y-20+bob,16,18);
ctx.fillStyle='#ffdd44';ctx.fillRect(x-2,y-14+bob,4,4);
ctx.fillStyle='#e8c8a0';ctx.beginPath();ctx.arc(x,y-26+bob,6,0,Math.PI*2);ctx.fill();
ctx.fillStyle='#0a1a3a';ctx.fillRect(x-7,y-33+bob,14,4);ctx.fillRect(x-5,y-35+bob,10,3);
ctx.fillStyle='#ffdd44';ctx.fillRect(x-2,y-32+bob,4,2);
ctx.fillStyle='#1a2a5a';
var reach=Math.sin(copBob*1.5)*2;
ctx.fillRect(x-12,y-18+bob+reach,4,8);
ctx.fillRect(x+8,y-18+bob-reach,4,8);
if(copZ<0.3){ctx.fillStyle='rgba(255,0,0,'+(0.3-copZ)*3+')';ctx.fillRect(0,0,W,H);}
}
function getPos(e){
var rect=cv.getBoundingClientRect();
var sx=cv.width/rect.width;
var sy=cv.height/rect.height;
var cx=e.touches?e.touches[0].clientX:e.clientX;
var cy=e.touches?e.touches[0].clientY:e.clientY;
return {x:(cx-rect.left)*sx,y:(cy-rect.top)*sy};
}
function doAction(dir){
if(dead){reset();return;}
if(!started)started=true;
if(dir==='up'){if(!jumping&&!rolling){jumping=true;jumpV=5.5;jumpY=0.1;}}
else if(dir==='down'){if(!jumping&&!rolling){rolling=true;rollTimer=0.55;}}
else if(dir==='left'){if(lane>0){lane--;copLane=Math.max(0,copLane-(Math.random()<0.6?1:0));}}
else if(dir==='right'){if(lane<2){lane++;copLane=Math.min(2,copLane+(Math.random()<0.6?1:0));}}
}
var buttons=document.querySelectorAll('.dpad button');
for(var b=0;b<buttons.length;b++){
(function(btn){btn.addEventListener('click',function(){doAction(btn.dataset.dir);});})(buttons[b]);
}
var touchStart=null;
cv.addEventListener('touchstart',function(e){touchStart={x:e.touches[0].clientX,y:e.touches[0].clientY};},{passive:true});
cv.addEventListener('touchend',function(e){
if(!touchStart)return;
var dx=e.changedTouches[0].clientX-touchStart.x;
var dy=e.changedTouches[0].clientY-touchStart.y;
if(Math.abs(dx)<20&&Math.abs(dy)<20)return;
if(Math.abs(dx)>Math.abs(dy))doAction(dx>0?'right':'left');
else doAction(dy>0?'down':'up');
touchStart=null;
});
document.addEventListener('keydown',function(e){
if(e.key==='ArrowUp'||e.key==='w'){e.preventDefault();doAction('up');}
else if(e.key==='ArrowDown'||e.key==='s'){e.preventDefault();doAction('down');}
else if(e.key==='ArrowLeft'||e.key==='a'){e.preventDefault();doAction('left');}
else if(e.key==='ArrowRight'||e.key==='d'){e.preventDefault();doAction('right');}
});
document.getElementById('restart').addEventListener('click',reset);
reset();
})();
