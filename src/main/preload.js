'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (arg) => ipcRenderer.invoke(channel, arg);

function on(channel) {
  return (fn) => {
    const handler = (_e, payload) => fn(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  };
}

contextBridge.exposeInMainWorld('crew', {
  init: invoke('app:init'),
  openExternal: invoke('shell:open'),

  addConnection: invoke('conn:add'),
  quickstart: invoke('conn:quickstart'),
  updateConnection: invoke('conn:update'),
  removeConnection: invoke('conn:remove'),
  toggleModel: invoke('conn:toggleModel'),
  refreshConnection: invoke('conn:refresh'),
  testConnection: invoke('conn:test'),

  updateSettings: invoke('settings:update'),
  regenerateApiKey: invoke('api:regenerateKey'),
  routerStatus: invoke('router:status'),
  clearCooldowns: invoke('router:clearCooldowns'),

  listConversations: invoke('conv:list'),
  getConversation: invoke('conv:get'),
  deleteConversation: invoke('conv:delete'),
  renameConversation: invoke('conv:rename'),
  exportConversation: invoke('conv:export'),

  send: invoke('chat:send'),
  cancel: invoke('chat:cancel'),

  onChatEvent: on('chat:event'),
  onRouterEvent: on('router:event'),
  onApiStatus: on('api:status'),
});
