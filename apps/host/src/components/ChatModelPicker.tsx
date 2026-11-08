import { tr } from '../lib/i18n';
import { modelFamilyIcon } from '../lib/model-icons';
import { useEffect, useId, useRef, useState } from 'react';
import { FloatingMenu } from './FloatingMenu';
import { Bar, Btn, Dialog, ErrorNotice, Icon } from './ui';
import { getState, go, useLifecycle, loadVariant, selectRemoteModel, setSettingsSection, useStore } from '../lib/store';
import { pickerGroups, pickerNativeModels, pickerVersionState } from '../lib/model-picker';
import { versionFit } from '../lib/model-versions';
import type { ModelVariant } from '../lib/types';
import { sizeGb } from '../lib/format';
import { contextTokens } from '../lib/experience';
import { nativeAction, nativeState, subscribeNative, useNative, type NativeJob } from '../lib/native';
import { nativePickerLoadRequest, nativePickerModels, waitForNativePickerModel, type NativePickerModel } from '../lib/native-picker';
import { useManagedModels } from '../lib/managed-models';
import { ManagedChatModelPicker } from './ManagedChatModelPicker';
/** The loaded model is shared by all chats; switching uses the existing lifecycle gates. */
export function ChatModelPicker() {
    const native = useNative();
    const managed = useManagedModels();
    if (managed?.enabled) return <ManagedChatModelPicker state={managed}/>;
    return native?.available || native?.instances.length || native?.installed?.models.length ? <NativeChatModelPicker /> : <LegacyChatModelPicker />;
}
function NativeChatModelPicker() {
    const native = useNative(), providers = useStore(s => s.providers), remote = useStore(s => s.remoteModel);
    const lifecycle = useLifecycle();
    const [open, setOpen] = useState(false), [error, setError] = useState('');
    const [pending, setPending] = useState<{ model: string; label: string; jobId?: string } | null>(null);
    const ref = useRef<HTMLButtonElement>(null);
    const mounted = useRef(true);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const current = native?.instances.find(i => i.id === native.defaultId);
    const apiConnection = providers?.connections.find(connection => connection.id === remote?.connectionId);
    const apiModel = apiConnection?.models.find(model => model.id === remote?.modelId);
    const label = apiModel?.name ?? current?.label ?? tr('No model loaded');
    const rows = nativePickerModels(native?.installed?.models, native?.instances);
    const loadingJob = pending?.jobId ? native?.jobs.find(job => job.id === pending.jobId) : undefined;
    const operationRunning = native?.jobs.some(job => job.state === 'running') ?? false;
    const blocked = !lifecycle.allowed || operationRunning || pending !== null;

    async function choose(model: NativePickerModel) {
        if (blocked || !native?.available || !['installed', 'ready'].includes(model.status)) return;
        const session = getState().activeSession;
        setOpen(false); setError(''); setPending({ model: model.model, label: model.label });
        try {
            let instanceId = model.instanceId;
            if (!instanceId) {
                const job = await nativeAction<NativeJob>('operations', nativePickerLoadRequest(model.model));
                if (mounted.current) setPending({ model: model.model, label: model.label, jobId: job.id });
                instanceId = (await waitForNativePickerModel(job, model.model, { read: nativeState, subscribe: subscribeNative })).id;
            }
            if (nativeState()?.defaultId !== instanceId) await nativeAction(`instances/${instanceId}/default`);
            if (mounted.current) setError('');
            if (getState().activeSession === session) selectRemoteModel(null);
        } catch (failure) {
            if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure));
        } finally { if (mounted.current) setPending(null); }
    }
    return <>
        <button className="chat-model-badge chat-model-picker" ref={ref} aria-label={tr('Choose model: {0}', [label])} aria-haspopup="menu" aria-expanded={open} disabled={pending !== null} onClick={() => setOpen(value => !value)}><Icon name={apiModel ? 'link' : 'models'} size={16}/><span>{tr(label)}</span><Icon name="chevron" size={12}/></button>
        {open && <FloatingMenu anchor={ref.current} title={tr('Chat model')} width={380} onClose={() => setOpen(false)}>
            <p className="model-picker-heading">{tr('Local models')}</p>
            {rows.map(model => <button className="menu__item model-picker-option" role="menuitemradio" aria-checked={!!model.instanceId && !remote && current?.id === model.instanceId} disabled={blocked || !native?.available || !['installed', 'ready'].includes(model.status)} key={model.key} onClick={() => void choose(model)}>
                <span><strong>{tr(model.label)}</strong><small>{tr(model.status === 'installed' ? 'Downloaded' : model.status === 'ready' ? 'Ready' : model.status === 'loading' ? 'Loading…' : 'Unloading…')}{model.context ? ` · ${Math.round(model.context / 1024)}K` : ''}</small></span>
                {!!model.instanceId && !remote && current?.id === model.instanceId && <Icon name="check" size={16} className="menu__check"/>}
            </button>)}
            {!rows.length && <p className="model-picker-empty">{tr('No local models downloaded yet.')}</p>}
            {providers?.connections.map(connection => <div key={connection.id}><p className="model-picker-heading">{connection.name}</p>{connection.models.map(model => <button className="menu__item model-picker-option model-picker-api" role="menuitemradio" aria-checked={remote?.connectionId === connection.id && remote.modelId === model.id} disabled={blocked} key={model.id} onClick={() => { selectRemoteModel({ connectionId: connection.id, modelId: model.id }); setOpen(false); }}><span><strong>{model.name}</strong><small>{model.id}</small></span>{remote?.connectionId === connection.id && remote.modelId === model.id && <Icon name="check" size={16}/>}</button>)}</div>)}
            {blocked && <p className="model-picker-empty" role="status">{tr(lifecycle.reason || 'Wait for the current operation to finish.')}</p>}
            <button className="menu__item" role="menuitem" onClick={() => { setOpen(false); go('models'); }}><Icon name="plus"/>{tr('Manage models')}</button>
            <button className="menu__item" role="menuitem" onClick={() => { setOpen(false); setSettingsSection('Models'); go('settings'); }}><Icon name="link"/>{tr('Manage API models')}</button>
        </FloatingMenu>}
        <Dialog open={pending !== null} title={tr('Loading model')} noClose compact onClose={() => {}} actions={loadingJob?.state === 'running' ? <Btn variant="ghost" onClick={() => void nativeAction(`operations/${loadingJob.id}/cancel`).catch(failure => setError(failure.message))}>{tr('Cancel')}</Btn> : undefined}>
            <div className="stack stack--sm" role="status" aria-live="polite"><strong>{pending?.label}</strong><Bar value={0} indeterminate label={tr(loadingJob?.summary || 'Loading model')}/>{error && <ErrorNotice message={error}/>}<p className="small muted">{tr('Your conversations stay saved.')}</p></div>
        </Dialog>
        <Dialog open={!!error && !pending} title={tr('Model could not load')} compact onClose={() => setError('')} actions={<Btn onClick={() => setError('')}>{tr('Close')}</Btn>}><ErrorNotice message={error}/></Dialog>
    </>;
}
function LegacyChatModelPicker() {
    const native = useNative();
    const library = useStore(s => s.library), hardware = useStore(s => s.hardware), engine = useStore(s => s.engine);
    const providers = useStore(s => s.providers), remote = useStore(s => s.remoteModel), streaming = useStore(s => s.streaming);
    const connection = providers?.connections.find(c => c.id === remote?.connectionId);
    const apiModel = connection?.models.find(m => m.id === remote?.modelId);
    const lifecycle = useLifecycle();
    const [open, setOpen] = useState(false), [selected, setSelected] = useState<string | null>(null);
    const [pending, setPending] = useState(false), [error, setError] = useState('');
    const [expanded, setExpanded] = useState<string[]>([]);
    const groupsId = useId();
    const trigger = useRef<HTMLButtonElement>(null);
    const running = library?.variants.find(v => v.id === library.loaded);
    const version = library?.variants.find(v => v.id === selected);
    const groups = library ? pickerGroups(library) : [];
    const installedNative = pickerNativeModels(native?.installed?.models, native?.instances);
    const status = version ? pickerVersionState(version, library?.loaded ?? null) : null;
    const tooBig = !!version && library?.mode === 'real' && versionFit(version, hardware, contextTokens(engine?.beginner.contextLength ?? '32K')).zone === 'too-big';
    async function apply() {
        if (!version)
            return;
        setPending(true);
        setError('');
        try {
            const success = await loadVariant(version.id);
            if (!success)
                throw new Error('The version could not load. Try again when the engine is ready.');
            selectRemoteModel(null);
            setSelected(null);
        }
        catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
        finally {
            setPending(false);
        }
    }
    function chooseVersion(v: ModelVariant) {
        setOpen(false);
        if (pickerVersionState(v, library?.loaded ?? null).running)
            selectRemoteModel(null);
        else {
            setSelected(v.id);
            setError('');
        }
    }
    function versionOption(v: ModelVariant) {
        const state = pickerVersionState(v, library?.loaded ?? null);
        return <button key={v.id} role="menuitemradio" disabled={streaming || state.busy} aria-checked={state.running && !apiModel} className="menu__item model-picker-option" onClick={() => chooseVersion(v)}>
      <span><strong>{tr(v.name)}</strong><span className="model-picker-spec"> · {tr(v.quant)} · {tr(sizeGb(v.diskGb))}</span></span>
      <span className="model-picker-state">{tr(state.label)}</span>
    </button>;
    }
    return <>
    <button ref={trigger} className="chat-model-badge chat-model-picker" aria-label={tr("Choose model: {0}", [apiModel?.name ?? (running?.local ? running.name : running?.family) ?? 'No model loaded'])} title={tr(apiModel ? `${connection?.name} · ${apiModel.id}` : 'View and switch models')} disabled={!library && !providers} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(v => !v)}><Icon name={apiModel ? 'link' : modelFamilyIcon(running?.family ?? groups[0]?.family)} size={16}/><span>{tr(apiModel?.name ?? (running?.local ? running.name : running?.family) ?? groups[0]?.family ?? 'No model loaded')}</span><Icon name="chevron" size={12}/></button>
    {tr(open ? <FloatingMenu anchor={trigger.current} title={tr("Models")} width={380} onClose={() => setOpen(false)}>
      {tr(native?.instances.filter(i => i.status !== 'error').map(i => <button key={i.id} className="menu__item" role="menuitem" disabled={streaming || i.status !== 'ready'} onClick={() => void nativeAction(`instances/${i.id}/default`).then(() => { selectRemoteModel(null); setOpen(false); }).catch(e => setError(e.message))}><Icon name="models"/><span>{tr(i.label)}<small>{tr(i.gpus.map(g => `GPU ${g + 1}`).join(" + ") || "Automatic GPU")}</small></span></button>))}<p className="model-picker-heading">{tr("Local models")}</p>
      {tr(installedNative.map(m => <button key={m.config || m.model} className="menu__item model-picker-option model-picker-api" role="menuitem" disabled={streaming} onClick={() => { setOpen(false); go('models'); }}><span><strong>{tr(m.model_name || m.model)}</strong><small>{tr("Downloaded, not loaded. Open Models to load it.")}</small></span></button>))}
      {tr(!groups.length && !installedNative.length ? <p className="model-picker-empty">{tr("No local models downloaded yet.")}</p> : null)}
      {tr(groups.map(({ family, versions }, index) => {
                const main = versions[0], state = pickerVersionState(main, library!.loaded);
                const others = versions.slice(1), isExpanded = expanded.includes(family), id = `${groupsId}-${index}`;
                return <div key={family} role="group" aria-label={tr(family)} className="model-picker-group">
          <div className="model-picker-family-row">
            <button role="menuitemradio" disabled={streaming || state.busy} aria-checked={state.running && !apiModel} className="menu__item model-picker-family" onClick={() => chooseVersion(main)}>
              <Icon name={modelFamilyIcon(family)} size={20}/>
              <span className="model-picker-family-copy"><strong>{tr(family)}</strong><small><span>{tr(main.name)}</span><span>{tr(main.quant)} · {tr(sizeGb(main.diskGb))}</span></small></span>
              <span className="model-picker-state">{tr(state.running && !apiModel ? <Icon name="check" size={14}/> : null)}{tr(state.label)}</span>
            </button>
            {tr(others.length ? <button role="menuitem" className="menu__item model-picker-expand" aria-label={tr("Downloaded versions for {0}", [family])} aria-expanded={isExpanded} aria-controls={isExpanded ? id : undefined} onClick={() => setExpanded(current => isExpanded ? current.filter(f => f !== family) : [...current, family])}><Icon name="chevron" size={14}/></button> : null)}
          </div>
          {tr(isExpanded && others.length ? <div id={id} className="model-picker-versions">{tr(others.map(versionOption))}</div> : null)}
        </div>;
            }))}
      {tr(providers?.connections.map(c => <div key={c.id}><p className="model-picker-heading">{c.name}</p>{tr(c.models.map(m => <button key={m.id} role="menuitemradio" disabled={streaming} aria-checked={remote?.connectionId === c.id && remote.modelId === m.id} className="menu__item model-picker-option model-picker-api" onClick={() => { selectRemoteModel({ connectionId: c.id, modelId: m.id }); setOpen(false); }}><span><strong>{m.name}</strong><small>{tr(m.id)}</small></span><span className="model-picker-state">{tr(remote?.connectionId === c.id && remote.modelId === m.id ? <Icon name="check" size={15}/> : 'API')}</span></button>))}</div>))}
      <button role="menuitem" className="menu__item model-picker-manage" onClick={() => { setOpen(false); setSettingsSection('Models'); go('settings'); }}><Icon name="plus" size={16}/>{tr("Manage API models")}</button>
    </FloatingMenu> : null)}
    <Dialog open={!!version} compact title={tr(status?.busy ? `${status.label} ${version?.name}` : `Switch to ${version?.name}?`)} onClose={() => !pending && setSelected(null)} actions={<><Btn disabled={pending} onClick={() => setSelected(null)}>{tr("Cancel")}</Btn><Btn variant="primary" disabled={pending || status?.busy || !status?.installed || tooBig || !lifecycle.allowed} onClick={() => void apply()}>{tr(pending ? 'Working…' : status?.busy ? status.label : status?.action)}</Btn></>}>
      {tr(version ? <div className="stack stack--sm"><p><strong>{tr(version.family)}</strong><br /><span className="small muted">{tr(version.name)} · {tr(version.quant)} · {tr(sizeGb(version.diskGb))}</span></p>
        <p className="small">{tr("This switches the model version for all chats. Your conversations stay saved.")}</p>
        {tr(status?.busy ? <Bar value={version.progress?.pct ?? 0} label={tr(version.progress?.stage ?? status.label)}/> : null)}
        {tr(tooBig ? <p className="small inline-error">{tr("This version needs more memory at the current context. Choose a smaller version or reduce context in Engine.")}</p> : null)}
        {tr(!lifecycle.allowed ? <p className="small muted">{tr(lifecycle.reason)}</p> : null)}
        {tr(error || version.error ? <ErrorNotice message={error || version.error!}/> : null)}
      </div> : null)}
    </Dialog>
  </>;
}
