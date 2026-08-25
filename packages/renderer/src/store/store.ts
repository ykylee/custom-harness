// 경량 상태 스토어 (WBS 1.5.1) — 외부 의존 최소화 원칙(dev-standards §3)에 따라
// 상태 라이브러리 대신 useSyncExternalStore 기반 자체 구현. 상태는 불변 갱신만.
import { useSyncExternalStore } from 'react';

export class Store<T> {
  private listeners = new Set<() => void>();

  constructor(private state: T) {}

  get = (): T => this.state;

  set = (update: Partial<T> | ((prev: T) => T)): void => {
    this.state = typeof update === 'function' ? update(this.state) : { ...this.state, ...update };
    for (const listener of this.listeners) listener();
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

/** 전체 상태 구독 — 상태 객체가 불변 갱신이라 참조 비교로 충분 */
export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
