// Proxmox VE management skill

import type { Skill } from '../types/index.js';
import axios from 'axios';
import https from 'https';
import { encode, ok, fail } from './SkillResult.js';

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

function axiosFail(action: string, e: any): string {
  if (axios.isAxiosError(e) && e.response) {
    const detail = typeof e.response.data === 'string' ? e.response.data : JSON.stringify(e.response.data);
    return encode(fail(`${action}: ${e.response.status} ${e.response.statusText} — ${detail.slice(0, 300)}`, action));
  }
  return encode(fail(`${action}: ${e?.code || ''} ${e?.message || String(e)}`.trim(), action));
}

export class ProxmoxSkill {
  getSkill(): Skill {
    return {
      id: 'proxmox',
      name: 'Proxmox VE Management',
      description: 'Manage Proxmox Virtual Environment — nodes, VMs, containers, storage, and tasks',
      category: 'infrastructure',
      enabled: true,
      commands: [
        { name: 'proxmox.nodes',      description: 'List all PVE nodes with status',                                       handler: 'listNodes' },
        { name: 'proxmox.vms',        description: 'List VMs on the default node (vmid, name, status, mem, cpu)',          handler: 'listVMs' },
        { name: 'proxmox.containers', description: 'List LXC containers on the default node',                              handler: 'listContainers' },
        { name: 'proxmox.vm-start',   description: 'Start a VM by vmid',                                                   handler: 'startVM',        parameters: { vmid: 'number' } },
        { name: 'proxmox.vm-stop',    description: 'Stop a VM by vmid',                                                    handler: 'stopVM',         parameters: { vmid: 'number' } },
        { name: 'proxmox.vm-status',  description: 'Get detailed status of a VM by vmid',                                  handler: 'vmStatus',       parameters: { vmid: 'number' } },
        { name: 'proxmox.snapshot',   description: 'Create a snapshot of a VM (vmid, snapname)',                           handler: 'createSnapshot', parameters: { vmid: 'number', snapname: 'string' } },
        { name: 'proxmox.storage',    description: 'List storage pools with usage on the default node',                    handler: 'listStorage' },
        { name: 'proxmox.tasks',      description: 'List the last 20 recent PVE tasks',                                    handler: 'listTasks' }
      ]
    };
  }

  private get baseUrl(): string | null {
    return process.env.PROXMOX_HOST || null;
  }

  private get authHeader(): string {
    const id = process.env.PROXMOX_TOKEN_ID || '';
    const secret = process.env.PROXMOX_TOKEN_SECRET || '';
    return `PVEAPIToken=${id}=${secret}`;
  }

  private get node(): string {
    return process.env.PROXMOX_NODE || 'pve';
  }

  private async api<T = unknown>(path: string): Promise<T> {
    const url = `${this.baseUrl}/api2/json${path}`;
    const response = await axios.get<{ data: T }>(url, {
      headers: { Authorization: this.authHeader },
      httpsAgent,
      timeout: 15000
    });
    return response.data.data;
  }

  private async post<T = unknown>(path: string, body: Record<string, unknown> = {}): Promise<T> {
    const url = `${this.baseUrl}/api2/json${path}`;
    const response = await axios.post<{ data: T }>(url, body, {
      headers: { Authorization: this.authHeader },
      httpsAgent,
      timeout: 15000
    });
    return response.data.data;
  }

  private notConfigured(): string {
    return encode(fail('PROXMOX_HOST not configured'));
  }

  async listNodes(): Promise<string> {
    if (!this.baseUrl) return this.notConfigured();
    try {
      const nodes = await this.api<Array<Record<string, unknown>>>('/nodes');
      return encode(ok({ nodes: nodes ?? [], count: nodes?.length ?? 0 }, `${nodes?.length ?? 0} node(s)`));
    } catch (error) {
      return axiosFail('listing nodes', error);
    }
  }

  async listVMs(params?: { node?: string }): Promise<string> {
    if (!this.baseUrl) return this.notConfigured();
    const node = params?.node || this.node;
    try {
      const vms = await this.api<Array<Record<string, unknown>>>(`/nodes/${node}/qemu`);
      const sorted = [...(vms ?? [])].sort((a, b) => Number(a['vmid']) - Number(b['vmid']));
      return encode(ok({ node, vms: sorted, count: sorted.length }, `${sorted.length} VM(s) on ${node}`));
    } catch (error) {
      return axiosFail(`listing VMs on ${node}`, error);
    }
  }

  async listContainers(params?: { node?: string }): Promise<string> {
    if (!this.baseUrl) return this.notConfigured();
    const node = params?.node || this.node;
    try {
      const cts = await this.api<Array<Record<string, unknown>>>(`/nodes/${node}/lxc`);
      const sorted = [...(cts ?? [])].sort((a, b) => Number(a['vmid']) - Number(b['vmid']));
      return encode(ok({ node, containers: sorted, count: sorted.length }, `${sorted.length} container(s) on ${node}`));
    } catch (error) {
      return axiosFail(`listing containers on ${node}`, error);
    }
  }

  async startVM(params: { vmid: number | string; node?: string }): Promise<string> {
    if (!this.baseUrl) return this.notConfigured();
    if (params?.vmid === undefined || params?.vmid === null) return encode(fail('proxmox.vm-start requires { vmid }'));
    const node = params.node || this.node;
    const { vmid } = params;
    try {
      const taskId = await this.post<string>(`/nodes/${node}/qemu/${vmid}/status/start`);
      return encode(ok({ vmid, node, taskId }, `start initiated for VM ${vmid}`));
    } catch (error) {
      return axiosFail(`starting VM ${vmid}`, error);
    }
  }

  async stopVM(params: { vmid: number | string; node?: string }): Promise<string> {
    if (!this.baseUrl) return this.notConfigured();
    if (params?.vmid === undefined || params?.vmid === null) return encode(fail('proxmox.vm-stop requires { vmid }'));
    const node = params.node || this.node;
    const { vmid } = params;
    try {
      const taskId = await this.post<string>(`/nodes/${node}/qemu/${vmid}/status/stop`);
      return encode(ok({ vmid, node, taskId }, `stop initiated for VM ${vmid}`));
    } catch (error) {
      return axiosFail(`stopping VM ${vmid}`, error);
    }
  }

  async vmStatus(params: { vmid: number | string; node?: string }): Promise<string> {
    if (!this.baseUrl) return this.notConfigured();
    if (params?.vmid === undefined || params?.vmid === null) return encode(fail('proxmox.vm-status requires { vmid }'));
    const node = params.node || this.node;
    const { vmid } = params;
    try {
      const s = await this.api<Record<string, unknown>>(`/nodes/${node}/qemu/${vmid}/status/current`);
      return encode(ok({ vmid, node, status: s }, `VM ${vmid} is ${s['status']}`));
    } catch (error) {
      return axiosFail(`getting VM ${vmid} status`, error);
    }
  }

  async createSnapshot(params: { vmid: number | string; snapname: string; node?: string; description?: string }): Promise<string> {
    if (!this.baseUrl) return this.notConfigured();
    if (params?.vmid === undefined || !params?.snapname) {
      return encode(fail('proxmox.snapshot requires { vmid, snapname }'));
    }
    const node = params.node || this.node;
    const { vmid, snapname } = params;
    try {
      const body: Record<string, unknown> = { snapname };
      if (params.description) body['description'] = params.description;
      const taskId = await this.post<string>(`/nodes/${node}/qemu/${vmid}/snapshot`, body);
      return encode(ok({ vmid, node, snapname, taskId }, `snapshot "${snapname}" initiated for VM ${vmid}`));
    } catch (error) {
      return axiosFail(`creating snapshot for VM ${vmid}`, error);
    }
  }

  async listStorage(params?: { node?: string }): Promise<string> {
    if (!this.baseUrl) return this.notConfigured();
    const node = params?.node || this.node;
    try {
      const pools = await this.api<Array<Record<string, unknown>>>(`/nodes/${node}/storage`);
      return encode(ok({ node, pools: pools ?? [], count: pools?.length ?? 0 }, `${pools?.length ?? 0} storage pool(s) on ${node}`));
    } catch (error) {
      return axiosFail(`listing storage on ${node}`, error);
    }
  }

  async listTasks(params?: { node?: string }): Promise<string> {
    if (!this.baseUrl) return this.notConfigured();
    const node = params?.node || this.node;
    try {
      const tasks = await this.api<Array<Record<string, unknown>>>(`/nodes/${node}/tasks?limit=20`);
      return encode(ok({ node, tasks: tasks ?? [], count: tasks?.length ?? 0 }, `${tasks?.length ?? 0} recent task(s) on ${node}`));
    } catch (error) {
      return axiosFail(`listing tasks on ${node}`, error);
    }
  }
}
