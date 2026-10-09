"""Optional local Ollama smoke test using the production prompt and JSON schema.
Run from the repository root after downloading qwen3:4b-instruct.
"""
import json,re,urllib.request
from pathlib import Path
s=(Path(__file__).resolve().parents[1]/'src-tauri/src/commands/mvp_commands.rs').read_text(encoding='utf-8')
a=s.index('    let system = "你是中文技术面试的实时任务提取器。')+len('    let system = ')
b=s.index(';\n    let user = format!',a)
raw=s[a:b];raw=re.sub(r'\\\n\s*','',raw).replace('\n','\\n')
system=json.loads(raw)
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
]
failed=[]
for name,text,context,intent,term in cases:
 candidate=context.split('候选人：')[-1] if '候选人：' in context else ''
 user=f'场景：远程面试\n术语背景（仅消歧）：强化学习、机器人\n历史辅助信息（可能已经过时，不代表最新主题）：\n上一问题：PPO 是什么\n当前显示：PPO 是什么\n最新对话（以下内容比历史辅助信息更新，保留角色）：\n{context}\n最近一次候选人回答（仅帮助确定追问指代，其中明确说出的工具或方法优先于旧题）：\n{candidate}\n本次识别状态：音频片段已稳定\n最新需要判别的转录：{text}'
 body={'model':'qwen3:4b-instruct','messages':[{'role':'system','content':system},{'role':'user','content':user}],'stream':False,'think':False,'format':schema,'options':{'temperature':0,'num_predict':360}}
 with urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:11434/api/chat',data=json.dumps(body).encode(),headers={'Content-Type':'application/json'}),timeout=35) as r:v=json.load(r)
 try:d=json.loads(v['message']['content'].strip().removeprefix('```json').removesuffix('```').strip())
 except Exception:d={}
 okay=d.get('intent')==intent and d.get('action') in ('show','revise') and (not term or term.lower() in d.get('question','').lower())
 print(json.dumps({'case':name,'passed':okay,'intent':d.get('intent'),'action':d.get('action'),'question':d.get('question')},ensure_ascii=False))
 if not okay:failed.append(name)
print(json.dumps({'passed':len(cases)-len(failed),'failed':failed},ensure_ascii=False))
assert not failed,failed
