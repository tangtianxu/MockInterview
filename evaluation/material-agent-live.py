"""Run the packaged material prompt with bounded file tools in a synthetic directory."""
import argparse, hashlib, importlib.util, json, time, urllib.request
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
BASE=ROOT/'outputs/material-agent-final'

def main():
    global BASE
    parser=argparse.ArgumentParser();parser.add_argument('--continue-existing',action='store_true');parser.add_argument('--verify-existing',action='store_true');parser.add_argument('--output-name',default='material-agent-final');args=parser.parse_args()
    if Path(args.output_name).name!=args.output_name or args.output_name in ('.','..'):raise ValueError('Use a simple output directory name')
    BASE=ROOT/'outputs'/args.output_name;BASE.mkdir(parents=True,exist_ok=True);source=BASE/'input';output=BASE/'output';source.mkdir(exist_ok=True);output.mkdir(exist_ok=True)
    texts={'零散说明.md':'# 拣选演示项目\n团队完成了10次规则抓取演示，其中8次成功。个人只明确负责图像预处理脚本。下一步考虑VLA，尚未实现VLA微调、部署和强化学习训练。\n',
      'src/preprocess.py':'# 拣选演示项目的图像预处理脚本\ndef preprocess(frame):\n    return frame / 255.0\n\ndef run(frames):\n    return [preprocess(frame) for frame in frames]\n',
      '另一个说明.md':'# 日志演示项目\n已实现本地关键词索引和时间过滤，验证仅有三条合成日志。个人作者和吞吐量没有记录。未实现向量检索，语义检索仅为计划。\n'}
    texts={k:v.replace('\\n','\n') for k,v in texts.items()}
    for name,text in texts.items():path=source/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text(text,encoding='utf-8')
    before={name:hashlib.sha256((source/name).read_bytes()).hexdigest() for name in texts}
    prompt=json.loads((ROOT/'outputs/fixed-prompt-synthetic/prompts.json').read_text(encoding='utf-8'))['materials']
    spec=importlib.util.spec_from_file_location('key',ROOT/'evaluation/knowledge-model-compare.py');mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod);key=None if args.verify_existing else mod.scoped_key()
    tools=[{'type':'function','function':{'name':name,'description':description,'parameters':{'type':'object','properties':properties,'required':required}}} for name,description,properties,required in [
      ('list_files','List relative file paths under input. All documents are synthetic.',{'path':{'type':'string'}},['path']),
      ('read_file','Read a UTF-8 source under input, preserving its full original text. Do not execute code.',{'path':{'type':'string'}},['path']),
      ('write_file','Write a UTF-8 Markdown output under output. Original input is read-only.',{'path':{'type':'string'},'content':{'type':'string'}},['path','content'])]]
    messages=[{'role':'system','content':prompt},{'role':'user','content':'原资料目录：input。新输出目录：output。请按固定流程完成整理，使用文件工具读写。'}]
    records=[];start=time.perf_counter();done=False
    if args.continue_existing or args.verify_existing:
      previous=json.loads((BASE/'result.json').read_text(encoding='utf-8'));records=previous['turns'];messages=json.loads((BASE/'messages.json').read_text(encoding='utf-8'));assert messages[0]['content']==prompt,'Prompt changed; do not continue an old scope'
      if args.verify_existing:done=previous['checks']['completedWithinSixTurns']
    for turn in ([] if args.verify_existing else range(len(records),6)):
      payload={'model':'deepseek-flash','messages':messages,'tools':tools,'thinking':{'type':'disabled'},'temperature':0.1,'max_tokens':6000,'stream':False}
      request=urllib.request.Request('https://api.deepseek.com/chat/completions',data=json.dumps(payload,ensure_ascii=False).encode(),headers={'Authorization':'Bearer '+key,'Content-Type':'application/json'},method='POST')
      with urllib.request.build_opener(mod.NoRedirect()).open(request,timeout=60) as response:body=json.load(response)
      choice=body['choices'][0];message=choice['message'];calls=message.get('tool_calls',[]);records.append({'turn':turn+1,'usage':body.get('usage',{}),'finishReason':choice.get('finish_reason'),'toolCount':len(calls)})
      print(json.dumps(records[-1],ensure_ascii=False),flush=True)
      if choice.get('finish_reason')=='length':raise ValueError('Material tool output reached its limit')
      messages.append(message)
      if not calls:done=True;break
      for call in calls:
        fn=call['function']['name'];args=json.loads(call['function']['arguments']);relative=Path(args['path']);path=(BASE/relative).resolve()
        if relative.is_absolute() or '..' in relative.parts or not path.is_relative_to(BASE.resolve()):raise ValueError('Tool path outside synthetic scope')
        if fn=='list_files':
          if path!=source.resolve():raise ValueError('Unexpected listing path')
          result={'files':['input/'+name for name in texts]}
        elif fn=='read_file':
          if not path.is_relative_to(source.resolve()) or not path.is_file():raise ValueError('Unexpected read path')
          result={'path':str(relative),'text':path.read_text(encoding='utf-8')}
        elif fn=='write_file':
          if not path.is_relative_to(output.resolve()) or path.suffix.lower()!='.md':raise ValueError('Unexpected output path')
          path.parent.mkdir(parents=True,exist_ok=True);path.write_text(args['content'],encoding='utf-8');result={'saved':str(relative)}
        else:raise ValueError('Unexpected tool')
        messages.append({'role':'tool','tool_call_id':call['id'],'content':json.dumps(result,ensure_ascii=False)})
    files=list(output.rglob('*.md'));joined='\n'.join(p.read_text(encoding='utf-8') for p in files)
    original_only=True
    for name,text in texts.items():
      expected_name=Path(name).name if name.endswith('.md') else Path(name).name+'.md'
      matches=list((output/'资料').rglob(expected_name))
      if len(matches)!=1:original_only=False;continue
      lines=[line.strip() for line in matches[0].read_text(encoding='utf-8').splitlines() if line.strip() and not line.lstrip().startswith(('> 来源：','```'))]
      expected=[line.strip() for line in text.splitlines() if line.strip()]
      if lines!=expected and lines and lines[0] in ('# '+Path(name).name,'# '+Path(name).stem):lines.pop(0)
      if lines!=expected:original_only=False
    checks={'completedWithinSixTurns':done,'originalsUnchanged':all(hashlib.sha256((source/name).read_bytes()).hexdigest()==digest for name,digest in before.items()),'hasMaterialsDirectory':(output/'资料').is_dir(),'hasProcessingReport':(output/'处理说明.md').is_file(),'summariesSeparated':(output/'整理说明').is_dir() and not any('项目导读' in p.name for p in (output/'资料').rglob('*.md')),'materialsContainOnlyOriginalText':original_only,'preservedCodeFunction':all(token in joined for token in ('def preprocess(frame):','def run(frames):','return frame / 255.0','return [preprocess(frame) for frame in frames]')),'retainsPlanBoundary':'尚未实现VLA微调' in joined,'retainsOtherProject':'日志演示项目' in joined}
    result={'model':'deepseek-flash','promptSha256':hashlib.sha256(prompt.encode()).hexdigest(),'elapsedMs':previous['elapsedMs'] if args.verify_existing else round((time.perf_counter()-start)*1000),'turns':records,'files':[str(p.relative_to(output)) for p in files],'checks':checks}
    (BASE/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8');(BASE/'messages.json').write_text(json.dumps(messages,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(result,ensure_ascii=False),flush=True)
    if not all(checks.values()):raise SystemExit(1)
if __name__=='__main__':main()
