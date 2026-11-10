// 高频进度状态的外部订阅源（性能优化 + 节点状态徽标共用）。
// IPC onProgress 每次计算可能推送数十条消息；若存放在 App state，每条进度都会重渲染
// 整棵组件树（功能区、全部节点卡片、视口外壳）。这里用模块级 store + useSyncExternalStore，
// 让每条进度只重渲染「状态栏」与「对应节点的徽标」。
import { useSyncExternalStore } from 'react';

const status = { message: '正在连接本地建模内核…', nodeStates: {} };
const listeners = new Set();

function emit() { for (const listener of listeners) listener(); }
function subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }

// 写入进度消息：相同文案不触发订阅者刷新，减少无意义渲染。
export function setMessage(message) {
  if (status.message === message) return;
  status.message = message; emit();
}
// 写入节点状态表：支持函数式更新，便于按需合并单节点状态。
export function setNodeStates(updater) {
  status.nodeStates = typeof updater === 'function' ? updater(status.nodeStates) : updater;
  emit();
}
export function mergeNodeStates(patch) { setNodeStates(old => ({ ...old, ...patch })); }
export function clearNodeStates() { setNodeStates({}); }

// React 订阅入口：getSnapshot 返回原始字符串/原始状态值，引用稳定，
// 未变化的订阅者不会重渲染（useSyncExternalStore 会做 Object.is 比较）。
export function useStatusMessage() { return useSyncExternalStore(subscribe, () => status.message); }
export function useNodeState(id) { return useSyncExternalStore(subscribe, () => status.nodeStates[id]); }
