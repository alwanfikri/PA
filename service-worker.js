const CACHE_SHELL = "lumina-shell-v1"

const SHELL_FILES = [

"./",
"./index.html",
"./style.css",
"./app.js",
"./db.js",
"./sync.js",
"./calendar.js",
"./diary.js",
"./drive.js",
"./manifest.json"

]

self.addEventListener("install",event=>{

event.waitUntil(

caches.open(CACHE_SHELL)

.then(cache=>cache.addAll(SHELL_FILES))

)

self.skipWaiting()

})

self.addEventListener("activate",event=>{

event.waitUntil(

caches.keys()

.then(keys=>Promise.all(

keys.filter(k=>k!==CACHE_SHELL)

.map(k=>caches.delete(k))

))

)

self.clients.claim()

})

self.addEventListener("fetch",event=>{

const req = event.request

if(req.method!=="GET") return

event.respondWith(

caches.match(req)

.then(cached=>{

if(cached) return cached

return fetch(req)

})

)

})