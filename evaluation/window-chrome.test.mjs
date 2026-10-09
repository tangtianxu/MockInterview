import {test} from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdir,writeFile,unlink} from "node:fs/promises";
import {chromium} from "playwright-core";

test("title bars drag from all non-controls and narrow content scrolls inside the rounded frame",{timeout:60000},async()=>{
  const fixture="outputs/window-chrome-fixture.html";
  await mkdir("outputs",{recursive:true});
  await writeFile(fixture,String.raw`<!doctype html><html lang="zh"><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module">
import React from 'react';import {createRoot} from 'react-dom/client';
import {mockIPC,mockWindows} from '@tauri-apps/api/mocks';import App from '/src/App.tsx';import '/src/index.css';
const params=new URLSearchParams(location.search);
mockWindows(params.get('overlay')==='true'?'overlay':'launcher');localStorage.clear();window.calls=[];
localStorage.setItem('interviewCue.settings',JSON.stringify({theme:params.get('theme')||'dark'}));
mockIPC(async(command,args)=>{
 window.calls.push({command,args});
 if(command==='load_interview_profile')return null;
 if(command==='plugin:app|version')return '1.0.8';
 if(command==='list_audio_devices'||command==='list_local_stt_engines')return '[]';
 if(command==='mvp_list_models')return [];
 if(command==='local_stt_model_directory')return 'fixture';
 if(command==='ollama_runtime_status')return {executable:null,connected:false,configuredExecutable:null,modelsDirectory:null,configFile:'fixture'};
 if(command==='get_privacy_display_state'||command==='set_taskbar_hidden')return {errors:[],launcher_capture_excluded:true,overlay_capture_excluded:true,taskbar_hidden:true};
 if(command==='has_api_key'||command.includes('is_registered'))return false;
 return null;
},{shouldMockEvents:true});
createRoot(document.getElementById('root')).render(React.createElement(App));
</script></body></html>`);
  const server=spawn(process.execPath,["node_modules/vite/bin/vite.js","--host","127.0.0.1","--port","5195","--strictPort"],{windowsHide:true,stdio:"pipe"});
  let output="";server.stdout.on("data",data=>output+=data);server.stderr.on("data",data=>output+=data);
  let browser;
  try{
    const url="http://127.0.0.1:5195/"+fixture;
    for(let attempt=0;attempt<60;attempt++){
      if(server.exitCode!==null)throw new Error(output);
      try{if((await fetch(url)).ok)break;}catch{}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    browser=await chromium.launch({headless:true,channel:"msedge"});
    const page=await browser.newPage();const errors=[];
    page.on('pageerror',error=>errors.push(String(error)));
    const countDrags=()=>page.evaluate(()=>window.calls.filter(item=>item.command==='plugin:window|start_dragging').length);
    const checkDrags=async selector=>{
      const before=await countDrags();
      const samples=await page.locator(selector).evaluate(header=>{
        const r=header.getBoundingClientRect();let count=0;
        for(let y=r.top+6;y<r.bottom-2;y+=13)for(let x=r.left+6;x<r.right-2;x+=19){
          const target=document.elementFromPoint(x,y);
          if(!target||!header.contains(target)||target.closest('button,[role=button],input,select,textarea,a,summary,[contenteditable]'))continue;
          target.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,clientX:x,clientY:y}));count++;
        }
        return count;
      });
      assert.ok(samples>10);
      assert.equal(await countDrags()-before,samples,selector+' has uncovered title bar points');
      const after=await countDrags();
      await page.locator(selector).evaluate(header=>{
        for(const control of header.querySelectorAll('button,[role=button]')){
          for(const target of [control,control.querySelector('svg')].filter(Boolean))target.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));
        }
        header.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:2}));
      });
      assert.equal(await countDrags(),after,'controls and right clicks must not start dragging');
    };
    for(const theme of ['dark','light'])for(const viewport of [{width:600,height:480},{width:600,height:850},{width:1600,height:900},{width:760,height:480},{width:760,height:850},{width:940,height:640},{width:1040,height:520},{width:1360,height:850}]){
      await page.setViewportSize(viewport);await page.goto(url+'?theme='+theme);
      await page.locator('.app-version').waitFor();
      await checkDrags('.app-header');
      const positions=await page.evaluate(()=>({controls:document.querySelector('.window-actions').getBoundingClientRect().bottom,actions:document.querySelector('.header-actions').getBoundingClientRect().top}));
      assert.ok(positions.controls<=positions.actions,'window controls must remain above business actions');
      const checkLayout=async()=>{
        const layout=await page.evaluate(()=>{
          const shell=document.querySelector('.app-shell'),header=document.querySelector('.app-header');
          const sr=shell.getBoundingClientRect(),hr=header.getBoundingClientRect();
          const content=document.querySelector('main'),cr=content.getBoundingClientRect();
          return {overflow:getComputedStyle(shell).overflowY,height:shell.clientHeight,scrollHeight:shell.scrollHeight,
            headerTop:hr.top,contentTop:cr.top,headerBottom:hr.bottom,shellBottom:sr.bottom,contentBottom:cr.bottom,
            scrollbarWidth:getComputedStyle(content,'::-webkit-scrollbar').width,arrowDisplay:getComputedStyle(content,'::-webkit-scrollbar-button').display,
            track:getComputedStyle(content,'::-webkit-scrollbar-track').backgroundColor,bodyWidth:document.documentElement.scrollWidth,viewport:innerWidth};
        });
        assert.equal(layout.overflow,'hidden');assert.ok(layout.scrollHeight<=layout.height+1);
        assert.ok(layout.contentTop>=layout.headerBottom-1);assert.ok(layout.contentBottom<=layout.shellBottom+1);
        assert.ok(layout.bodyWidth<=layout.viewport);
        assert.equal(layout.scrollbarWidth,'10px');assert.equal(layout.arrowDisplay,'none');assert.equal(layout.track,'rgba(0, 0, 0, 0)');
      };
      await checkLayout();
      await page.getByRole('button',{name:'双击切换练习与实时提示页面'}).dblclick();
      await checkLayout();
      assert.ok(await page.evaluate(()=>document.querySelector('.window-actions').getBoundingClientRect().bottom<=document.querySelector('.header-actions').getBoundingClientRect().top));
      if(viewport.width<=940){
        const before=await page.locator('.app-header').boundingBox();
        await page.locator('.workspace').evaluate(element=>{element.scrollTop=500;});
        assert.ok(await page.locator('.workspace').evaluate(element=>element.scrollTop)>0);
        assert.deepEqual(await page.locator('.app-header').boundingBox(),before);
      }
      if(viewport.width===760&&viewport.height===850){
        await page.locator('.workspace').evaluate(element=>{element.scrollTop=0;});
        const bounds=await page.locator('.transcript-scroll').evaluate(element=>({top:element.getBoundingClientRect().top,iconTop:element.querySelector('.empty-icon').getBoundingClientRect().top,scrollTop:element.scrollTop,height:element.clientHeight,scrollHeight:element.scrollHeight}));
        assert.ok(bounds.iconTop>=bounds.top,'empty transcript content must not overflow above its scroll area: '+JSON.stringify(bounds));
        await page.getByRole('button',{name:'控制区',exact:true}).click();
        await page.getByRole('button',{name:'转录',exact:true}).click();
        await checkLayout();
        const content=await page.locator('.workspace').boundingBox(),answer=await page.locator('.answer-panel').boundingBox();
        assert.ok(Math.abs(content.y+content.height-answer.y-answer.height)<1,'single answer panel should fill the available content height');
        await page.screenshot({path:`outputs/window-chrome-${theme}.png`});
      }
    }
    await page.getByRole('button',{name:'设置',exact:true}).click();await checkDrags('.drawer-head');
    await page.getByRole('button',{name:'关闭设置'}).click();
    const before=await countDrags();await page.locator('.panel-header').first().dispatchEvent('mousedown',{button:0});
    assert.equal(await countDrags(),before,'content below title divider must not move the window');
    await page.setViewportSize({width:410,height:290});await page.goto(url+'?overlay=true');
    await page.locator('.app-version').waitFor();await checkDrags('.floating-head');
    assert.deepEqual(errors,[]);
  }finally{await browser?.close();server.kill();await unlink(fixture).catch(()=>{});}
});
