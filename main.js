/* v2h: ArUco + Square Fallback, persistent H, iOS-friendly */
let cvReady=false, video, overlay, proc, ctx, pctx, running=false, countdownEl;
let H=null, lastHTime=0, warpSize={w:900,h:1200}, detector=null, detectorParams=null, arucoDict=null;
let shotsFired=0,totalScore=0,gameShots=10,lastHitTs=0;
let soundOn=true, audioCtx=null, calibTimer=null, lossStreak=0;
let prevMask=null, markerPxWide=0;

const BULLSEYE={center:[450,600], rings:[120,220,320,420], points:[10,9,8,7,6]};

function onOpenCvReady(){
  cv['onRuntimeInitialized']=()=>{
    try{
      if (cv.aruco_Dictionary){
        arucoDict=new cv.aruco_Dictionary(cv.aruco_DICT_4X4_50);
        detectorParams=new cv.aruco_DetectorParameters();
        detectorParams.cornerRefinementMethod=cv.aruco_CORNER_REFINE_SUBPIX;
        detector=new cv.aruco_Detector(arucoDict, detectorParams);
      }
    }catch(e){ console.warn('Aruco unsupported',e); }
    cvReady=true; setTimeout(()=>document.getElementById('splash').style.display='none',200);
  };
}
function onOpenCvFail(){ document.getElementById('splash').querySelector('.tip').textContent='OpenCV failed to load. Reload?'; }

const $=q=>document.querySelector(q);
function init(){
  video=$('#video'); overlay=$('#overlay'); proc=$('#proc');
  ctx=overlay.getContext('2d'); pctx=proc.getContext('2d');
  countdownEl=$('#countdown');
  $('#settingsBtn').onclick=()=>$('#drawer').classList.add('open');
  $('#closeDrawer').onclick=()=>$('#drawer').classList.remove('open');
  $('#soundToggle').onchange=e=>soundOn=e.target.checked;
  $('#themeToggle').onchange=e=>document.body.classList.toggle('dark',e.target.checked);
  $('#resetScores').onclick=()=>{localStorage.removeItem('laser_scores'); alert('Scores reset');};
  $('#gameSelect').onchange=e=>gameShots=parseInt(e.target.value,10);
  $('#startBtn').onclick=startFlow;
  $('#calibBtn').onclick=()=>{ if(calibTimer)clearInterval(calibTimer); calibTimer=null; if(H){H.delete();H=null;} lastHTime=0; lossStreak=0; $('#status').textContent='Re‑calibrating…'; startCalibration(true); };
}
addEventListener('DOMContentLoaded',init);

async function startFlow(){
  if(!cvReady){ alert('Vision engine loading…'); return; }
  if(running) return;
  try{ audioCtx=audioCtx||new (window.AudioContext||window.webkitAudioContext)(); await audioCtx.resume(); }catch(e){}
  const hfps=$('#hfps').checked, calibHi=$('#calibHi').checked;
  try{
    const cc = calibHi ? {video:{facingMode:'environment',width:{ideal:1280},height:{ideal:720},frameRate:{ideal:30,max:60}},audio:false}
                       : {video:{facingMode:'environment',width:{ideal:hfps?640:1280},height:{ideal:hfps?480:720},frameRate:{ideal:hfps?60:30,max:60}},audio:false};
    const s=await navigator.mediaDevices.getUserMedia(cc); video.srcObject=s; await video.play();
    overlay.width=video.videoWidth; overlay.height=video.videoHeight;
  }catch(e){ alert('Camera blocked. Check site permissions/HTTPS.'); return; }
  startCalibration(true);
  await countdown(10);
  if(hfps||calibHi){
    try{
      const pc={video:{facingMode:'environment',width:{ideal:640},height:{ideal:480},frameRate:{ideal:60,max:60}},audio:false};
      const s2=await navigator.mediaDevices.getUserMedia(pc);
      video.srcObject.getTracks().forEach(t=>t.stop());
      video.srcObject=s2; await video.play();
      overlay.width=video.videoWidth; overlay.height=video.videoHeight;
    }catch(e){ console.warn('Could not switch to 60fps low-res. Continuing.'); }
  }
  shotsFired=0; totalScore=0; updateStats();
  running=true; frameLoop();
}

// ===== Calibration (Aruco OR Square-Fallback) =====
function startCalibration(){
  const status=$('#status');
  if(calibTimer) clearInterval(calibTimer);
  calibTimer=setInterval(()=>{
    pctx.drawImage(video,0,0,proc.width,proc.height);
    const src=cv.imread(proc);
    let res=detectMarkersAndHomography(src, video.videoWidth/proc.width, video.videoHeight/proc.height);
    if (!res.H && $('#sqFallback').checked){
      res = detectSquaresHomography(src, video.videoWidth/proc.width, video.videoHeight/proc.height);
      status.textContent = res.H ? 'calibrated (squares)' : `seeking (squares)`;
    } else {
      status.textContent = `markers: ${res.count}${markerPxWide? ' | ~'+Math.round(markerPxWide)+'px':''}${res.H?' | calibrated':' | seeking'}`;
    }
    src.delete();
    if(res.H){ if(H)H.delete(); H=res.H; lastHTime=performance.now(); lossStreak=0; }
  },60);
}

function hullHomography(pts){
  if (pts.length < 4) return {H:null, count:0};
  const sum=p=>p.x+p.y, dif=p=>p.x-p.y;
  const tl=pts.reduce((a,b)=> sum(a)<sum(b)?a:b);
  const br=pts.reduce((a,b)=> sum(a)>sum(b)?a:b);
  const tr=pts.reduce((a,b)=> dif(a)<dif(b)?a:b);
  const bl=pts.reduce((a,b)=> dif(a)>dif(b)?a:b);
  const srcTri = cv.matFromArray(4,1,cv.CV_32FC2,[tl.x,tl.y, tr.x,tr.y, br.x,br.y, bl.x,bl.y]);
  const dstTri = cv.matFromArray(4,1,cv.CV_32FC2,[0,0, warpSize.w,0, warpSize.w,warpSize.h, 0,warpSize.h]);
  const HH = cv.getPerspectiveTransform(srcTri, dstTri);
  srcTri.delete(); dstTri.delete();
  return {H:HH, count:4};
}

function detectMarkersAndHomography(src,sx=1,sy=1){
  let count=0; markerPxWide=0;
  if(!detector) return {H:null,count:0};
  const gray=new cv.Mat(); cv.cvtColor(src,gray,cv.COLOR_RGBA2GRAY,0);
  const corners=new cv.MatVector(), ids=new cv.Mat();
  try{
    detector.detectMarkers(gray,corners,ids);
    count=corners.size(); if(count<2) return {H:null,count};
    const pts=[]; let sumW=0,nW=0;
    for(let i=0;i<corners.size();i++){
      const m=corners.get(i);
      const x=[0,1,2,3].map(k=>m.data32F[k*2]); const y=[0,1,2,3].map(k=>m.data32F[k*2+1]);
      sumW+=Math.hypot(x[1]-x[0],y[1]-y[0]); nW++;
      for(let k=0;k<4;k++) pts.push({x:m.data32F[k*2]*sx,y:m.data32F[k*2+1]*sy});
      m.delete();
    }
    markerPxWide=nW? (sumW/nW)*sx : 0;
    return hullHomography(pts);
  }finally{ gray.delete(); corners.delete(); ids.delete(); }
}

// Fallback: detect 4 largest black-ish squares
function detectSquaresHomography(src,sx=1,sy=1){
  const gray=new cv.Mat(); cv.cvtColor(src,gray,cv.COLOR_RGBA2GRAY,0);
  const blur=new cv.Mat(); cv.GaussianBlur(gray,blur,new cv.Size(5,5),0);
  const thr=new cv.Mat(); cv.threshold(blur,thr,0,255,cv.THRESH_BINARY+cv.THRESH_OTSU);
  if(cv.mean(thr)[0]>127) cv.bitwise_not(thr,thr);
  const contours=new cv.MatVector(), hier=new cv.Mat();
  cv.findContours(thr,contours,hier,cv.RETR_LIST,cv.CHAIN_APPROX_SIMPLE);
  const cand=[];
  for(let i=0;i<contours.size();i++){
    const c=contours.get(i), area=cv.contourArea(c);
    if(area<300){ c.delete(); continue; }
    const peri=cv.arcLength(c,true);
    const approx=new cv.Mat(); cv.approxPolyDP(c,approx,0.04*peri,true);
    if(approx.rows===4 && cv.isContourConvex(approx)){
      const p=Array.from({length:4},(_,k)=>({x:approx.data32S[k*2],y:approx.data32S[k*2+1]}));
      const e1=Math.hypot(p[1].x-p[0].x,p[1].y-p[0].y), e2=Math.hypot(p[2].x-p[1].x,p[2].y-p[1].y);
      const r=e1/e2; if(r>0.6 && r<1.4) cand.push({area,p});
    }
    approx.delete(); c.delete();
  }
  cand.sort((a,b)=>b.area-a.area);
  const four=cand.slice(0,4);
  gray.delete(); blur.delete(); thr.delete(); contours.delete(); hier.delete();
  if(four.length<4) return {H:null,count:four.length};
  const pts=four.flatMap(sq=>sq.p.map(q=>({x:q.x*sx,y:q.y*sy})));
  return hullHomography(pts);
}

// ===== Main gameplay =====
function frameLoop(){
  if(!running) return;
  const rAF=video.requestVideoFrameCallback||window.requestAnimationFrame;
  rAF.call(video,()=>{
    ctx.drawImage(video,0,0,overlay.width,overlay.height);
    pctx.drawImage(video,0,0,proc.width,proc.height);
    const now=performance.now();
    if(!H || (now-lastHTime)>2000){ lossStreak++; if(lossStreak>60) $('#status').textContent='Reacquiring…'; } else lossStreak=0;
    const src=cv.imread(proc);
    const hit=detectTransientRed(src);
    src.delete();
    if(hit && H){
      const sx=overlay.width/proc.width, sy=overlay.height/proc.height;
      const vis={x:hit.x*sx,y:hit.y*sy};
      const sp=cv.matFromArray(1,1,cv.CV_32FC2,[vis.x,vis.y]), dp=cv.perspectiveTransform(sp,H);
      const a=dp.data32F, ptW={x:a[0],y:a[1]}; sp.delete(); dp.delete();
      if(now-lastHitTs>120){
        lastHitTs=now; const score=scoreBullseye(ptW);
        shotsFired++; totalScore+=score; updateStats(score);
        drawHit(vis,score); playSteel();
        if(shotsFired>=gameShots){ running=false; setTimeout(()=>alert(`Done! Total=${totalScore} Avg=${(totalScore/gameShots).toFixed(1)}`),80); }
      }
    }
    frameLoop();
  });
}

function scoreBullseye(p){ const [cx,cy]=BULLSEYE.center, r=BULLSEYE.rings, pts=BULLSEYE.points;
  const d=Math.hypot(p.x-cx,p.y-cy); for(let i=0;i<r.length;i++) if(d<=r[i]) return pts[i]; return pts[pts.length-1]; }

// Simple red flash detector with temporal diff
function detectTransientRed(src){
  const debug=$('#debugToggle')?.checked;
  const rgb=new cv.Mat(), hsv=new cv.Mat();
  cv.cvtColor(src,rgb,cv.COLOR_RGBA2RGB,0); cv.cvtColor(rgb,hsv,cv.COLOR_RGB2HSV,0);
  const m1=new cv.Mat(), m2=new cv.Mat(), maskRed=new cv.Mat();
  const lowS=110, lowV=170;
  cv.inRange(hsv,new cv.Mat(hsv.rows,hsv.cols,hsv.type(),[0,lowS,lowV,0]),new cv.Mat(hsv.rows,hsv.cols,hsv.type(),[12,255,255,0]),m1);
  cv.inRange(hsv,new cv.Mat(hsv.rows,hsv.cols,hsv.type(),[160,lowS,lowV,0]),new cv.Mat(hsv.rows,hsv.cols,hsv.type(),[179,255,255,0]),m2);
  cv.add(m1,m2,maskRed);
  const ch=new cv.MatVector(); cv.split(rgb,ch); const R=ch.get(0), G=ch.get(1);
  const diff=new cv.Mat(); cv.subtract(R,G,diff);
  const maskRG=new cv.Mat(); cv.threshold(diff,maskRG,36,255,cv.THRESH_BINARY);
  const combined=new cv.Mat(); cv.bitwise_and(maskRed,maskRG,combined);
  const k=cv.Mat.ones(3,3,cv.CV_8U); cv.morphologyEx(combined,combined,cv.MORPH_OPEN,k);
  let pt=null; const sens=parseInt($('#sens').value,10), minA=parseInt($('#minArea').value,10);
  if(prevMask){
    const pos=new cv.Mat(); cv.subtract(combined,prevMask,pos);
    let contours=new cv.MatVector(), hier=new cv.Mat(); cv.findContours(pos,contours,hier,cv.RETR_EXTERNAL,cv.CHAIN_APPROX_SIMPLE);
    let best=0; for(let i=0;i<contours.size();i++){ const c=contours.get(i), a=cv.contourArea(c);
      if(a>minA && a>sens && a>best){ const m=cv.moments(c); if(m.m00!==0) pt={x:Math.round(m.m10/m.m00),y:Math.round(m.m01/m.m00)}; best=a; } }
    if(debug){
      const vis=new cv.Mat(); cv.cvtColor(pos,vis,cv.COLOR_GRAY2RGBA,0);
      const sw=160, sh=Math.round(pos.rows*(160/pos.cols)); const ds=new cv.Size(sw,sh);
      const sm=new cv.Mat(); cv.resize(vis,sm,ds,0,0,cv.INTER_NEAREST);
      const imgData=new ImageData(new Uint8ClampedArray(sm.data),sw,sh); ctx.putImageData(imgData,8,8);
      vis.delete(); sm.delete();
    }
    pos.delete(); contours.delete(); hier.delete();
  }
  if(prevMask) prevMask.delete(); prevMask=combined.clone();
  rgb.delete(); hsv.delete(); m1.delete(); m2.delete(); maskRed.delete(); diff.delete(); maskRG.delete(); combined.delete(); k.delete(); R.delete(); G.delete(); ch.delete();
  return pt;
}

function drawHit(pt,score){
  ctx.save(); ctx.strokeStyle='#00ff73'; ctx.lineWidth=3; ctx.fillStyle='#00ff7366';
  ctx.beginPath(); ctx.arc(pt.x,pt.y,18,0,Math.PI*2); ctx.fill(); ctx.stroke();
  ctx.fillStyle='#fff'; ctx.font='bold 20px system-ui'; ctx.textAlign='center'; ctx.fillText('+'+score, pt.x, pt.y-26); ctx.restore();
}

// Sounds
function playBeep(){ if(!soundOn) return; try{ const ctx=audioCtx||new (window.AudioContext||window.webkitAudioContext)(); ctx.resume(); const o=ctx.createOscillator(), g=ctx.createGain(); o.type='sine'; o.frequency.value=880; g.gain.setValueAtTime(0,ctx.currentTime); g.gain.linearRampToValueAtTime(0.5,ctx.currentTime+0.01); g.gain.exponentialRampToValueAtTime(0.0001,ctx.currentTime+0.12); o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime+0.14); audioCtx=ctx; }catch(e){ document.getElementById('beepAudio').play().catch(()=>{}); } }
function playSteel(){ if(!soundOn) return; try{ const ctx=audioCtx||new (window.AudioContext||window.webkitAudioContext)(); ctx.resume(); const o1=ctx.createOscillator(),o2=ctx.createOscillator(),g=ctx.createGain(); o1.type='sine';o2.type='sine'; o1.frequency.value=1400;o2.frequency.value=2200; const end=ctx.currentTime+0.2; g.gain.setValueAtTime(0.7,ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.0001,end); o1.connect(g); o2.connect(g); g.connect(ctx.destination); o1.start(); o2.start(); o1.stop(end); o2.stop(end); audioCtx=ctx; }catch(e){ document.getElementById('steelAudio').play().catch(()=>{}); } }

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function countdown(n){ countdownEl.classList.remove('hidden'); for(let i=n;i>0;i--){ countdownEl.textContent=String(i); playBeep(); await sleep(1000);} countdownEl.textContent='GO!'; playBeep(); await sleep(500); countdownEl.classList.add('hidden'); }
function updateStats(last=null){ $('#lastScore').textContent= last!==null? last : '—'; $('#shotsFired').textContent=shotsFired; $('#totalScore').textContent=totalScore; $('#avgScore').textContent= shotsFired? (totalScore/shotsFired).toFixed(1):0; }
