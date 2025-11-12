const CACHE='laser-timer-pwz-bullseye-v2h';
const ASSETS=['./','./index.html','./style.css','./main.js','./manifest.json',
'./assets/audio/countdown_beep.wav','./assets/audio/steel_hit.wav',
'https://docs.opencv.org/4.x/opencv.js'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))))});
self.addEventListener('fetch',e=>{e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request).catch(()=>caches.match('./index.html'))))});
