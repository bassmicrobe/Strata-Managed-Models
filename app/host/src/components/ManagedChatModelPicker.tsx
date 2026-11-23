import { useEffect, useRef, useState } from 'react';
import { getState, go, selectRemoteModel, setSettingsSection, useStore } from '../lib/store';
import { managedModelPhase, managedModelsBusy, refreshManagedModels, switchManagedModel, type ManagedModel, type ManagedModelSettings, type ManagedModelsState } from '../lib/managed-models';
import { useLocation } from '../lib/router';
import { FloatingMenu } from './FloatingMenu';
import { Bar, Btn, Dialog, ErrorNotice, Icon } from './ui';
import './ManagedChatModelPicker.css';

const keepOpen = () => {};

/** A local opt-in picker: selecting a name also loads its optimized model on this PC. */
export function ManagedChatModelPicker({ state }: { state: ManagedModelsState }) {
    const remote = useStore(s => s.remoteModel);
    const providers = useStore(s => s.providers);
    const streaming = useStore(s => s.streaming);
    const ready = useStore(s => s.ready);
    const activeSession = useStore(s => s.activeSession);
    const location = useLocation();
    const [open, setOpen] = useState(false);
    const [pending, setPending] = useState<string | null>(null);
    const [failure, setFailure] = useState<{ id: string; detail: string; settings?: ManagedModelSettings } | null>(null);
    const [draft, setDraft] = useState<({ id: string } & ManagedModelSettings) | null>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    const appliedHint = useRef<string | null>(null);
    const mounted = useRef(true);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const connection = providers?.connections.find(item => item.id === state.connectionId);
    const selected = remote && remote.connectionId === state.connectionId ? state.models.find(model => model.modelId === remote.modelId) : undefined;
    const active = state.models.find(model => model.id === state.activeId);
    const target = state.models.find(model => model.id === (pending ?? state.targetId));
    const loading = state.switching || pending !== null;
    const blocked = streaming || managedModelsBusy(state) || pending !== null;
    const label = providers?.connections.find(item => item.id === remote?.connectionId)?.models.find(model => model.id === remote?.modelId)?.name ?? selected?.label ?? active?.label ?? 'モデルを選択';

    const configurable = state.models.filter(model => model.contextOptions?.length);
    const editing = configurable.find(model => model.id === draft?.id);
    function edit(model: ManagedModel) {
        setOpen(false);
        setDraft({ id: model.id, contextMax: model.contextMax ?? 32768, thinkingBudget: model.thinkingBudget ?? -1 });
    }

    async function choose(model: ManagedModel, settings?: ManagedModelSettings) {
        if (blocked || !state.connectionId || !connection?.models.some(item => item.id === model.modelId)) return;
        const session = getState().activeSession;
        setOpen(false);
        setFailure(null);
        setPending(model.id);
        try {
            const loaded = await switchManagedModel(model.id, settings);
            // A load is global, but the choice belongs to the chat that requested it.
            if (getState().activeSession === session) selectRemoteModel({ connectionId: loaded.connectionId!, modelId: model.modelId });
        } catch (error) {
            if (mounted.current) setFailure({ id: model.id, settings, detail: error instanceof Error ? error.message : 'Strata に接続できませんでした。' });
        } finally {
            if (mounted.current) setPending(null);
        }
    }

    const hint = location.query.get('localModel');
    useEffect(() => {
        if (!ready || !connection || streaming || loading || state.maintenance) return;
        const requested = state.models.find(model => model.id === hint);
        if (requested && appliedHint.current !== hint) {
            if (managedModelsBusy(state) || !connection.models.some(model => model.id === requested.modelId)) return;
            appliedHint.current = hint;
            // Consume the launcher hint so returning to Chat does not override a later choice.
            const query = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
            query.delete('localModel');
            window.history.replaceState(null, '', `${window.location.hash.split('?')[0]}${query.size ? `?${query}` : ''}`);
            if (state.activeId === requested.id && !state.error) selectRemoteModel({ connectionId: state.connectionId!, modelId: requested.modelId });
            else void choose(requested);
            return;
        }
        // New chats and older native chats must route through this managed provider too.
        if (!remote) {
            const initial = active ?? state.models[0];
            if (initial && connection.models.some(model => model.id === initial.modelId)) selectRemoteModel({ connectionId: state.connectionId!, modelId: initial.modelId });
        }
    }, [hint, ready, connection, streaming, loading, remote, active, activeSession, state]);

    return <>
        <button ref={trigger} className="chat-model-badge chat-model-picker" aria-label={`モデルを選択: ${label}`} title={state.switching ? managedModelPhase(state.phase) : `このチャット: ${label} · 読込中: ${active?.label ?? 'なし'}`} aria-haspopup="menu" aria-expanded={open} disabled={!connection || loading || state.maintenance} onClick={() => setOpen(value => !value)}>
            <Icon name="models" size={16}/><span>{label}</span><Icon name="chevron" size={12}/>
        </button>
        {open && <FloatingMenu anchor={trigger.current} title="このチャットのモデル" width={390} onClose={() => setOpen(false)}>
            <div className="model-picker-heading">この PC のモデル</div>
            {state.models.map(model => <button key={model.id} className="menu__item model-picker-option managed-model-option" role="menuitemradio" aria-checked={selected?.id === model.id} disabled={blocked || !connection?.models.some(item => item.id === model.modelId)} onClick={() => void choose(model)}>
                <span><strong>{model.label}</strong><small>{model.description || (model.contextMax ? `${model.contextMax / 1024}K` : '選ぶとこの PC で読み込みます')}</small></span>
                <span className="model-picker-state">{state.activeId === model.id ? '読込済み' : '未読込'}{selected?.id === model.id && <Icon name="check" size={16}/>}</span>
            </button>)}
            {configurable.length > 0 && <button className="menu__item" role="menuitem" disabled={blocked} onClick={() => edit(configurable.find(model => model.id === selected?.id) ?? configurable[0])}>モデル設定</button>}
            {providers?.connections.filter(item => item.id !== state.connectionId).map(item => <div key={item.id}>
                <p className="model-picker-heading">{item.name}</p>
                {item.models.map(model => <button key={model.id} className="menu__item model-picker-option" role="menuitemradio"
                    aria-checked={remote?.connectionId === item.id && remote.modelId === model.id} disabled={blocked}
                    onClick={() => { selectRemoteModel({ connectionId: item.id, modelId: model.id }); setOpen(false); }}>{model.name}</button>)}
            </div>)}
            <button className="menu__item" role="menuitem" onClick={() => { setOpen(false); go('models'); }}>保存済みGGUFを追加・管理</button>
            <button className="menu__item" role="menuitem" onClick={() => { setOpen(false); setSettingsSection('Models'); go('settings'); }}>モデルAPIを管理</button>
            <p className="model-picker-empty" role="status">{blocked ? '回答・読み込みの完了後に切り替えられます。' : '選択するとモデルを読み込みます。チャットの内容はそのままです。'}</p>
            {state.error && <p className="model-picker-empty inline-error" role="alert">前回の読み込みに失敗しました。モデルを選び直して再試行できます。</p>}
            {state.connectionError && <p className="model-picker-empty inline-error" role="alert">Strata に接続できません。接続を確認しています。</p>}
        </FloatingMenu>}
        <Dialog open={!!draft} title="モデル設定" onClose={() => setDraft(null)} compact
            actions={<><Btn variant="ghost" onClick={() => setDraft(null)}>キャンセル</Btn><Btn disabled={blocked || !editing} onClick={() => { if (editing && draft) { setDraft(null); void choose(editing, { contextMax: draft.contextMax, thinkingBudget: draft.thinkingBudget }); } }}>適用して読み込む</Btn></>}>
            {editing && draft && <div className="managed-model-settings">
                <label>モデル<select value={editing.id} onChange={e => { const model = configurable.find(row => row.id === e.target.value); if (model) edit(model); }}>
                    {configurable.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
                </select></label>
                <label>コンテキスト長<select value={draft.contextMax} onChange={e => setDraft({ ...draft, contextMax: Number(e.target.value) })}>
                    {editing.contextOptions?.map(value => <option key={value} value={value}>{value / 1024}K</option>)}
                </select></label>
                <label>思考予算<select value={draft.thinkingBudget} onChange={e => setDraft({ ...draft, thinkingBudget: Number(e.target.value) })}>
                    {editing.thinkingBudgetOptions?.map(value => <option key={value} value={value}>{value === -1 ? 'エンジン既定' : value.toLocaleString('ja-JP') + ' トークン'}</option>)}
                </select></label>
                <p className="small muted">設定はモデルごとに保存されます。適用すると保存済みファイルからモデルを読み込みます。</p>
            </div>}
        </Dialog>
        <Dialog open={!!state.maintenance && !loading} title="Strataを更新しています" onClose={keepOpen} noClose compact>
            <div className="managed-model-loading" role="status" aria-live="polite">
                <Bar value={0} indeterminate label="Strataの更新"/>
                <p className="small muted">完了すると自動で戻ります。チャットの内容は保持されます。</p>
            </div>
        </Dialog>
        <Dialog open={loading} title="モデルを切り替えています" onClose={keepOpen} noClose compact>
            <div className="managed-model-loading" role="status" aria-live="polite">
                <strong>{target?.label ?? state.models.find(model => model.id === pending)?.label ?? '選択したモデル'}</strong>
                <p>{pending && !state.switching ? 'モデルの切り替えを開始しています' : managedModelPhase(state.phase)}</p>
                <Bar value={0} indeterminate label="モデルの読み込み"/>
                <p className="small muted">準備ができるまでお待ちください。チャットの内容は保持されます。</p>
                {state.connectionError && <><p className="small inline-error">Strata への接続を確認しています。</p><Btn size="sm" onClick={() => void refreshManagedModels()}>接続を再確認</Btn></>}
            </div>
        </Dialog>
        <Dialog open={!!failure && !loading && !state.maintenance} title="モデルを切り替えられませんでした" onClose={() => setFailure(null)} compact actions={<><Btn variant="ghost" onClick={() => setFailure(null)}>閉じる</Btn><Btn disabled={blocked} onClick={() => { const model = state.models.find(item => item.id === failure?.id); if (model) void choose(model, failure?.settings); }}>もう一度試す</Btn></>}>
            <ErrorNotice message="モデルの読み込みに失敗しました。もう一度お試しください。" detail={failure?.detail}/>
        </Dialog>
    </>;
}
