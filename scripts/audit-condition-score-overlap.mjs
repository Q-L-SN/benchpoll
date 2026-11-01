#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { auditConditionScoreOverlap } from '../condition-score-overlap.js';
import { semanticDifferences } from '../condition-overlap-merge-plan.js';

const [input, output, planPath] = process.argv.slice(2);
if (!input || !output || process.argv.length > 5) throw new Error('Usage: node scripts/audit-condition-score-overlap.mjs <snapshot.json.gz> <output-prefix> [confirmed-merge-plan.json]');
const context = planPath ? JSON.parse(await readFile(planPath, 'utf8')) : {};
const confirmedMergeGroups = context.groups ?? [];
if (!Array.isArray(confirmedMergeGroups)) throw new Error('Confirmed merge plan must contain groups');
const bytes = await readFile(input);
const snapshot = JSON.parse(input.endsWith('.gz') ? gunzipSync(bytes).toString('utf8') : bytes.toString('utf8'));
let lastProgress = Date.now();
const report = auditConditionScoreOverlap(snapshot, { confirmedMergeGroups, onProgress: progress => {
    if (Date.now() - lastProgress < 5000) return;
    console.log(JSON.stringify(progress));
    lastProgress = Date.now();
} });
report.snapshotSHA256 = createHash('sha256').update(bytes).digest('hex');
if (context.execution) {
    if (context.execution.applied !== true) throw new Error('Only committed execution records can label a report as applied');
    report.execution = context.execution;
    report.appliedGroups = context.appliedGroups ?? [];
}
const conditionsByID = new Map(report.conditions.map(c => [Number(c.ID), c]));
for (const pair of report.pairs) pair.semanticDifferences = semanticDifferences(
    ...pair.conditionIDs.map(id => conditionsByID.get(id)));
report.summary.thresholdWithSemanticDifferences = report.pairs.filter(p => p.exactThresholdMet && p.semanticDifferences.length).length;
await mkdir(dirname(output), { recursive: true });
await writeFile(`${output}.json`, JSON.stringify(report, null, 2));
await writeFile(`${output}.html`, renderHTML(report));
console.log(JSON.stringify({ ...report.summary, json: `${output}.json`, html: `${output}.html` }, null, 2));

function renderHTML(report) {
    const referenced = new Set(report.pairs.flatMap(pair => [...pair.exact.flat(), ...pair.rounding.flatMap(item => [item.precise, item.rounded])]));
    const data = { ...report, samples: Object.fromEntries([...referenced].map(index => [index, report.samples[index]])) };
    const json = JSON.stringify(data).replaceAll('<', '\\u003c');
    return `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>BenchPoll 测试条件重复与取整核对</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#fafbfc;color:#202832;font:14px/1.65 system-ui,sans-serif;letter-spacing:0}header,main{max-width:1280px;margin:auto;padding:24px}h1{font-size:25px;line-height:1.3;margin:0 0 12px}p{margin:8px 0;color:#526170}.controls{position:sticky;top:0;background:#fafbfc;z-index:1;border-block:1px solid #dce2e8;padding:12px 0;display:flex;gap:12px;flex-wrap:wrap;align-items:center}input,select,button{font:inherit;border:1px solid #ccd4dd;border-radius:5px;background:white;color:inherit;padding:7px 10px}input{flex:1;min-width:180px}button{cursor:pointer}button:disabled{opacity:.4;cursor:default}.pair{border-bottom:1px solid #dce2e8;padding:18px 0}.pair h2{font-size:17px;margin:0 0 8px}.conditions{display:grid;grid-template-columns:1fr 1fr;gap:16px}.condition{overflow-wrap:anywhere}.id{color:#657281;font-size:12px}summary{cursor:pointer;padding:8px 0;color:#9a3d00}.stats{font-variant-numeric:tabular-nums;color:#526170}.note{color:#995223}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;margin:8px 0;table-layout:fixed}th,td{text-align:left;vertical-align:top;border-bottom:1px solid #e3e7ec;padding:10px 8px;overflow-wrap:anywhere}th{color:#62717e;font-size:12px;font-weight:600}td small{display:block;color:#637281}a{color:#925000}footer{display:flex;align-items:center;gap:14px;padding:20px 0}#empty{padding:24px 0} @media(max-width:600px){header,main{padding:16px}.conditions{grid-template-columns:1fr;gap:6px}table{min-width:680px}h1{font-size:21px}}
</style>
<header><h1>测试条件重复与取整核对</h1><p id="overview"></p>
<p>仅比较同一基准、同一模型及相同已记录运行配置的原始分数。重复来源先去重；空配置表示未记录配置，不能据此认定实际运行方式相同。</p>
<p>原阈值：至少 2 条完全重复，且占任一条件去重后分数的至少 75%。已确定合并的同组条件不重复出现在取整清单，近似差异仍保留在其明细里。仅达到数值阈值而未确定合并的配对仍列出。取整检查包含保留 0～5 位小数的四舍五入及向下取整。</p>
<p id="execution"><strong>本报告未执行合并。</strong>达到数值阈值仍需核对指标、数据集、pass@k 等语义；不同计分规则和模型分数冲突会在条目中标出。</p><details id="applied" hidden><summary>查看本轮已合并的条件</summary><div id="applied-list"></div></details></header>
<main><div class="controls"><select id="filter" aria-label="候选类别">
<option value="all">全部剩余候选配对</option><option value="no-semantic-conflict">未检出明确字段差异的疑似配对</option>
<option value="rounding">全部疑似四舍五入 / 向下取整</option><option value="nontrivial">疑似取整：排除仅有 0～1 取整的弱证据</option><option value="exact-threshold">完全重复达到原阈值</option><option value="partial-exact">至少 2 条重复但不足 75%</option><option value="single-exact">仅 1 条完全重复</option></select>
<input id="search" type="search" placeholder="搜索基准、条件 ID / 名称或模型" aria-label="搜索核对清单"><span id="count" role="status"></span></div>
<div id="pairs"></div><p id="empty" hidden>没有符合当前筛选的配对。</p><footer><button id="previous">上一页</button><span id="page"></span><button id="next">下一页</button></footer></main>
<script type="application/json" id="data">${json}</script>
<script>
const D=JSON.parse(document.getElementById('data').textContent);
const C=new Map(D.conditions.map(c=>[Number(c.ID),c]));
const F=new Map(D.fields.map(f=>[Number(f.ID),f]));
const O=new Map(D.options.map(o=>[Number(o.ID),o]));
const $=id=>document.getElementById(id);
function el(tag,text,className){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n}
function config(s){return s.fields.length?s.fields.map(v=>{const f=F.get(v.fieldID);return f.name+' = '+(v.value===null?'存在 / 空值':f.type==='enum'?O.get(v.value)?.label??String(v.value):String(v.value))}).join('; '):'未记录运行配置'}
function sampleCell(s){const cell=el('td');cell.append(el('strong',s.score),el('small','条件 #'+s.conditionID),el('small','分数记录 '+s.resultIDs.join(', ')));s.sources.forEach((url,i)=>{try{const u=new URL(url);if(!['http:','https:'].includes(u.protocol))return;const a=el('a','来源 '+(i+1));a.href=u.href;a.target='_blank';a.rel='noopener noreferrer';cell.append(a,document.createTextNode(' '))}catch{}});return cell}
function evidenceRow(first,second,reason){const a=D.samples[first],b=D.samples[second],row=el('tr'),model=el('td');model.append(el('strong',a.modelName),el('small','模型 #'+a.modelID),el('small',config(a)));row.append(model,sampleCell(a),sampleCell(b),el('td',reason));return row}
const s=D.summary;$('overview').textContent='快照 '+D.snapshotTime+' | '+s.conditions+' 个条件 | '+s.rawResults+' 条分数 | 来源去重后 '+s.distinctSamples+' 条 | 待核对取整配对 '+s.roundingReview+' 组';
if(D.execution){const e=D.execution;$('execution').textContent='已写入生产数据库：活跃条件 '+e.before.conditions+' → '+e.after.conditions+'；迁移 '+e.moved+' 条分数；数据库分数总数保持 '+e.after.results+' 条。以下是合并后的全量剩余候选，已合并组内的疑似取整不再重复列出。明显不同指标、题目或版本的配对仅作复核，不自动合并。';$('applied').hidden=false;for(const g of D.appliedGroups){const item=el('p');item.textContent=g.benchmarkName+'：'+g.sources.map(s=>'#'+s.ID+' '+s.name).join('；')+' → #'+g.targetID+' '+g.targetName;$('applied-list').append(item)}}
let currentPage=0;const pageSize=30;
const searchable=D.pairs.map(p=>[p.benchmarkName,...p.conditionIDs.map(id=>C.get(id).name+' '+id),...p.exact.map(x=>D.samples[x[0]].modelName),...p.rounding.map(x=>D.samples[x.precise].modelName)].join(' ').toLowerCase());
function render(){const term=$('search').value.trim().toLowerCase(),filter=$('filter').value;const matches=D.pairs.filter((p,i)=>(filter==='all'||filter==='no-semantic-conflict'&&!p.semanticDifferences.length||filter==='rounding'&&p.roundingNeedsReview||filter==='nontrivial'&&p.roundingNeedsReview&&p.nonTrivialRoundingCount>0||filter===p.category)&&(!term||searchable[i].includes(term)));if(filter==='rounding'||filter==='nontrivial')matches.sort((a,b)=>Number(b.nonTrivialRoundingCount>0)-Number(a.nonTrivialRoundingCount>0)||b.roundingModelCount-a.roundingModelCount||b.rounding.length-a.rounding.length);const pages=Math.max(1,Math.ceil(matches.length/pageSize));currentPage=Math.min(currentPage,pages-1);$('pairs').replaceChildren();$('count').textContent=matches.length+' 组配对';$('empty').hidden=matches.length>0;
for(const p of matches.slice(currentPage*pageSize,(currentPage+1)*pageSize)){const block=el('section',undefined,'pair');block.append(el('h2',p.benchmarkName));const names=el('div',undefined,'conditions');p.conditionIDs.forEach((id,i)=>{const c=C.get(id),n=el('div',undefined,'condition');n.append(el('div',c.name),el('div','#'+id+' / '+p.counts[i]+' 条去重分数','id'));names.append(n)});block.append(names,el('p','完全重复 '+p.exactMatchCount+' 条（'+p.exactModelCount+' 个模型），覆盖较小条件 '+(p.exactCoverage*100).toFixed(1)+'%；疑似取整 '+p.rounding.length+' 对。','stats'));
const notes=[];if(p.rounding.length&&!p.nonTrivialRoundingCount)notes.push('弱证据：仅涉及绝对值小于 1 的分数取整为 0、1 或 -1，巧合概率较高');if(!p.sameScale)notes.push('计分规则不一致');if(p.conflictingConfigs)notes.push(p.conflictingConfigs+' 个共同模型配置的分数完全不重合');if(p.differingConfigs)notes.push(p.differingConfigs+' 个共同模型配置的分数集合有差异');if(p.exactThresholdMet&&p.exactModelCount<2)notes.push('重复证据不足 2 个独立模型');if(notes.length)block.append(el('p',notes.join('；'),'note'));
if(p.semanticDifferences.length)block.append(el('p','条件含义不同：'+p.semanticDifferences.map(d=>d.key+'：'+d.left+' / '+d.right).join('；'),'note'));
const details=el('details'),summary=el('summary','查看全部分数、配置和来源');details.append(summary);details.addEventListener('toggle',()=>{if(!details.open||details.dataset.loaded)return;details.dataset.loaded='true';const wrap=el('div',undefined,'table-wrap'),table=el('table'),head=el('tr');['模型 / 已记录配置','原始分数 A（取整时为较精细值）','原始分数 B（取整时为较粗值）','对应关系'].forEach(t=>head.append(el('th',t)));const thead=el('thead');thead.append(head);table.append(thead);const tbody=el('tbody');for(const r of p.rounding)tbody.append(evidenceRow(r.precise,r.rounded,'保留 '+r.precision+' 位小数：'+r.methods.map(m=>m==='round'?'四舍五入':'向下取整').join(' / ')));for(const [a,b]of p.exact)tbody.append(evidenceRow(a,b,'完全相同'));table.append(tbody);wrap.append(table);details.append(wrap)});block.append(details);$('pairs').append(block)}
$('page').textContent=(currentPage+1)+' / '+pages;$('previous').disabled=currentPage===0;$('next').disabled=currentPage+1===pages}
$('filter').addEventListener('change',()=>{currentPage=0;render()});$('search').addEventListener('input',()=>{currentPage=0;render()});$('previous').addEventListener('click',()=>{currentPage--;render()});$('next').addEventListener('click',()=>{currentPage++;render()});render();
</script></html>`;
}
