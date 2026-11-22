import type { NativeInstance, NativeJob, NativeState } from './native';

type InstalledModel = NonNullable<NativeState['installed']>['models'][number];
export interface NativePickerModel {
    key: string;
    model: string;
    label: string;
    status: 'installed' | NativeInstance['status'];
    instanceId?: string;
    context?: number;
}

/** Model IDs are the identity: two different models can have the same display name. */
export function nativePickerModels(installed: InstalledModel[] | null | undefined, instances: NativeInstance[] | null | undefined): NativePickerModel[] {
    const running = (instances ?? []).filter(instance => instance.status !== 'error');
    const runningModels = new Set(running.map(instance => instance.model));
    const result: NativePickerModel[] = running.map(instance => ({ key: `instance:${instance.id}`, model: instance.model, label: instance.label, status: instance.status, instanceId: instance.id, context: instance.context }));
    const seen = new Set<string>();
    for (const model of installed ?? []) {
        if (!model.ready || runningModels.has(model.model) || seen.has(model.model)) continue;
        seen.add(model.model);
        result.push({ key: `installed:${model.model}`, model: model.model, label: model.model_name || model.model, status: 'installed', context: model.context });
    }
    return result;
}

/** The ordinary Models screen's load operation; leave every saved tuning value alone. */
export function nativePickerLoadRequest(model: string) {
    if (!/^[a-z0-9](?:[a-z0-9_-]|\.(?!\.)){0,79}$/i.test(model)) throw new Error('Choose an installed model.');
    return { kind: 'load', args: { model, multiple: false } };
}

/** A load response only starts a job. The chat choice changes after the job and instance are ready. */
export function waitForNativePickerModel(job: NativeJob, model: string, io: { read: () => NativeState | null; subscribe: (changed: () => void) => () => void; timeoutMs?: number }): Promise<NativeInstance> {
    return new Promise((resolve, reject) => {
        let unsubscribe = () => {};
        let timer: ReturnType<typeof setTimeout> | undefined;
        let finished = false;
        const finish = (instance?: NativeInstance, failure?: string) => {
            if (finished) return;
            finished = true; clearTimeout(timer); unsubscribe();
            if (instance) resolve(instance);
            else reject(new Error(failure || 'The model could not be loaded. Open Models to check its status.'));
        };
        const check = () => {
            const state = io.read(), current = state?.jobs.find(value => value.id === job.id) ?? job;
            if (current.state === 'error' || current.state === 'cancelled') { finish(undefined, current.error || current.summary); return; }
            if (current.state !== 'done') return;
            const instance = state?.instances.find(value => value.model === model && value.status === 'ready' && (!current.result?.instanceId || value.id === current.result.instanceId));
            if (instance) finish(instance);
        };
        unsubscribe = io.subscribe(check);
        timer = setTimeout(() => finish(undefined, 'Model loading has not finished. Open Models to check its status.'), io.timeoutMs ?? 90 * 60 * 1000);
        check();
    });
}
