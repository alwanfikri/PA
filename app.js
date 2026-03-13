import {openDB} from "./db.js"

import {initSync} from "./sync.js"

import {initDiary,openDiaryEditor} from "./diary.js"

import {initCalendar,openEventEditor} from "./calendar.js"

import {initPhotoGallery} from "./drive.js"


async function boot(){

await openDB()

await registerSW()

await initSync()

await initDiary()

await initCalendar()

initPhotoGallery()

bindUI()

}


async function registerSW(){

if(!("serviceWorker" in navigator)) return

try{

await navigator.serviceWorker.register("./service-worker.js")

}catch(e){

console.error(e)

}

}


function bindUI(){

document.getElementById("fab-diary")?.addEventListener("click",()=>{

openDiaryEditor()

})

document.getElementById("fab-agenda")?.addEventListener("click",()=>{

openEventEditor()

})

document.getElementById("gallery-upload-btn")?.addEventListener("click",()=>{

document.getElementById("gallery-upload-input").click()

})

}


boot()