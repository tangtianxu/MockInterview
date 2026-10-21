// Business-flow fixtures can answer in-app requests without rendering a picker.
// The actual action strip/picker and window visibility have a separate UI test.
import {subscribeActions,currentAction,finishAction} from '../../src/inAppActions.ts';
export function mockActionResponses(handler){
 return subscribeActions(()=>{const action=currentAction();if(!action)return;queueMicrotask(async()=>{if(currentAction()?.id!==action.id)return;finishAction(action.id,await handler(action.kind,action.options,action.message));});});
}
