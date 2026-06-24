import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC,
  type OneAgentAPI,
  type RunEventMsg,
  type StartRequestInput,
} from '../shared/ipc.js';

const api: OneAgentAPI = {
  init: (startDir) => ipcRenderer.invoke(IPC.init, startDir),
  pickDirectory: () => ipcRenderer.invoke(IPC.pickDirectory),
  listAgents: (cwd) => ipcRenderer.invoke(IPC.listAgents, cwd),
  listRequests: () => ipcRenderer.invoke(IPC.listRequests),
  getRequest: (id) => ipcRenderer.invoke(IPC.getRequest, id),
  startRequest: (input: StartRequestInput) => ipcRenderer.invoke(IPC.startRequest, input),
  cancelRequest: (requestId) => ipcRenderer.invoke(IPC.cancelRequest, requestId),
  onRunEvent: (cb: (msg: RunEventMsg) => void) => {
    const listener = (_e: unknown, msg: RunEventMsg): void => cb(msg);
    ipcRenderer.on(IPC.runEvent, listener);
    return () => ipcRenderer.removeListener(IPC.runEvent, listener);
  },
};

contextBridge.exposeInMainWorld('oneAgent', api);
