"""Run the production Rust harness against synthetic local Ollama fixtures.
Private API replays require a reviewed fixture and its explicitly approved hash.
No production prompt or transport is duplicated in this script.
"""
import argparse,hashlib,json,os,subprocess,time
from pathlib import Path
root=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--case',action='append',help='Filter synthetic case IDs')
p.add_argument('--model',default='qwen3:4b-instruct')
p.add_argument('--fixture',type=Path,help='Reviewed native replay fixture')
p.add_argument('--approved-sha256',help='Required for a remote fixture; obtain per-payload consent first')
a=p.parse_args();out=root/'outputs';out.mkdir(exist_ok=True);stamp=str(time.time_ns())
if a.fixture:
 file=a.fixture.resolve();fixture=json.loads(file.read_text(encoding='utf-8-sig'))
else:
 rows=json.loads((root/'evaluation/semantic-smoke.json').read_text(encoding='utf-8'));cases=[]
 for row in rows:
  if a.case and not any(s in row['id'] for s in a.case):continue
  turns=[]
  for i,line in enumerate(row.get('context','').splitlines()):
   turns.append(dict(id='h'+str(i),text=line,channel='microphone' if line.startswith('候选人：') else 'system',current=False,isFinal=True))
  turns.append(dict(id='current',text=row['currentText'],channel='system',current=True,isFinal=True))
  cases.append(dict(name=row['id'],input=dict(turns=turns,mode='live',previousQuestion=row.get('previousQuestion',''),topicBackground='',projectKnowledge=True),expected=dict(action='task' if row['expectedAction'] in ('show','revise') else 'wait')))
 if not cases:raise SystemExit('No matching cases')
 fixture=dict(api='ollama',baseUrl='http://127.0.0.1:11434',model=a.model,maxRequests=20,decisions=cases,retrieval=[],candidates=[])
 file=out/('semantic-local-'+stamp+'.json');file.write_text(json.dumps(fixture,ensure_ascii=False),encoding='utf-8')
checksum=hashlib.sha256(file.read_bytes()).hexdigest()
if fixture['api']!='ollama' and a.approved_sha256!=checksum:raise SystemExit('Remote fixture requires --approved-sha256 for this exact reviewed payload')
env={**os.environ,'MOCK_REPLAY_FILE':str(file),'MOCK_REPLAY_APPROVED_SHA256':checksum,'MOCK_REPLAY_REPORT':str(out/('semantic-report-'+stamp+'.json'))}
raise SystemExit(subprocess.call(['cargo','test','--manifest-path',str(root/'src-tauri/Cargo.toml'),'--lib','approved_dialogue_replay','--','--ignored','--nocapture'],cwd=root,env=env))
