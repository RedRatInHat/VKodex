import assert from 'node:assert/strict';
import {createProjection, applyNotification, resolvePermissions, projectNativeServerRequest, resolveNativeServerRequest, preserveNativeRequestItems, type NativeProjectionState} from '../src/codex/managed-native-projection.js';

function findTurn(state: NativeProjectionState, turnId: string): NativeProjectionState['turns'][number] {
  const turn = state.turns.find(value => value.turnId === turnId);
  assert.ok(turn);
  return turn;
}

const id='12345678-1234-4234-8234-123456789abc';
const start={
  thread:{id,turns:[],createdAt:100,updatedAt:101,sessionId:id,cwd:'C:\\Temp\\fresh',status:{type:'idle'}},
  cwd:'C:\\Temp\\fresh',model:'gpt-6-sol',reasoningEffort:'medium',
  approvalPolicy:'never',sandbox:{type:'dangerFullAccess'},activePermissionProfile:null,
  runtimeWorkspaceRoots:[],serviceTier:null
};
const read={thread:{
  id,sessionId:id,createdAt:100,updatedAt:102,recencyAt:102,name:'Acceptance',cwd:'C:\\Temp\\fresh',
  status:{type:'idle'},originator:'codex_cli',source:'cli',historyMode:'full',turns:[{
    id:'turn-1',startedAt:101,completedAt:102,durationMs:1000,status:'completed',error:null,items:[
      {id:'user-1',type:'userMessage',content:[{type:'text',text:'hello'}],clientId:'op-1'},
      {id:'tool-1',type:'commandExecution',command:'pwd',status:'completed',aggregatedOutput:'C:\\Temp\\fresh'},
      {id:'agent-1',type:'agentMessage',text:'Hi',phase:'final_answer'}
    ]
  }]
}};
const startBefore=structuredClone(start), readBefore=structuredClone(read);
const state=createProjection(start,read,{hostId:'local',workspaceKind:'projectless'});
assert.equal(state.id,id);
assert.equal(state.resumeState,'resumed');
assert.equal(state.title,'Acceptance');
assert.equal(state.createdAt,100000);
assert.equal(state.latestModel,'gpt-6-sol');
assert.equal(state.currentPermissions.approvalPolicy,'never');
assert.equal(state.turns[0]!.params.input[0]!.text,'hello');
assert.deepEqual(state.turns[0]!.items[1]!,read.thread.turns[0]!.items[1]!);
assert.deepEqual(start,startBefore); assert.deepEqual(read,readBefore);

const started=applyNotification(state,{method:'turn/started',params:{threadId:id,turn:{id:'turn-2',startedAt:103,status:'inProgress',items:[]}}});
// A later full Turn payload is allowed to carry the original user message.
// Its input/client correlation must be refreshed without adding a second item.
const fullUserInput=[{type:'text',text:'VKODEX_NATIVE_UI_OK',text_elements:[]}];
const startedWithFullUser=applyNotification(started,{method:'turn/started',params:{threadId:id,turn:{id:'turn-2',startedAt:103,status:'inProgress',itemsView:'full',items:[{id:'user-2',type:'userMessage',content:fullUserInput,clientId:'operation-2'}]}}});
assert.deepEqual(startedWithFullUser.turns[1]!.params.input,fullUserInput);
assert.equal(startedWithFullUser.turns[1]!.params.clientUserMessageId,'operation-2');
assert.equal(startedWithFullUser.turns[1]!.items.filter(value=>value.id==='user-2').length,1);
fullUserInput[0]!.text='mutated outside projection';
assert.equal(startedWithFullUser.turns[1]!.params.input[0]!.text,'VKODEX_NATIVE_UI_OK');

// Summary/notLoaded are not authoritative transcript replacements.  They must
// leave the full user message and its correlation intact, while later item
// notifications still apply normally.
const afterSummary=applyNotification(startedWithFullUser,{method:'turn/started',params:{threadId:id,turn:{id:'turn-2',status:'inProgress',itemsView:'summary',items:[{id:'agent-summary',type:'agentMessage',text:'summary only',phase:'commentary'}]}}});
assert.deepEqual(afterSummary.turns[1]!.items,startedWithFullUser.turns[1]!.items);
assert.deepEqual(afterSummary.turns[1]!.params.input,startedWithFullUser.turns[1]!.params.input);
const afterNotLoaded=applyNotification(afterSummary,{method:'turn/started',params:{threadId:id,turn:{id:'turn-2',status:'inProgress',itemsView:'notLoaded',items:[]}}});
assert.deepEqual(afterNotLoaded.turns[1]!.items,startedWithFullUser.turns[1]!.items);
assert.equal(afterNotLoaded.turns[1]!.params.clientUserMessageId,'operation-2');
const afterPartialThenItem=applyNotification(afterNotLoaded,{method:'item/completed',params:{threadId:id,turnId:'turn-2',item:{id:'agent-2',type:'agentMessage',text:'native item event',phase:'final_answer'}}});
assert.deepEqual(afterPartialThenItem.turns[1]!.items.map(value=>value.id),['user-2','agent-2']);
const afterFullEmpty=applyNotification(startedWithFullUser,{method:'turn/started',params:{threadId:id,turn:{id:'turn-2',status:'inProgress',itemsView:'full',items:[]}}});
assert.deepEqual(afterFullEmpty.turns[1]!.items,[]);
assert.deepEqual(afterFullEmpty.turns[1]!.params.input,[]);
assert.equal(afterFullEmpty.turns[1]!.params.clientUserMessageId,null);
assert.throws(()=>applyNotification(started,{method:'item/completed',params:{threadId:id,turnId:'turn-2',item:{id:'bad-client-id',type:'userMessage',content:[{type:'text',text:'x',text_elements:[]}],clientId:42}}}),/userMessage.clientId/);
const item=applyNotification(started,{method:'item/started',params:{threadId:id,turnId:'turn-2',startedAtMs:103500,item:{id:'agent-2',type:'agentMessage',text:'',phase:'commentary'}}});
const delta=applyNotification(item,{method:'item/agentMessage/delta',params:{threadId:id,turnId:'turn-2',itemId:'agent-2',delta:'Working'}});
const completedItem=applyNotification(delta,{method:'item/completed',params:{threadId:id,turnId:'turn-2',item:{id:'agent-2',type:'agentMessage',text:'Working done',phase:'final_answer'}}});
const ended=applyNotification(completedItem,{method:'turn/completed',params:{threadId:id,turn:{id:'turn-2',status:'completed',completedAt:104,durationMs:1000,items:[]}}});
const withTools=applyNotification(started,{method:'item/started',params:{threadId:id,turnId:'turn-2',item:{id:'tool-2',type:'commandExecution',command:'pwd',status:'inProgress',aggregatedOutput:''}}});
const output=applyNotification(withTools,{method:'item/commandExecution/outputDelta',params:{threadId:id,turnId:'turn-2',itemId:'tool-2',delta:'C:\\Temp'}});
assert.equal(output.turns[1]!.items[0]!.aggregatedOutput,'C:\\Temp');
const withReasoning=applyNotification(started,{method:'item/started',params:{threadId:id,turnId:'turn-2',item:{id:'reason-2',type:'reasoning',summary:[],content:[]}}});
const reasoning=applyNotification(withReasoning,{method:'item/reasoning/summaryTextDelta',params:{threadId:id,turnId:'turn-2',itemId:'reason-2',summaryIndex:0,delta:'thinking'}});
assert.equal((reasoning.turns[1]!.items[0]!.summary as string[])[0],'thinking');
const withPlan=applyNotification(started,{method:'item/started',params:{threadId:id,turnId:'turn-2',item:{id:'plan-2',type:'plan',text:''}}});
const plan=applyNotification(withPlan,{method:'item/plan/delta',params:{threadId:id,turnId:'turn-2',itemId:'plan-2',delta:'step'}});
assert.equal(plan.turns[1]!.items[0]!.text,'step');
assert.equal(ended.turns[1]!.items[0]!.text,'Working done');
assert.equal(ended.turns[1]!.status,'completed');
assert.equal(item.turns[1]!.items[0]!.text,'');
assert.equal(state.turns.length,1);
// A native collaboration tool call is transcript data. It must not retire the
// observer when another agent starts or completes a turn in the same task.
const collabStarted={id:'collab-2',type:'collabAgentToolCall',tool:'spawn_agent',status:'inProgress',
  senderThreadId:id,receiverThreadIds:['child-1'],details:{task:'inspect'}};
const collabHistory=createProjection(start,{thread:{...read.thread,turns:[{...read.thread.turns[0]!,
  items:[...read.thread.turns[0]!.items,collabStarted]}]}},{hostId:'local',workspaceKind:'projectless'});
assert.deepEqual(findTurn(collabHistory,'turn-1').items.at(-1),collabStarted);
const collabLive=applyNotification(started,{method:'item/started',params:{threadId:id,turnId:'turn-2',item:collabStarted}});
assert.deepEqual(findTurn(collabLive,'turn-2').items[0],collabStarted);
const collabCompleted={...collabStarted,status:'completed'};
const collabDone=applyNotification(collabLive,{method:'item/completed',params:{threadId:id,turnId:'turn-2',item:collabCompleted}});
assert.deepEqual(findTurn(collabDone,'turn-2').items[0],collabCompleted);
assert.deepEqual(findTurn(collabLive,'turn-2').items[0],collabStarted);
collabDone.turns[1]!.items[0]!.details={task:'mutated'};
assert.deepEqual(collabStarted.details,{task:'inspect'});
assert.throws(()=>createProjection(start,{thread:{...read.thread,turns:[{...read.thread.turns[0]!,items:[{id:'bad',type:'imageGeneration',result:'x'}]}]}},{hostId:'local',workspaceKind:'projectless'}),/special item mapping/);
assert.equal(applyNotification(state,{method:'item/agentMessage/delta',params:{threadId:'wrong',turnId:'turn-1',itemId:'agent-1',delta:'x'}}),state);
assert.equal(applyNotification(state,{method:'mcpServer/startupStatus/updated',params:{threadId:id,name:'test',status:'ready'}}),state);
// Goal metadata is delivered outside the conversation transcript. A goal
// started by another native client must not kill this task's turn observer.
const goalUpdated=applyNotification(started,{method:'thread/goal/updated',params:{threadId:id,
  goal:{objective:'inspect',status:'active'}}});
assert.equal(goalUpdated.goalSignalRevision,1);
assert.deepEqual(goalUpdated.turns,started.turns);
assert.equal(applyNotification(goalUpdated,{method:'thread/goal/cleared',params:{threadId:id}}).goalSignalRevision,2);
assert.equal(applyNotification(started,{method:'thread/goal/updated',params:{threadId:'other',
  goal:{objective:'foreign',status:'active'}}}),started);
assert.equal(applyNotification(state,{method:'warning',params:{threadId:id,message:'isolated warning'}}),state);
assert.throws(()=>applyNotification(state,{method:'warning',params:{threadId:id,message:42}}),/warning message/);
const usageBreakdown={totalTokens:12,inputTokens:9,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:3,reasoningOutputTokens:1};
const usage={total:usageBreakdown,last:{...usageBreakdown},modelContextWindow:1000};
const usageEvent={method:'thread/tokenUsage/updated',params:{threadId:id,turnId:'turn-2',tokenUsage:usage}};
const withUsage=applyNotification(withReasoning,usageEvent);
assert.deepEqual(withUsage.latestTokenUsageInfo,usage);
assert.equal(withReasoning.latestTokenUsageInfo,null);
withUsage.latestTokenUsageInfo.total.totalTokens=99;
assert.equal(usage.total.totalTokens,12);
assert.equal(applyNotification(withReasoning,{...usageEvent,params:{...usageEvent.params,threadId:'other'}}),withReasoning);
assert.throws(()=>applyNotification(withReasoning,{...usageEvent,params:{...usageEvent.params,tokenUsage:null}}),/token usage/);
const summaryPart={method:'item/reasoning/summaryPartAdded',params:{threadId:id,turnId:'turn-2',itemId:'reason-2',summaryIndex:0}};
assert.equal(applyNotification(withReasoning,summaryPart),withReasoning);
assert.throws(()=>applyNotification(withReasoning,{...summaryPart,params:{...summaryPart.params,summaryIndex:-1}}),/summary part/);
const mode = (model: string) => ({mode:'default',settings:{model,reasoning_effort:'medium',developer_instructions:null}});
const settingsBefore = {...ended,latestCollaborationMode:mode('model-a'),pendingDisabledPluginIds:['x']};
const newSettings = {...state.latestThreadSettings,model:'model-b',modelProvider:'provider',cwd:'C:/new',effort:'high',collaborationMode:mode('model-b'),disabledPluginIds:['x']};
const settingsUpdated=applyNotification(settingsBefore,{method:'thread/settings/updated',params:{threadId:id,threadSettings:newSettings}});
assert.deepEqual(settingsUpdated.latestThreadSettings,newSettings);
assert.equal(settingsUpdated.latestModel,'model-b'); assert.equal(settingsUpdated.modelProvider,'provider');
assert.equal(settingsUpdated.latestReasoningEffort,'high'); assert.equal(settingsUpdated.cwd,'C:/new');
assert.equal(settingsUpdated.previousTurnModel,'model-a');
assert.equal(Object.hasOwn(settingsUpdated,'pendingDisabledPluginIds'),false);
assert.deepEqual(settingsUpdated.currentPermissions,settingsBefore.currentPermissions);
assert.equal(settingsUpdated.updatedAt,settingsBefore.updatedAt);
const restoredSettings=applyNotification(settingsUpdated,{method:'thread/settings/updated',params:{threadId:id,threadSettings:{...newSettings,model:'model-a',collaborationMode:mode('model-a')}}});
assert.equal(restoredSettings.previousTurnModel,null);
settingsUpdated.latestThreadSettings.collaborationMode.settings.model='mutated';
assert.equal(newSettings.collaborationMode.settings.model,'model-b');
assert.throws(()=>applyNotification(state,{method:'unknown/method',params:{threadId:id}}),/unsupported notification/);
assert.deepEqual(resolvePermissions(start,{activePermissionProfile:{id:':danger-full-access'},sandboxPolicy:{type:'dangerFullAccess'}}),{activePermissionProfile:{id:':danger-full-access'},sandboxPolicy:{type:'dangerFullAccess'}});
console.log('native-gateway-projection pure assertions: pass');




// Pending native server requests use the raw typed RPC id.  They are projection
// state only here: no approval, answer, or App Server reply is invented.
const activeForRequest = started;
const userRequest: { id: string | number; method: string; params: { threadId: string; turnId: string; itemId: string; questions: Record<string, unknown>[] } } = { id: 7, method: 'item/tool/requestUserInput', params: { threadId: id, turnId: 'turn-2', itemId: 'tool-request',
  questions: [{ id: 'question-1', header: 'Choose', isSecret: true, isOther: true, options: [{ description: 'safe', label: 'Safe', ignored: true }], question: 'Proceed?', ignored: true }] } };
const userBefore = structuredClone(userRequest);
const projectedUserRequest = projectNativeServerRequest(activeForRequest, userRequest);
assert.equal(activeForRequest.requests.length, 0);
assert.equal(projectedUserRequest.hasUnreadTurn, true);
assert.deepEqual(projectedUserRequest.requests, [userBefore]);
assert.notEqual(projectedUserRequest.requests[0]!, userRequest);
assert.deepEqual(findTurn(projectedUserRequest, 'turn-2').items.at(-1)!, {
  id: 'user-input-response-7', type: 'userInputResponse', requestId: 7, turnId: 'turn-2',
  questions: [{ id: 'question-1', header: 'Choose', options: [{ description: 'safe', label: 'Safe' }], question: 'Proceed?' }],
  answers: {}, completed: false,
});
projectedUserRequest.requests[0]!.params.questions[0]!.question = 'mutated';
assert.deepEqual(userRequest, userBefore);
const duplicateUserRequest = projectNativeServerRequest(projectNativeServerRequest(activeForRequest, userRequest), structuredClone(userRequest));
assert.deepEqual(duplicateUserRequest, projectNativeServerRequest(activeForRequest, userRequest));
const conflictingUserRequest = structuredClone(userRequest); conflictingUserRequest.params.questions[0]!.isSecret = false;
assert.throws(() => projectNativeServerRequest(projectNativeServerRequest(activeForRequest, userRequest), conflictingUserRequest));
const numericThenStringCollision = structuredClone(userRequest); numericThenStringCollision.id = '7';
assert.throws(() => projectNativeServerRequest(projectNativeServerRequest(activeForRequest, userRequest), numericThenStringCollision));
const afterCollision = projectNativeServerRequest(activeForRequest, userRequest);
assert.deepEqual(afterCollision.requests, [userBefore]);
assert.equal(findTurn(afterCollision, 'turn-2').items.filter(item => item.id === 'user-input-response-7').length, 1);

// Native request transcript identity is scoped to its carrier turn. Numeric
// 0 and string '0' keep distinct raw RPC identity even though their derived
// UI item IDs coincide, so complete-history reconciliation must not flatten
// collisions across turns.
const numericZero = structuredClone(userRequest); numericZero.id = 0; numericZero.params.turnId = 'turn-1'; numericZero.params.itemId = 'turn-1-source';
const stringZero = structuredClone(userRequest); stringZero.id = '0'; stringZero.params.turnId = 'turn-2'; stringZero.params.itemId = 'turn-2-source';
const twoTurnPending = projectNativeServerRequest(projectNativeServerRequest(activeForRequest, numericZero), stringZero);
const twoTurnHistory = structuredClone(twoTurnPending);
for (const turn of twoTurnHistory.turns) turn.items = turn.items.filter(item => item.type !== 'userInputResponse');
const preservedTwoTurnRequests = preserveNativeRequestItems(twoTurnPending, twoTurnHistory);
for (const [turnId, requestId] of [['turn-1', 0], ['turn-2', '0']] as const) {
  const item = findTurn(preservedTwoTurnRequests, turnId).items.find(value => value.id === 'user-input-response-0');
  assert.ok(item);
  assert.equal(item.requestId, requestId);
}

const permissionRequest = { id: 'permission-1', method: 'item/permissions/requestApproval', params: { threadId: id, turnId: 'turn-2', itemId: 'permission-source',
  reason: 'workspace write', permissions: { network: { enabled: false }, fileSystem: { read: ['C:/isolated'], write: null } } } };
const projectedPermission = projectNativeServerRequest(activeForRequest, permissionRequest);
assert.deepEqual(findTurn(projectedPermission, 'turn-2').items.at(-1)!, {
  id: 'permission-request-permission-1', type: 'permissionRequest', requestId: 'permission-1', turnId: 'turn-2',
  reason: 'workspace write', permissions: { network: { enabled: false }, fileSystem: { read: ['C:/isolated'], write: null } }, completed: false, response: null,
});
const permissionWithoutReason = structuredClone(permissionRequest); permissionWithoutReason.id = 'permission-no-reason'; delete (permissionWithoutReason.params as {reason?: string}).reason;
const noReasonItem = findTurn(projectNativeServerRequest(activeForRequest, permissionWithoutReason), 'turn-2').items.at(-1)!;
assert.equal(Object.hasOwn(noReasonItem, 'reason'), true); assert.equal(noReasonItem.reason, undefined);
const resolvedPermission = resolveNativeServerRequest(projectedPermission, { threadId: id, requestId: 'permission-1' });
assert.equal(resolvedPermission.requests.length, 0);
assert.deepEqual(findTurn(resolvedPermission, 'turn-2').items.at(-1)!, {
  id: 'permission-request-permission-1', type: 'permissionRequest', requestId: 'permission-1', turnId: 'turn-2',
  reason: 'workspace write', permissions: { network: { enabled: false }, fileSystem: { read: ['C:/isolated'], write: null } }, completed: true, response: null,
});
const resolvedUser = resolveNativeServerRequest(projectNativeServerRequest(activeForRequest, userRequest), { threadId: id, requestId: 7 });
assert.equal(resolvedUser.requests.length, 0);
assert.deepEqual(findTurn(resolvedUser, 'turn-2').items.at(-1)!.answers, {});
assert.equal(findTurn(resolvedUser, 'turn-2').items.at(-1)!.completed, true);

// Full App Server Turn item lists refresh native items but do not carry local
// request transcript items created from server-origin requests.
const bothRequests = projectNativeServerRequest(projectNativeServerRequest(activeForRequest, userRequest), permissionRequest);
const fullRequestTurn = { method: 'turn/started', params: { threadId: id, turn: { id: 'turn-2',
  status: 'inProgress', itemsView: 'full', items: [{ id: 'fresh-user', type: 'userMessage',
    content: [{ type: 'text', text: 'PUBLIC_REFRESH', text_elements: [] }], clientId: 'refresh-op' }] } } };
const pendingAfterFull = applyNotification(bothRequests, fullRequestTurn);
const requestItems = (state: NativeProjectionState) => findTurn(state, 'turn-2').items
  .filter(item => item.type === 'userInputResponse' || item.type === 'permissionRequest');
assert.deepEqual(requestItems(pendingAfterFull), requestItems(bothRequests));
assert.deepEqual(requestItems(applyNotification(pendingAfterFull, fullRequestTurn)), requestItems(bothRequests));
assert.equal(findTurn(pendingAfterFull, 'turn-2').params.clientUserMessageId, 'refresh-op');
const itemAfterFull = applyNotification(pendingAfterFull, { method: 'item/completed', params: { threadId: id,
  turnId: 'turn-2', item: { id: 'fresh-user', type: 'userMessage',
    content: [{ type: 'text', text: 'PUBLIC_REFRESH_EDIT', text_elements: [] }], clientId: 'refresh-op' } } });
assert.equal(findTurn(itemAfterFull, 'turn-2').params.clientUserMessageId, 'refresh-op');
assert.equal(findTurn(itemAfterFull, 'turn-2').params.input[0]!.text, 'PUBLIC_REFRESH_EDIT');
assert.deepEqual(requestItems(itemAfterFull), requestItems(bothRequests));
const bothResolved = resolveNativeServerRequest(resolveNativeServerRequest(bothRequests,
  { threadId: id, requestId: 7 }), { threadId: id, requestId: 'permission-1' });
const resolvedAfterFull = applyNotification(bothResolved, { ...fullRequestTurn,
  method: 'turn/completed', params: { ...fullRequestTurn.params,
    turn: { ...fullRequestTurn.params.turn, status: 'completed' } } });
assert.deepEqual(requestItems(resolvedAfterFull), requestItems(bothResolved));
const completedUserRequest = requestItems(resolvedAfterFull).find(item => item.type === 'userInputResponse');
const completedPermissionRequest = requestItems(resolvedAfterFull).find(item => item.type === 'permissionRequest');
assert.ok(completedUserRequest); assert.ok(completedPermissionRequest);
assert.equal((completedUserRequest.answers as Record<string, unknown>)['question-1'], undefined);
assert.equal(completedPermissionRequest.response, null);

assert.equal(resolveNativeServerRequest(resolvedUser, { threadId: id, requestId: 7 }), resolvedUser);
assert.equal(resolveNativeServerRequest(resolvedUser, { threadId: 'foreign', requestId: 7 }), resolvedUser);
assert.equal(resolveNativeServerRequest(projectNativeServerRequest(activeForRequest, userRequest), { threadId: id, requestId: '7' }).requests.length, 1);

for (const request of [
  { ...userRequest, id: null }, { ...userRequest, id: {} }, { ...userRequest, method: 'item/unknown/request' },
  { ...userRequest, params: { ...userRequest.params, threadId: 'foreign' } },
]) assert.throws(() => projectNativeServerRequest(activeForRequest, request));
const nullOptions = structuredClone(userRequest); nullOptions.id = 'null-options'; nullOptions.params.questions[0]!.options = null;
assert.deepEqual((findTurn(projectNativeServerRequest(activeForRequest, nullOptions), 'turn-2').items.at(-1)!.questions as Record<string, unknown>[])[0]!.options, []);
const missingTurn = structuredClone(userRequest); missingTurn.id = 'missing-turn-request'; missingTurn.params.turnId = 'missing-turn';
const pendingMissingTurn = projectNativeServerRequest(activeForRequest, missingTurn);
assert.deepEqual(pendingMissingTurn.requests, [missingTurn]);
assert.deepEqual(pendingMissingTurn.turns, activeForRequest.turns);
assert.equal(pendingMissingTurn.hasUnreadTurn, true);
for (const method of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval']) {
  const pending = projectNativeServerRequest(activeForRequest, { id: method, method, params: { threadId: id, turnId: 'turn-2', itemId: 'source', approvalId: 'approval-sub-id', isBlocking: true } });
  assert.equal(pending.requests.length, 1);
  assert.equal(findTurn(pending, 'turn-2').items.length, findTurn(activeForRequest, 'turn-2').items.length);
}




const emptyStringIdentity = structuredClone(userRequest); emptyStringIdentity.id = ''; emptyStringIdentity.params.questions[0]!.id = '';
const projectedEmptyStringIdentity = projectNativeServerRequest(activeForRequest, emptyStringIdentity);
assert.equal(projectedEmptyStringIdentity.requests[0]!.id, '');
assert.equal(findTurn(projectedEmptyStringIdentity, 'turn-2').items.at(-1)!.requestId, '');
assert.equal((findTurn(projectedEmptyStringIdentity, 'turn-2').items.at(-1)!.questions as Record<string, unknown>[])[0]!.id, '');
const malformedQuestions = [
  null,
  [{ id: 'q', header: 'H', question: 'Q', isSecret: 'false', isOther: false, options: [] }],
  [{ id: 'q', header: 'H', question: 'Q', isSecret: false, isOther: null, options: [] }],
  [{ id: 'q', header: 'H', question: 'Q', isSecret: false, isOther: false, options: [{ description: 'd' }] }],
];
for (const questions of malformedQuestions) {
  const malformed = structuredClone(userRequest); malformed.id = `bad-question-${String(questions)}`; malformed.params.questions = questions as Record<string, unknown>[];
  assert.throws(() => projectNativeServerRequest(activeForRequest, malformed));
}
const permissionIsolation = projectNativeServerRequest(activeForRequest, permissionRequest);
(permissionIsolation.requests[0]!.params.permissions as { network: { enabled: boolean } }).network.enabled = true;
(findTurn(permissionIsolation, 'turn-2').items.at(-1)!.permissions as { fileSystem: { read: string[] } }).fileSystem.read[0] = 'C:/mutated';
assert.deepEqual(permissionRequest.params.permissions, { network: { enabled: false }, fileSystem: { read: ['C:/isolated'], write: null } });
const commandNumeric = { id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: id, turnId: 'turn-2', itemId: 'command-7' } };
const commandString = { ...structuredClone(commandNumeric), id: '7', params: { ...commandNumeric.params, itemId: 'command-string-7' } };
const typedCommandRequests = projectNativeServerRequest(projectNativeServerRequest(activeForRequest, commandNumeric), commandString);
assert.deepEqual(typedCommandRequests.requests.map(request => request.id), [7, '7']);
assert.equal(findTurn(typedCommandRequests, 'turn-2').items.length, findTurn(activeForRequest, 'turn-2').items.length);


const pendingResolvedNotification = projectNativeServerRequest(activeForRequest, userRequest);
const resolvedByNotification = applyNotification(pendingResolvedNotification, { method: 'serverRequest/resolved', params: { threadId: id, requestId: 7 } });
assert.deepEqual(resolvedByNotification, resolveNativeServerRequest(pendingResolvedNotification, { threadId: id, requestId: 7 }));
assert.equal(applyNotification(resolvedByNotification, { method: 'serverRequest/resolved', params: { threadId: id, requestId: 7 } }), resolvedByNotification);
