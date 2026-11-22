import { useEffect, useState } from 'react';
import { api } from '../lib/client';
import { tr } from '../lib/i18n';
import { Btn, ErrorNotice } from './ui';

const fields = (model: string) => `/api/native/models/${encodeURIComponent(model)}/settings`;
type Settings = { values: { reasoning_budget_tokens?: number } };

export function NativeThinkingBudget({ model, disabled }: { model: string; disabled: boolean }) {
    const [saved, setSaved] = useState<string | null>(null);
    const [budget, setBudget] = useState('');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState(false);
    useEffect(() => {
        let current = true;
        void api.get<Settings>(fields(model)).then(result => {
            if (!current) return;
            const value = String(result.values.reasoning_budget_tokens ?? '');
            setSaved(value);
            setBudget(value);
        }).catch(error => { if (current) setError(error.message); });
        return () => { current = false; };
    }, [model]);

    async function save() {
        setSaving(true);
        setError('');
        setNotice(false);
        try {
            await api.patch(fields(model), { values: { reasoning_budget_tokens: budget === '' ? null : Number(budget) } });
            setSaved(budget);
            setNotice(true);
        } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
        finally { setSaving(false); }
    }
    const valid = budget === '' || /^\d+$/.test(budget) && Number(budget) <= 1048576;
    return <div className="native-choice__col">
        <label className="input-field">
            <span>{tr('Thinking budget')}</span>
            <input className="st-input" type="number" min={0} max={1048576} step={1} value={budget}
                placeholder={tr('Leave blank for the model default.')} disabled={disabled || saving || saved === null}
                onChange={event => { setBudget(event.target.value); setNotice(false); }}/>
        </label>
        <Btn size="sm" disabled={disabled || saving || saved === null || !valid || budget === saved} onClick={() => void save()}>{tr('Save')}</Btn>
        {notice && <p className="small muted" role="status">{tr('Saved. Load the model again to apply these settings. A backup of the previous configuration was kept.')}</p>}
        {error && <ErrorNotice message={error}/>}
    </div>;
}
