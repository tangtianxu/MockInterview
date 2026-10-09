import {useState} from "react";
import {open} from "@tauri-apps/plugin-shell";

export function SetupGuide({onSettings,onDismiss}:{onSettings?:()=>void;onDismiss:()=>void}) {
  const [error,setError]=useState("");
  const visit=async(url:string)=>{try{await open(url);setError("");}catch(cause){setError(`无法打开网页：${String(cause)}`);}};
  return <section className="setup-guide" aria-label="首次使用指南">
    <span className="panel-kicker">开始前准备</span><h3>第一次使用，按这五步来</h3>
    <p>推荐：本地流式语音识别＋DeepSeek Flash API。只用键盘作答可跳过语音模型。</p>
    <button className="start-btn" onClick={onSettings}>打开模型与服务</button>
    <ol>
      <li><h4>准备 Ollama（简历分析或免费本地方案需要）</h4>
        <p>下载并安装 Ollama。在“设置 → 模型与服务 → 本地 Ollama”重新检测，下载 <code>qwen3:4b-instruct</code> 并启动服务。只用 API 做技术基础练习，可跳过。</p>
        <button className="practice-secondary" onClick={()=>void visit("https://ollama.com/download/windows")}>下载 Ollama</button></li>
      <li><h4>下载一个本地流式语音模型</h4>
        <p>在“模型与服务 → 语音识别”选“本地模型”，引擎选“Sherpa-ONNX · 中英双语流式”。优先试 Paraformer（约 226 MB）；Zipformer（约 511 MB）也是推荐备选。选一个下载即可，等待校验与解压完成。两者无需 CUDA，具体识别效果请试听比较。</p></li>
      <li><h4>连接出题与评价模型</h4>
        <p>推荐 DeepSeek Flash API：在官方平台注册、按需充值并创建 API 密钥。模型服务选“DeepSeek 官方”，粘贴密钥后点“检测并连接”；推荐模型 ID 为 <code>deepseek-flash</code>，地址自动填写。网页聊天账号不等于已经开通 API。</p>
        <button className="practice-secondary" onClick={()=>void visit("https://platform.deepseek.com/api_keys")}>获取 DeepSeek API 密钥</button>
        <p>免费备选：选“本地 Ollama”并检测已下载的模型。无需 API 调用费，但占用本机内存和算力；小模型可能漏答或评分不准，因此不作为新手首选。简历分析仍需先在本地完成，之后可切回 API。</p></li>
      <li><h4>完成一次模拟练习</h4>
        <p>先填岗位与关注主题（可选），范围选“技术基础”，时长选 10 分钟。开始练习后输入回答，或“麦克风作答 → 停止麦克风 → 检查转写 → 提交回答”，再查看评分、错漏和参考答案，点击“下一题”。项目练习需先导入并分析简历。</p></li>
      <li><h4>用 B 站素材测试效果</h4>
        <p>搜索“模拟面试＋你的岗位”，选短片段。听完提问就暂停，自己口头回答；在相同主题的练习中检查麦克风转写，再对照视频讲解与参考答案。重点核对术语、缩写和关键原理，而不是只看评分。耳机不会把视频声音直接送进麦克风，语音作答转写的是你说的话。</p>
        <button className="practice-secondary" onClick={()=>void visit("https://search.bilibili.com/all?keyword=%E6%A8%A1%E6%8B%9F%E9%9D%A2%E8%AF%95")}>查找 B 站模拟面试视频</button></li>
    </ol>
    {error && <p className="practice-reference-error" role="alert">{error}</p>}
    <div className="setup-guide-actions"><button className="practice-secondary" onClick={onDismiss}>已了解，收起指南</button></div>
  </section>;
}
