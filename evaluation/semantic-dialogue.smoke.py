"""Optional local Ollama smoke test using the production prompt and JSON schema.
Run from the repository root after downloading qwen3:4b-instruct.
"""
import argparse,json,re,urllib.request
from pathlib import Path
s=(Path(__file__).resolve().parents[1]/'src-tauri/src/commands/mvp_commands.rs').read_text(encoding='utf-8')
a=s.index('    let system = "你是中文技术面试的实时任务提取器。')+len('    let system = ')
b=s.index(';\n    let user = format!',a)
raw=s[a:b];raw=re.sub(r'\\\n\s*','',raw).replace('\n','\\n')
system=json.loads(raw)
user_format=json.JSONDecoder().raw_decode(s[b+len(';\n    let user = format!('):])[0]
intents=json.loads(re.search(r'const DECISION_INTENTS:[^=]+= &(.+?);',s).group(1))
start=s.index('serde_json::json!(',s.index('fn decision_schema()'))+len('serde_json::json!(')
end=s.index(')\n}',start)
schema=json.loads(s[start:end].replace('DECISION_INTENTS',json.dumps(intents)))
cases=[
 ('自我介绍','请介绍一下你自己','', 'self_introduction',None),
 ('提及自我介绍的技术题','你刚才自我介绍里提到的 PPO 是什么','', 'question','PPO'),
 ('候选人回答后的追问','为什么选择它','面试官：介绍一下 PPO。\n候选人：我采用的是 GAE 来估计优势。', 'question','GAE'),
 ('音近术语纠偏','BPO 通常在什么情况下使用','面试官：我们正在讨论强化学习里的 PPO。\n候选人：PPO 用于策略优化。', 'question','PPO'),
 ('不同方法的指代','它的参数怎么设置','面试官：介绍 SAC 算法。\n候选人：训练网络时我用了 Adam 优化器。', 'question','Adam'),
 ('明确新术语不强制纠错','换个话题：业务流程外包（BPO）的成本怎么评估','面试官：我们刚才讨论过 PPO。', 'question','BPO'),
 ('工程背景整合','我们用 PPO 控制机器人，训练奖励持续上涨，但实际测试表现下降，而且动作抖动。怎么排查和解决？','', 'question','PPO'),
 ('泛化追问音近纠偏','那一般怎么样去提升模型的方法能力呢','视频音频（可能包含双方）：模型对未见数据的预测是对泛化性能的要求。','question','泛化','解释一下模型的泛化能力是什么',True),
 ('问题之后紧接候选人回答','那一般怎么样去提升模型的方法能力呢\n嗯首先是呢需要对区域训练它这个过程当中他的数据\n集的构成首先要做到尽量的','视频音频（可能包含双方）：模型对未见数据的预测是对泛化性能的要求。','question','泛化','解释一下模型的泛化能力是什么',True),
 ('问题之后紧接未完回答增量','那一般怎么样去提升模型的方法能力呢\n嗯首先是呢需要对区域训练它这个过程当中他的数据\n集的构成首先要做到尽量的','视频音频（可能包含双方）：模型对未见数据的预测是对泛化性能的要求。','question','泛化','解释一下模型的泛化能力是什么',True,False),
 ('只有候选人回答不重答旧题','首先训练数据的构成要尽量覆盖测试分布，还可以使用正则化。','视频音频（可能包含双方）：那一般怎么样去提升模型的泛化能力呢','statement',None,'如何提升模型的泛化能力',True),
 ('同一批含两道题选择后一题','解释泛化能力是什么\n泛化就是在没见过的数据上仍能表现好\n那怎样提升泛化能力呢','', 'question','提升','',True),
 ('工程背景跨片段后的提问','我们用 PPO 控制机器人\n训练奖励上涨，但实测动作抖动\n怎么解决这个问题','', 'question','PPO','PPO 是什么',True),
]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--case',action='append',help='Run matching case names only; omit for the full diagnostic suite')
args=parser.parse_args()
if args.case:cases=[case for case in cases if any(part in case[0] for part in args.case)]
assert cases,'No matching test cases'
failed=[]
for case in cases:
 name,text,context,intent,term=case[:5]
 previous=case[5] if len(case)>5 else 'PPO 是什么'
 video=case[6] if len(case)>6 else False
 stable=case[7] if len(case)>7 else True
 candidate=context.split('候选人：')[-1] if '候选人：' in context else ''
 user=user_format.format('面试视频测试' if video else '远程面试','强化学习、机器人',
     previous,previous,context,candidate,'音频片段已稳定' if stable else '识别中，文字仍可能变化',text)
 body={'model':'qwen3:4b-instruct','messages':[{'role':'system','content':system},{'role':'user','content':user}],'stream':False,'think':False,'format':schema,'options':{'temperature':0,'num_predict':360}}
 with urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:11434/api/chat',data=json.dumps(body).encode(),headers={'Content-Type':'application/json'}),timeout=35) as r:v=json.load(r)
 try:d=json.loads(v['message']['content'].strip().removeprefix('```json').removesuffix('```').strip())
 except Exception:d={}
 okay=(d.get('action') in ('wait','keep') if intent=='statement' else
        d.get('intent')==intent and d.get('action') in ('show','revise')) and (not term or term.lower() in d.get('question','').lower())
 if term=='泛化':
  okay=okay and any(word in d.get('question','') for word in ['提升','提高','增强'])
 print(json.dumps({'case':name,'passed':okay,'intent':d.get('intent'),'action':d.get('action'),'question':d.get('question')},ensure_ascii=False))
 if not okay:failed.append(name)
print(json.dumps({'passed':len(cases)-len(failed),'failed':failed},ensure_ascii=False))
assert not failed,failed
