import type {ReactNode} from 'react';
import './preparation-details.css';

type Props={projectAction?:ReactNode;agentAction?:ReactNode;generationAction?:ReactNode;reviewAction?:ReactNode;generationName?:string;checks?:ReactNode};
export function PreparationRoadmap({projectAction,agentAction,generationAction,reviewAction,generationName='API',checks}:Props){
 return <section className="preparation-roadmap" aria-label="资料准备路线图">
  <div className="preparation-start"><span>第 1 步 · 整理资料库 · 两条路线任选一条</span><h3>把项目资料放进来</h3><p>资料库保存可核对的原文、代码和来源；这一步还没有生成题目。</p></div>
  <div className="preparation-split" aria-hidden="true"><span>↙</span><span>↘</span></div>
  <div className="preparation-branches">
   <section className="preparation-branch" aria-label="路线 A"><small>路线 A</small><h4>逐个导入项目文件夹</h4>
    <ol><li>选择一个项目的文件夹，内部不用固定模板。</li><li>可混放说明、报告、幻灯片和代码子目录。</li><li>继续导入其他项目。原文件保留，软件保存提取的文字与来源。</li></ol>
    {projectAction||<p className="preparation-entry">入口：资料 → 导入项目文件夹。项目名默认取文件夹名，也可自己填写。</p>}
   </section>
   <section className="preparation-branch" aria-label="路线 B"><small>路线 B</small><h4>让电脑上的 Agent 先整理</h4>
    <ol><li>复制软件提供的整理说明。</li><li>交给能读写文件的 Agent，告诉它原资料位置和新输出位置。</li><li>整理后，一次性导入“资料”目录。</li></ol>
    <pre className="preparation-tree">{'资料/\n├─ 项目 A/\n├─ 项目 B/\n└─ 共享资料/（如简历）'}</pre>
    {agentAction||<p className="preparation-entry">入口：资料 → 复制Agent整理说明 → 导入Agent整理目录。</p>}
   </section>
  </div>
  <details className="preparation-file-help"><summary>项目文件夹与文件要求</summary>
   <p>路线 A：一次选择一个项目的文件夹，内部层级、文件名不限；代码和报告子目录仍属于这个项目。简历或跨项目背景可单独作为“共享资料”导入。</p>
   <p>路线 B：选择Agent输出的“资料”目录，第一层子文件夹就是项目名；原文放项目内，Agent的分析、导读和处理说明放目录外。</p>
   <pre className="preparation-tree">{'路线 A：选“项目 A”\n项目 A/\n├─ 项目说明.docx\n├─ 技术方案.pptx\n├─ 测试报告.pdf\n└─ 代码/train.py\n\n路线 B：选“资料”\n新输出目录/\n├─ 资料/项目 A/原文.md\n├─ 资料/项目 B/代码.md\n├─ 资料/共享资料/简历.md\n├─ 整理说明/项目 A/项目导读.md\n└─ 处理说明.md'}</pre>
   <p>直接支持：DOCX、PPTX、XLSX、ODT/ODP/ODS、带文字层的PDF，TXT/Markdown、CSV、JSON/YAML等文本，以及Python、C/C++、Java、JS/TS、Rust等源码。单个文件不超过64 MiB；文字建议使用UTF-8。无需安装Ollama即可读取这些资料。</p>
   <p>扫描PDF、图片、图表和公式不能保证完整提取，旧DOC/PPT/XLS及WPS原生格式需先转换。音视频、模型权重和二进制文件不作为资料原文读取。仅放相关材料，排除密钥、依赖、缓存和大型原始数据；导入后查看失败或遗漏提示，代码不会执行。</p>
  </details>
  <div className="preparation-merge"><span aria-hidden="true">↓</span>资料库已准备好，接下来整理题库</div>
  {checks}
  <section className="preparation-common"><span>第 2 步 · 整理题库（待检查）</span><h4>交给 {generationName} 生成问题与回答</h4><p>模型根据资料库生成问答并给出引用与查重建议，结果进入“待检查”。资料库保留原文，题库保存可编辑的问题和回答，两者分开。</p><p>默认处理全部已导入项目；也可在顶部选一个项目。发送前预览范围，确认后生成。</p>{generationAction||<p className="preparation-entry">到“资料”点击“准备问答”。</p>}</section>
  <div className="preparation-arrow" aria-hidden="true">↓</div>
  <section className="preparation-common"><span>第 3 步 · 整理题库（已采用）</span><h4>检查答案，采用后开始练习</h4><p>展开问答，核对引用、个人贡献和完成情况；有误就修改，核对后采用。只有已采用的答案会作为练习用答案，编辑题库不会改动资料原文。</p>{reviewAction||<p className="preparation-entry">到“已采用”开启使用，在模拟练习设置勾选“使用已采用问答出题”。</p>}</section>
 </section>;
}
