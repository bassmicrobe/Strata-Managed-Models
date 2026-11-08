import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transform} from 'esbuild';

const {code}=await transform(await readFile(new URL('../src/lib/native-picker.ts',import.meta.url),'utf8'),{loader:'ts',format:'esm'});
const {nativePickerModels,nativePickerLoadRequest,waitForNativePickerModel}=await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const instance=(id,model,label,status='ready')=>({id,model,label,status,context:8192});
const installed=(model,model_name,ready=true)=>({model,model_name,ready,config:`strata-${model}.json`,context:32768});

test('added/downloaded native models remain in the picker beside running models and do not deduplicate by display name',()=>{
    const models=[installed('first','Same name'),installed('second','Same name'),installed('third','User model'),installed('partial','Partial files',false)];
    const running=[instance('running-first','first','Renamed by user'),instance('second-copy','first','Second loaded instance'),instance('failed','third','User model','error')];
    const before=structuredClone({models,running});
    assert.deepEqual(nativePickerModels(models,running).map(row=>[row.key,row.model,row.label,row.status]),[
        ['instance:running-first','first','Renamed by user','ready'],['instance:second-copy','first','Second loaded instance','ready'],['installed:second','second','Same name','installed'],['installed:third','third','User model','installed'],
    ]);
    assert.deepEqual({models,running},before);
    assert.deepEqual(nativePickerModels([installed('second','Same name')],[]).map(row=>row.model),['second']);
    assert.deepEqual(nativePickerModels(undefined,null),[]);
});

test('a downloaded model uses its saved native load configuration and a single-model lifecycle',()=>{
    assert.deepEqual(nativePickerLoadRequest('my-qwen-v4.1'),{kind:'load',args:{model:'my-qwen-v4.1',multiple:false}});
    for(const id of ['', '../outside', 'not a model', '.hidden', 'file..name'])assert.throws(()=>nativePickerLoadRequest(id));
});

function observer(initial){let state=initial,changed;return{read:()=>state,subscribe:fn=>{changed=fn;return()=>{changed=undefined;};},update:next=>{state=next;changed?.();},subscribed:()=>!!changed};}
const job=(state='running',extra={})=>({id:'load-picked',state,kind:'load',summary:'Loading',error:null,result:null,...extra});

test('a started job cannot select a chat model until the matching target instance is ready',async()=>{
    const live=observer({jobs:[job()],instances:[instance('old','old','Previously running')]});
    let selected=false;
    const waiting=waitForNativePickerModel(job(),'picked',live).then(value=>{selected=true;return value;});
    live.update({jobs:[job('done',{result:{instanceId:'picked-instance'}})],instances:[instance('picked-instance','picked','Picked','loading')]});
    await Promise.resolve();assert.equal(selected,false);
    live.update({jobs:[job('done',{result:{instanceId:'picked-instance'}})],instances:[instance('other-instance','picked','Another copy')]});
    await Promise.resolve();assert.equal(selected,false);
    live.update({jobs:[job('done',{result:{instanceId:'picked-instance'}})],instances:[instance('picked-instance','picked','Picked')]});
    assert.equal((await waiting).id,'picked-instance');assert.equal(selected,true);assert.equal(live.subscribed(),false);
});

test('job errors, cancellation and readiness timeouts preserve failure instead of claiming the model is loaded',async()=>{
    for(const state of ['error','cancelled']){
        const live=observer({jobs:[job()],instances:[]});const waiting=waitForNativePickerModel(job(),'picked',live);
        live.update({jobs:[job(state,{error:'Could not fit on this GPU'})],instances:[]});
        await assert.rejects(waiting,/Could not fit/);assert.equal(live.subscribed(),false);
    }
    const live=observer({jobs:[job('done',{result:{instanceId:'missing'}})],instances:[]});
    await assert.rejects(waitForNativePickerModel(job(),'picked',{...live,timeoutMs:5}),/has not finished/);assert.equal(live.subscribed(),false);
});
