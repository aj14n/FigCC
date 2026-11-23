export type GatewayTarget = { fileKey: string; nodeIds: string[] };
export type GatewayInput = {
  requestId: string; prompt: string; target: GatewayTarget; sessionId?: string; documentUrl?: string; skill?: string;
};
export type GatewayStatus = 'queued'|'running'|'completed'|'failed'|'cancelled'|'needs_confirmation';
export type GatewayTask = {id: string; sessionId: string; status: GatewayStatus; detail: string; target: GatewayTarget; prompt: string};
export type GatewayEvent = {seq: number; status: GatewayStatus; detail: string};

export function selectionTarget(link: string, selected: readonly string[]): GatewayTarget {
  const url = new URL(link);
  const match = /^\/(?:design|file)\/([A-Za-z0-9]+)(?:\/|$)/.exec(url.pathname);
  const nodeId = (url.searchParams.get('node-id') ?? '').replace(/^(\d+)-(\d+)$/, '$1:$2');
  if (url.protocol !== 'https:' || !['figma.com','www.figma.com'].includes(url.host) ||
      url.username || url.password || !match || !/^\d+:\d+$/.test(nodeId)) {
    throw new Error('请粘贴 Figma 的「复制选区链接」。');
  }
  if (selected.length !== 1 || selected[0] !== nodeId) throw new Error('请选中链接对应的单个图层，再发送任务。');
  return {fileKey: match[1], nodeIds: [nodeId]};
}
export class GatewayClient {
  private token: string;
  private transport: typeof fetch;
  constructor(token: string, transport: typeof fetch = fetch) {
    this.token = token;
    this.transport = transport;
  }
  private async request<T>(path: string, method = 'GET', body?: GatewayInput): Promise<T> {
    const headers: Record<string,string> = {Authorization:'Bearer ' + this.token};
    if (body) headers['Content-Type'] = 'application/json';
    const send = this.transport;
    const response = await send('http://127.0.0.1:4320/v1/tasks' + path, {
      method, headers, redirect:'error', credentials:'omit', cache:'no-store',
      ...(body ? {body:JSON.stringify(body)} : {})
    });
    if (!response.ok) {
      if (response.status === 401) throw new Error('请重新连接并提供有效的网关凭据。');
      if (response.status === 403 || response.status === 404) throw new Error('当前账号无法访问此任务。');
      if (response.status === 409) throw new Error('任务或文件发生冲突，请检查目标并开始新会话。');
      throw new Error('网关请求失败（' + response.status + '）。');
    }
    return response.json() as Promise<T>;
  }
  history() { return this.request<GatewayTask[]>(''); }
  submit(input: GatewayInput) { return this.request<GatewayTask>('','POST',input); }
  events(id: string, after: number) { return this.request<GatewayEvent[]>('/'+encodeURIComponent(id)+'/events?after='+after); }
  cancel(id: string) { return this.request<GatewayTask>('/'+encodeURIComponent(id)+'/cancel','POST'); }
}
export function applyEvents(task: GatewayTask, events: GatewayEvent[], cursor: number) {
  let latest = task;
  for (const event of events) {
    if (event.seq <= cursor) continue;
    latest = {...latest,status:event.status, detail:event.detail};
    cursor = event.seq;
  }
  return {task:latest,cursor};
}
