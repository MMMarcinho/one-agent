import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC,
  type OneAgentAPI,
  type RunEventMsg,
  type SendMessageInput,
  type StartConversationInput,
} from '../shared/ipc.js';

const api: OneAgentAPI = {
  init: (startDir) => ipcRenderer.invoke(IPC.init, startDir),
  pickDirectory: () => ipcRenderer.invoke(IPC.pickDirectory),
  listAgents: (cwd) => ipcRenderer.invoke(IPC.listAgents, cwd),
  listRequests: () => ipcRenderer.invoke(IPC.listRequests),
  getRequest: (id) => ipcRenderer.invoke(IPC.getRequest, id),
  startConversation: (input: StartConversationInput) =>
    ipcRenderer.invoke(IPC.startConversation, input),
  sendMessage: (input: SendMessageInput) => ipcRenderer.invoke(IPC.sendMessage, input),
  cancelTurn: (conversationId) => ipcRenderer.invoke(IPC.cancelTurn, conversationId),
  closeConversation: (conversationId) => ipcRenderer.invoke(IPC.closeConversation, conversationId),
  onRunEvent: (cb: (msg: RunEventMsg) => void) => {
    const listener = (_e: unknown, msg: RunEventMsg): void => cb(msg);
    ipcRenderer.on(IPC.runEvent, listener);
    return () => ipcRenderer.removeListener(IPC.runEvent, listener);
  },
};

contextBridge.exposeInMainWorld('oneAgent', api);
