import {test} from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdir,writeFile,unlink} from "node:fs/promises";
import {chromium} from "playwright-core";

test("shared formula display handles streaming, failures and narrow windows",{timeout:45000},async()=>{
  const fixture="outputs/math-rendering-fixture.html";
  await mkdir("outputs",{recursive:true});
  await writeFile(fixture,`<!doctype html><html lang="zh"><head><meta charset="UTF-8"></head><body>
    <div id="root"></div><script type="module">
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {MathText} from '/src/MathText.tsx';import '/src/index.css';import '/src/practice.css';
    function Fixture(){const [text,setText]=React.useState('准备检查公式显示');window.updateMath=setText;React.useLayoutEffect(()=>{window.currentMath=text},[text]);
      return React.createElement('div',{style:{padding:20,display:'grid',gap:20}},
        React.createElement('div',{className:'answer-card theme-dark',style:{width:540,padding:24}},
          React.createElement('div',{className:'answer-text'},React.createElement(MathText,{text}))),
        React.createElement('div',{className:'theme-light'},React.createElement('div',{className:'practice-bubble interviewer',style:{width:540}},
          React.createElement('p',null,React.createElement(MathText,{text})))),
        React.createElement('div',{className:'floating-shell theme-dark',style:{width:370,height:'auto',padding:20}},
          React.createElement('div',{className:'floating-answer expanded'},React.createElement(MathText,{text}))));}
    createRoot(document.getElementById('root')).render(React.createElement(Fixture));
    </script></body></html>`);
  const server=spawn(process.execPath,["node_modules/vite/bin/vite.js","--host","127.0.0.1","--port","5193","--strictPort"],{windowsHide:true,stdio:"pipe"});
  let serverOutput="";server.stdout.on("data",data=>serverOutput+=data);server.stderr.on("data",data=>serverOutput+=data);
  let browser;
  try {
    const url="http://127.0.0.1:5193/"+fixture;
    for(let attempt=0;attempt<60;attempt++){
      if(server.exitCode!==null)throw new Error(serverOutput);
      try{if((await fetch(url)).ok)break;}catch{}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_BROWSER_PATH ? {executablePath:process.env.PLAYWRIGHT_BROWSER_PATH} : {channel:"msedge"})});
    const page=await browser.newPage({viewport:{width:640,height:1000}});
    const errors=[];page.on("pageerror",error=>errors.push(String(error)));
    await page.goto(url);await page.waitForFunction(()=>typeof window.updateMath==="function");
    const update=async text=>{await page.evaluate(text=>window.updateMath(text),text);await page.waitForFunction(text=>window.currentMath===text,text);};
    const partial=String.raw`公式：\[\operatorname{Attention}(Q,K,V)=\operatorname{softmax}\left(\frac{QK^\top}{\sqrt{d_k}}`;
    await update(partial);
    assert.equal(await page.locator(".katex").count(),0);
    assert.equal(await page.locator(".math-text").first().textContent(),partial);
    const attention=String.raw`公式：\[\operatorname{Attention}(Q,K,V)=\operatorname{softmax}\left(\frac{QK^\top}{\sqrt{d_k}}\right)V\]`;
    const complete=attention+String.raw`其中 \(d_k\) 是键向量的维度。矩阵示例：$$\begin{bmatrix}1&2\\3&4\end{bmatrix}$$`;
    await update(complete);await page.waitForFunction(()=>document.querySelectorAll('.katex').length===9);
    assert.equal(await page.locator(".math-text .mfrac").count(),3);
    assert.equal(await page.locator(".math-text .sqrt").count(),3);
    assert.equal(await page.locator(".katex-error").count(),0);
    await page.evaluate(()=>document.fonts.ready);
    const layout=await page.locator('.floating-answer .katex-display').first().evaluate(element=>({
      overflow:element.scrollWidth>element.clientWidth,scroll:getComputedStyle(element).overflowX,
      parentWidth:element.parentElement.getBoundingClientRect().width,width:element.getBoundingClientRect().width}));
    assert.equal(layout.scroll,"auto");assert.ok(layout.width<=layout.parentWidth+1);
    assert.notEqual(await page.locator('.theme-light .katex').first().evaluate(element=>getComputedStyle(element).color),
      await page.locator('.floating-answer .katex').first().evaluate(element=>getComputedStyle(element).color));
    await page.screenshot({path:"outputs/math-rendering-preview.png",fullPage:true});
    await update(String.raw`长公式：\[A=\operatorname{Attention}(Q,K,V)+\operatorname{Attention}(Q,K,V)+\operatorname{Attention}(Q,K,V)+\operatorname{Attention}(Q,K,V)\]`);
    const overflow=await page.locator('.floating-answer .katex-display').evaluate(element=>element.scrollWidth>element.clientWidth);
    assert.equal(overflow,true);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
    for(const text of [String.raw`错误：\[\frac{1}{\]`,"纯文字：<img src=x onerror=alert(1)>，预算 $100 和 $200。",partial]){
      await update(text);assert.equal(await page.locator('.math-text').first().textContent(),text);
      assert.equal(await page.locator('.katex').count(),0);assert.equal(await page.locator('.math-text img').count(),0);
    }
    await update(String.raw`链接：\[\href{https://example.com}{Q}\]`);
    assert.equal(await page.locator('.math-text a').count(),0);
    await update(complete);await page.waitForFunction(()=>document.querySelectorAll('.katex').length===9);
    assert.deepEqual(errors,[]);
    console.log("Verified attention fraction/root, matrix, inline dimensions, streamed fallback, source safety and narrow-window scrolling.");
  }finally{
    await browser?.close();server.kill();await unlink(fixture).catch(()=>{});
  }
});
