import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isSelfIntroductionRequest} from '../src/selfIntroduction.ts';

test('direct introduction requests route to the saved draft; related technical and how-to questions do not',()=>{
 for(const text of ['请你先做个简单的自我介绍','你好，请介绍一下你自己。','首先，你先做一下自我介绍吧','自我介绍','请简要自我介绍一下','可以简单自我介绍一下吗','Please introduce yourself.','Could you give a brief self-introduction?'])
  assert.equal(isSelfIntroductionRequest(text),true,text);
 for(const text of ['如何写自我介绍','请帮我写一份自我介绍','自我介绍里提到的 PPO 原理是什么','先解释 PPO，再进行自我介绍','请介绍 PPO','我刚才做了自我介绍','请你先做个简单的自我介绍并解释注意力公式',''])
  assert.equal(isSelfIntroductionRequest(text),false,text);
});
