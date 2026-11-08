import { useSyncExternalStore } from 'react';

/** Optional, host-managed local models. Hosts without this feature keep the ordinary picker. */
export interface ManagedModel {
    id: string;
    label: string;
    modelId: string;
    description?: string;
    contextMax?: number;
    vision?: boolean;
}

export interface ManagedModelsState {
    enabled: boolean;
    connectionId?: string;
    models: ManagedModel[];
    activeId: string | null;
    targetId: string | null;
    switching: boolean;
    phase: string;
    error: string | null;
    activeRequests: number;
    queuedRequests?: number;
    maintenance?: boolean;
    /** A transient connection failure does not erase the last known running model. */
    connectionError?: string;
}

const BASE = (globalThis as { __STRATA_HOST__?: string }).__STRATA_HOST__ ?? '';
const POLL_MS = 1750;
const SWITCH_TIMEOUT_MS = 660_000;
const disabled: ManagedModelsState = { enabled: false, models: [], activeId: null, targetId: null, switching: false, phase: '', error: null, activeRequests: 0 };
let state: ManagedModelsState | null = null;
let reading: Promise<ManagedModelsState | null> | null = null;
let generation = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function put(next: ManagedModelsState) {
    if (JSON.stringify(state) === JSON.stringify(next)) return;
    state = next;
    listeners.forEach(listener => listener());
}

async function request(method: 'GET' | 'POST', id?: string): Promise<ManagedModelsState> {
    const response = await fetch(`${BASE}/api/managed-models${method === 'POST' ? '/switch' : ''}`, {
        method,
        headers: method === 'POST' ? { 'content-type': 'application/json', 'x-strata-client': 'managed-model-picker' } : undefined,
        body: method === 'POST' ? JSON.stringify({ id }) : undefined,
        signal: AbortSignal.timeout(20_000),
    });
    if (method === 'GET' && response.status === 404) return disabled;
    const value = await response.json() as ManagedModelsState & { error?: string | null };
    if (!response.ok) {
        throw new Error(response.status === 409
            ? '回答中または別のモデルを読み込み中です。完了してからもう一度お試しください。'
            : value.error || 'Strata に接続できませんでした。しばらくしてからもう一度お試しください。');
    }
    if (typeof value.enabled !== 'boolean' || !Array.isArray(value.models)) throw new Error('モデルの状態を確認できませんでした。');
    return value;
}

/** Every consumer shares this read and the same poller, including the switch waiter. */
export function refreshManagedModels(): Promise<ManagedModelsState | null> {
    if (reading) return reading;
    const before = generation;
    reading = request('GET').then(next => {
        if (before === generation) put(next);
        return state;
    }).catch(error => {
        if (before === generation && state?.enabled) put({ ...state, connectionError: error instanceof Error ? error.message : 'Strata に接続できませんでした。' });
        return state;
    }).finally(() => { reading = null; });
    return reading;
}

function schedule() {
    clearTimeout(timer);
    timer = undefined;
    if (!listeners.size || state?.enabled === false) return;
    timer = setTimeout(() => { void refreshManagedModels().finally(schedule); }, POLL_MS);
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    if (listeners.size === 1) void refreshManagedModels().finally(schedule);
    return () => {
        listeners.delete(listener);
        if (!listeners.size) { clearTimeout(timer); timer = undefined; }
    };
}

export function useManagedModels() {
    return useSyncExternalStore(subscribe, () => state, () => null);
}

export function managedModelsBusy(value: ManagedModelsState): boolean {
    return !!value.maintenance || value.switching || value.activeRequests > 0 || (value.queuedRequests ?? 0) > 0;
}

export function managedModelPhase(phase: string): string {
    switch (phase) {
        case 'checking': return 'モデルの状態を確認しています';
        case 'stopping': return '現在のモデルを終了しています';
        case 'starting':
        case 'loading': return 'モデルを読み込んでいます';
        case 'ready': return 'モデルの準備ができました';
        case 'error': return 'モデルを読み込めませんでした';
        default: return 'モデルを切り替えています';
    }
}

/** The POST starts the real host operation; readiness comes only from the host's health check. */
export async function switchManagedModel(id: string): Promise<ManagedModelsState> {
    generation++;
    const accepted = await request('POST', id);
    put(accepted);
    return new Promise<ManagedModelsState>((resolve, reject) => {
        let unsubscribe = () => {};
        let limit: ReturnType<typeof setTimeout> | undefined;
        const finish = (error?: Error) => {
            clearTimeout(limit);
            unsubscribe();
            if (error) reject(error);
            else resolve(state!);
        };
        const check = () => {
            if (!state || state.switching) return;
            if (state.enabled && state.activeId === id && !state.error) finish();
            else finish(new Error(state.error || '選択したモデルの準備を確認できませんでした。もう一度お試しください。'));
        };
        unsubscribe = subscribe(check);
        limit = setTimeout(() => finish(new Error('読み込みの完了を確認できませんでした。モデルの状態を確認して、もう一度お試しください。')), SWITCH_TIMEOUT_MS);
        check();
        schedule();
    });
}
