import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
const source = await readFile(new URL('../src/gateway-client.ts',import.meta.url),'utf8');
const js = ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const { GatewayClient, selectionTarget, applyEvents } = await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));

test('client IDs remain distinct UUIDs in plugin frames without randomUUID', async () => {
  const source = await readFile(new URL('../src/utils.ts', import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } });
  for (const crypto of [{}, undefined]) {
    const frame = { exports: {}, crypto };
    runInNewContext(outputText, frame);
    const ids = Array.from({ length: 64 }, () => frame.exports.makeId());
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }
});

test('a submitted task retains the explicitly bound file and selected node across selection changes and retries',async()=>{
  const selected=['1:2'];
  const target=selectionTarget('https://www.figma.com/design/Aaa/design?node-id=1-2',selected);
  selected[0]='3:4';
  const sent=[];
  const api=new GatewayClient('synthetic',async(url,request)=>{
    assert.equal(url,'http://localhost:4320/v1/tasks');
    sent.push(JSON.parse(request.body)); return Response.json({id:'task'});
  });
  const input={requestId:'one',prompt:'Update label',target};
  await api.submit(input); await api.submit(input);
  assert.deepEqual(sent,[input,input]);
  assert.deepEqual(sent[0].target,{fileKey:'Aaa',nodeIds:['1:2']});
  assert.throws(()=>selectionTarget('https://www.figma.com/design/Aaa/?node-id=1-2',selected));
});
test('replayed progress events produce a single terminal state; authentication and access errors are distinct',async()=>{
  const events=[{seq:2,status:'running',detail:''},{seq:3,status:'completed',detail:'Ready'}];
  const original={id:'one',status:'queued',detail:''};
  const first=applyEvents(original,events,0);
  assert.deepEqual(applyEvents(first.task,events,first.cursor),first);
  assert.equal(first.task.detail,'Ready');
  for (const [code,msg] of [[401,/凭据/],[403,/访问/],[404,/访问/]]) {
    const api=new GatewayClient('synthetic',async()=>new Response(null,{status:code}));
    await assert.rejects(api.history(),msg);
  }
});
