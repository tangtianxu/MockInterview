"""Bounded evaluation with synthetic inputs only; never load personal source data."""
import argparse, hashlib, importlib.util, json, re, time, urllib.request, urllib.error, uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]

def prompts():
    exported=ROOT/'outputs/fixed-prompt-synthetic/prompts.json'
    if exported.exists():return {k:v for k,v in json.loads(exported.read_text(encoding='utf-8')).items() if k in ('organization','bank','build')}
    intake=(ROOT/'src-tauri/src/knowledge_intake.rs').read_text(encoding='utf-8')
    build=(ROOT/'src-tauri/src/knowledge_build.rs').read_text(encoding='utf-8')
    return {'organization':json.loads('"'+re.search(r'pub const ORGANIZATION_PROMPT:&str="(.*?)";',intake,re.S).group(1)+'"'),
      'bank':re.search(r'pub fn agent_bank_prompt\(\).*?r#"(.*?)"#',intake,re.S).group(1),
      'build':re.search(r'pub const BUILD_PROMPT: &str = r#"(.*?)"#',build,re.S).group(1)}

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--run-synthetic-three-calls',action='store_true');parser.add_argument('--retry-bank-only',action='store_true');parser.add_argument('--only-build-pro',action='store_true');parser.add_argument('--output-name',default='fixed-prompt-synthetic');args=parser.parse_args()
    if not (args.run_synthetic_three_calls or args.retry_bank_only or args.only_build_pro):raise RuntimeError('Evaluation is limited to three synthetic requests')
    spec=importlib.util.spec_from_file_location('scoped_credentials',ROOT/'evaluation/knowledge-model-compare.py');mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
    key=mod.scoped_key();
    if not re.fullmatch(r'[a-z0-9-]+',args.output_name):raise ValueError('Choose an owned evaluation folder name')
    out=ROOT/'outputs'/args.output_name;out.mkdir(parents=True,exist_ok=True)
    texts=[('拣选演示项目','A/report.md','拣选演示项目：目标是识别桌面物体并完成规则控制抓取。已完成：团队用视觉检测和规则控制完成了10次演示，其中8次成功。个人贡献：候选人只明确记录负责图像预处理脚本；未说明本人编写检测器、控制器或VLA模型。报告不代表本人独立完成。计划：下一步考虑Vision-Language-Action（VLA，视觉-语言-动作）模型；尚未实现VLA微调、部署或强化学习训练。未提供选型动机、失败原因或训练参数。'),
      ('日志演示项目','B/readme.md','日志演示项目：目标是让测试用户查询日志关键词。已完成：实现本地关键词倒排索引和时间范围过滤。资料未说明个人作者或吞吐量，不含向量检索或大模型RAG。计划：未来比较语义检索。当前验证仅含三条合成日志样例，不能宣称生产部署或大规模压测。'),
      ('共享资料','resume.txt','合成背景：候选人参与拣选演示项目和日志演示项目。不能确定个人负责全部实现。本文是人工构造的测试材料，没有真实个人信息。')]
    sources=[]
    for index,(project,path,text) in enumerate(texts):
        sid=str(uuid.uuid5(uuid.NAMESPACE_URL,'mockinterview-prompt-synthetic/'+path));digest=hashlib.sha256(text.encode()).hexdigest()
        sources.append({'sourceId':sid,'hash':digest,'project':project,'path':path,'locator':'合成材料全文','text':text})
    kit={'sources.json':[{'sourceId':s['sourceId'],'hash':s['hash'],'project':s['project'],'originalPath':s['path'],'textFile':'资料/'+s['sourceId']+'.txt'} for s in sources],
      'files':{'资料/'+s['sourceId']+'.txt':s['text'] for s in sources},
      '题库格式示例.json':{'format':'mockinterview-agent-bank-v1','questions':[{'question':'明确的单一问题','project':'来源项目','category':'项目问题','task':'考察内容','aliases':[],'tags':[],'answer':'有依据的回答','explanation':'展开','followUps':[],'priority':1,'priorityReason':'准备理由','missing':[],'references':[{'sourceId':'来源ID','hash':'来源hash','quote':'连续原文'}]}]}}
    input_payloads={'organization':{'sources':[{**s,'project':'待确认资料'} for s in sources],'existingProjects':['拣选演示项目','日志演示项目','共享资料']},'bank':kit,
      'build':{'project':'拣选演示项目','sources':[sources[0]],'existing':[{'id':'11111111-1111-4111-8111-111111111111','project':'拣选演示项目','category':'项目问题','task':'解释机制','question':'当前系统的抓取链路是什么？','aliases':[]}],'steps':['筛选准备重点','生成回答草稿','核对事实与引用','检查同任务重复']}}
    (out/'fixture.json').write_text(json.dumps({'sources':sources,'inputs':input_payloads},ensure_ascii=False,indent=2),encoding='utf-8')
    results=[]
    for kind,system in prompts().items():
        if args.retry_bank_only and kind!='bank':continue
        if args.only_build_pro and kind!='build':continue
        if kind=='bank':
            input_payloads['bank']={**kit,'sources.json':kit['sources.json'][:1],'files':{'资料/'+sources[0]['sourceId']+'.txt':sources[0]['text']}}
        started=time.perf_counter();payload={'model':'deepseek-v4-pro' if args.only_build_pro else 'deepseek-flash','messages':[{'role':'system','content':system},{'role':'user','content':json.dumps(input_payloads[kind],ensure_ascii=False)}],'response_format':{'type':'json_object'},'thinking':{'type':'disabled'},'temperature':0.1,'max_tokens':6000,'stream':False}
        if kind=='bank':
            payload.pop('response_format',None)
            payload['tools']=[{'type':'function','function':{'name':'write_file','description':'Write a UTF-8 file to the synthetic work package. Use a relative path under 生成问答. This tool is available for the fixed Agent workflow.','parameters':{'type':'object','properties':{'path':{'type':'string'},'content':{'type':'string'}},'required':['path','content']}}}]
        request=urllib.request.Request('https://api.deepseek.com/chat/completions',data=json.dumps(payload,ensure_ascii=False).encode(),headers={'Authorization':'Bearer '+key,'Content-Type':'application/json'},method='POST')
        result={'kind':kind,'model':payload['model'],'promptSha256':hashlib.sha256(system.encode()).hexdigest()}
        try:
            with urllib.request.build_opener(mod.NoRedirect()).open(request,timeout=60) as response:body=json.load(response)
            result['usage']=body.get('usage',{});result['finishReason']=body['choices'][0].get('finish_reason');message=body['choices'][0]['message']
            if kind=='bank':
                calls=message.get('tool_calls',[]);documents=[]
                for call in calls:
                    if call['function']['name']!='write_file':raise ValueError('Unexpected tool')
                    arguments=json.loads(call['function']['arguments']);path=Path(arguments['path']);target=(out/'agent-results'/path).resolve();allowed=(out/'agent-results').resolve()
                    if path.is_absolute() or '..' in path.parts or not target.is_relative_to(allowed) or path.suffix!='.json':raise ValueError('Unexpected synthetic output path')
                    document=json.loads(arguments['content']);target.parent.mkdir(parents=True,exist_ok=True);target.write_text(arguments['content'],encoding='utf-8');documents.append(document)
                if not documents:raise ValueError('Agent did not use its available file tool')
                result['content']={'format':'mockinterview-agent-bank-v1','questions':[q for d in documents for q in d.get('questions',[])]};result['writtenFiles']=len(documents);result['allFileFormatsValid']=all(d.get('format')=='mockinterview-agent-bank-v1' and len(d.get('questions',[]))<=8 for d in documents)
            else:result['content']=json.loads(message['content'])
            rows=result['content'].get('questions',[])
            if kind=='organization':result['checks']={'allSourcesCovered':sorted(q['sourceId'] for q in result['content'].get('assignments',[]))==sorted(s['sourceId'] for s in sources)}
            else:
                quotes=[r for q in rows for r in q.get('references',[])];result['checks']={'validRoot':kind!='bank' or result['content'].get('format')=='mockinterview-agent-bank-v1','questionCount':len(rows),'nonEmpty':bool(rows),'allAnswersPresent':all(q.get('answer','').strip() for q in rows),'allQuotesExact':all(any(s['sourceId']==r.get('sourceId') and s['hash']==r.get('hash') and r.get('quote') and r['quote'] in s['text'] for s in sources) for r in quotes),'allAnswersCited':all(q.get('references') for q in rows)}
        except Exception as e:
            result['errorType']=type(e).__name__ # Never print transport headers or credentials.
        result['elapsedMs']=round((time.perf_counter()-started)*1000);results.append(result)
        (out/(kind+('-retry' if args.retry_bank_only else '-pro' if args.only_build_pro else '')+'.json')).write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
        print(json.dumps({k:v for k,v in result.items() if k!='content'},ensure_ascii=False),flush=True)
    (out/('retry-summary.json' if args.retry_bank_only else 'pro-summary.json' if args.only_build_pro else 'summary.json')).write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
    if any('errorType' in r or r.get('finishReason') not in ('stop','tool_calls') or any(value is False for value in r.get('checks',{}).values()) for r in results):raise SystemExit(1)
if __name__=='__main__':main()
