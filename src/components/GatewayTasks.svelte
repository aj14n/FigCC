<script lang="ts">
  import { onDestroy } from 'svelte';
  import { makeId } from '../utils';
  import { applyEvents, GatewayClient, selectionTarget, type GatewayTask, type GatewayInput } from '../gateway-client';
  import type { SelectionContext } from './Composer.svelte';

  let { selection, capture, manuallyBoundFile = $bindable('') }: {
    selection: SelectionContext | null;
    capture: () => Promise<SelectionContext | null>;
    manuallyBoundFile: string;
  } = $props();
  let token = $state('');
  let client = $state.raw<GatewayClient | null>(null);
  let tasks = $state<GatewayTask[]>([]);
  let error = $state('');
  let link = $state(''), prompt = $state(''), documentUrl = $state(''), skill = $state('');
  let sessionId = $state('');
  let busy = $state(false);
  let pending = $state.raw<GatewayInput | null>(null);
  let oneSelected = $derived(selection?.total === 1 && selection.nodes.length === 1);
  let targetFile = $derived(selection?.fileKey || manuallyBoundFile);
  const cursors = new Map<string,number>();
  const names = {queued:'已受理',running:'执行中',completed:'已完成',failed:'失败',cancelled:'已取消',needs_confirmation:'需要核对画布'};
  let timer: ReturnType<typeof setTimeout>;
  let generation = 0;
  onDestroy(() => { generation++; clearTimeout(timer); });

  function upsert(task: GatewayTask) {
    tasks = [task,...tasks.filter(item => item.id !== task.id)];
  }
  async function poll(api: GatewayClient, gen: number) {
    if (generation !== gen) return;
    try {
      for (const task of tasks.filter(t => t.status === 'queued' || t.status === 'running')) {
        const cursor = cursors.get(task.id) ?? 0;
        const events = await api.events(task.id,cursor);
        if (gen !== generation) return;
        const current = tasks.find(t=>t.id===task.id);
        if (!current || !['queued','running'].includes(current.status)) continue;
        if (events.length) {
          const next = applyEvents(current,events,cursor);
          cursors.set(task.id,next.cursor);
          upsert(next.task);
        }
      }
    } catch (e) { if (gen === generation) error = String(e); }
    if (generation === gen) timer = setTimeout(() => { void poll(api,gen); },650);
  }
  function disconnect() {
    generation++; clearTimeout(timer); client = null; tasks = []; cursors.clear(); token = '';
    sessionId = ''; pending = null; error = ''; busy = false; prompt = ''; link = ''; documentUrl = ''; skill = '';
  }
  async function connect() {
    if (busy) return;
    busy = true; error = '';
    const gen = ++generation;
    const api = new GatewayClient(token.trim());
    try {
      const list = await api.history();
      if (generation !== gen) return;
      tasks = list; client = api; token = ''; void poll(api,gen);
    } catch(e) { if (gen === generation) error = String(e); }
    finally { if (generation === gen) busy = false; }
  }
  async function submit() {
    const api = client;
    if (!api || busy) return;
    const gen = generation;
    busy = true; error = '';
    try {
      if (!pending) {
        const selectedLink = link.trim(), text = prompt.trim(), doc = documentUrl.trim(), rule = skill.trim();
        const shownNode = selection?.nodes[0]?.id;
        const shownFile = selection?.fileKey;
        const context = await capture();
        if (generation !== gen) return;
        if (!context || context.total !== 1 || context.nodes[0]?.id !== shownNode || context.fileKey !== shownFile) {
          throw new Error('选区已变化，请确认当前图层后再发送。');
        }
        const target = selectionTarget(context.fileKey || manuallyBoundFile, context.nodes.map(n=>n.id), selectedLink);
        if (!context.fileKey) manuallyBoundFile = target.fileKey;
        link = '';
        pending = {requestId: makeId(), prompt:text, target, ...(sessionId ? {sessionId} : {}),
          ...(doc ? {documentUrl:doc} : {}), ...(rule ? {skill:rule} : {})};
      }
      const task = await api.submit(pending);
      if (generation !== gen) return;
      upsert(task); sessionId = task.sessionId; prompt = ''; pending = null;
    } catch(e) { if (generation === gen) error = String(e); }
    finally { if (generation === gen) busy = false; }
  }
  async function cancel(task: GatewayTask) {
    const gen = generation;
    try { const result = await client?.cancel(task.id); if (gen === generation && result) upsert(result); }
    catch(e) { if (gen === generation) error = String(e); }
  }
</script>

<section class="tasks">
  <small aria-live="polite">
    {#if oneSelected}
      当前选区 · {selection?.nodes[0].name}
    {:else}
      {selection?.total ? '请只选中一个图层' : '请在画布中选中要修改的图层'}
    {/if}
  </small>
  {#if oneSelected && selection?.fileKey}<small>已从 Figma 识别当前文件</small>{/if}
  {#if !client}
    <div class="entry">
      <label>本地网关凭据<input type="password" bind:value={token} autocomplete="off" /></label>
      <button type="button" onclick={connect} disabled={busy || !token.trim()}>连接网关</button>
    </div>
  {:else}
    <div class="entry">
      {#if oneSelected && !targetFile}
        <label>首次绑定文件<input bind:value={link} placeholder="粘贴当前图层的选区链接" disabled={busy || !!pending} /></label>
        <small>此环境无法读取文件标识。本次打开插件只需粘贴一次，之后直接点选图层。</small>
      {:else if manuallyBoundFile && !selection?.fileKey}
        <div class="actions"><small>已绑定文件 · {manuallyBoundFile}</small>
          <button type="button" disabled={busy || !!pending} onclick={()=>{manuallyBoundFile='';sessionId='';link='';}}>重新绑定</button>
        </div>
      {/if}
      <label>任务<textarea rows="2" bind:value={prompt} disabled={busy || !!pending}></textarea></label>
      <details><summary>文档与业务技能</summary>
        <label>文档链接<input bind:value={documentUrl} disabled={busy || !!pending} /></label>
        <label>技能名称<input bind:value={skill} disabled={busy || !!pending} /></label>
      </details>
      <div class="actions">
        <button type="button" onclick={submit} disabled={busy || (!pending && (!prompt.trim() || !oneSelected || (!targetFile && !link.trim())))}>{pending ? '重试同一任务' : sessionId ? '继续对话' : '发送任务'}</button>
        {#if pending}<button type="button" disabled={busy} onclick={()=>{pending=null;}}>放弃重试</button>{/if}
        {#if sessionId}<button type="button" disabled={busy || !!pending} onclick={()=>{sessionId='';}}>新会话</button>{/if}
        <button type="button" onclick={disconnect}>断开</button>
      </div>
    </div>
    {#each tasks as task (task.id)}
      <article>
        <strong>{task.prompt}</strong><small>{names[task.status]} · {task.target.fileKey} / {task.target.nodeIds.join(', ')}</small>
        {#if task.detail}<p>{task.detail}</p>{/if}
        {#if task.status === 'running' || task.status === 'queued'}<button onclick={()=>cancel(task)}>取消任务</button>{/if}
        {#if task.status === 'completed'}<button disabled={busy || !!pending || targetFile !== task.target.fileKey} onclick={()=>{sessionId=task.sessionId;}}>续接这段对话</button>{/if}
      </article>
    {/each}
  {/if}
  {#if error}<p role="alert">{error}</p>{/if}
</section>
<style>
  .tasks, .entry, label, article {display:grid;gap:8px;min-width:0;}
  .tasks {padding:var(--spacing-inner-padding);gap:16px;color:var(--color-text-primary);}
  label, small, summary {font-size:12px;}
  input, textarea {min-width:0;width:100%;padding:7px;color:inherit;font:inherit;background:var(--color-surface-1);border:1px solid var(--color-border-1);border-radius:var(--radius-sm);}
  button {min-height:28px;width:fit-content;padding:4px 10px;border:1px solid var(--color-border-1);border-radius:var(--radius-sm);background:var(--color-surface-2);color:inherit;cursor:pointer;}
  button:disabled {opacity:.5;} .actions {display:flex;gap:6px;flex-wrap:wrap;}
  article {border-top:1px solid var(--color-border-1);padding-top:10px;overflow-wrap:anywhere;}
  p {margin:0;white-space:pre-wrap;} small {color:var(--color-text-secondary);}
</style>
