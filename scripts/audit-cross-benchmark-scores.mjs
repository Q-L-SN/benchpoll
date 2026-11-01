import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { auditCrossBenchmarkScores } from '../cross-benchmark-score-audit.js';

const [input, prefix] = process.argv.slice(2);
if (!input || !prefix || process.argv.length !== 4) {
    throw new Error('Usage: node scripts/audit-cross-benchmark-scores.mjs <snapshot.json.gz> <output-prefix>');
}
const bytes = await readFile(input);
const snapshot = JSON.parse(input.endsWith('.gz') ? gunzipSync(bytes).toString('utf8') : bytes.toString('utf8'));
let lastProgress = Date.now();
const report = auditCrossBenchmarkScores(snapshot, { onProgress(progress) {
    if (Date.now() - lastProgress >= 15000 || progress.visited === progress.total) {
        console.log(JSON.stringify(progress));
        lastProgress = Date.now();
    }
} });
report.source = input;
report.snapshotSHA256 = createHash('sha256').update(bytes).digest('hex');
report.rules = {
    nameSimilarity: '1 - Levenshtein distance / maximum name length; NFKC, case folding, letters and numbers only; numeric versions preserved; no transitive grouping',
    high: '>70%', medium: '30%-60% inclusive', excluded: '<30%, >60% through 70% inclusive',
    scores: 'Same model and same recorded configuration. Source duplicates consolidated. Existing effective-decimal precision rules applied to exact matches and round/floor witnesses.',
    semantics: 'Different scale or conflicting shared key=value facets are flagged. Absence of detected conflict is not proof of equivalent benchmarks; benchmark names, free text, protocols, subsets and versions require review.',
    scope: 'All stored conditions and score statuses, including archived and superseded. No active-condition filter. No database changes.'
};
await mkdir(dirname(prefix), { recursive: true });
await writeFile(`${prefix}.json`, JSON.stringify(report));
await writeFile(`${prefix}.html`, render(report));
console.log(JSON.stringify({ ...report.summary, json: `${prefix}.json`, html: `${prefix}.html` }, null, 2));

function render(data) {
    const embedded = JSON.stringify(data).replaceAll('<', '\\u003c');
    return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>跨基准分数筛选</title><style>
*{box-sizing:border-box}body{margin:0;color:#202a35;background:#fff;font:14px/1.6 system-ui,sans-serif}header,main{max-width:1300px;margin:auto;padding:24px}h1{font-size:24px;margin:0 0 12px}h2{font-size:17px;margin:0 0 8px}p{margin:7px 0}small,.muted{color:#677482}nav{position:sticky;top:0;background:#fff;border-block:1px solid #ddd;padding:12px 0;display:flex;gap:10px;flex-wrap:wrap;z-index:1}input,select,button{font:inherit;border:1px solid #cbd2d9;border-radius:4px;padding:7px 10px;background:white;color:inherit}input{flex:1;min-width:180px}button,summary{cursor:pointer}button:disabled{opacity:.4}section{padding:20px 0;border-bottom:1px solid #ddd}.names{display:grid;grid-template-columns:1fr 1fr;gap:20px;overflow-wrap:anywhere}.warning{color:#a33e18}summary,a{color:#945000}.table{overflow:auto}table{border-collapse:collapse;width:100%;min-width:600px}th,td{padding:10px;text-align:left;vertical-align:top;border-bottom:1px solid #ddd;overflow-wrap:anywhere}td small{display:block}footer{display:flex;gap:15px;align-items:center;padding:20px 0}@media(max-width:650px){header,main{padding:14px}.names{grid-template-columns:1fr;gap:8px}}
</style><header><h1>跨基准分数筛选</h1><p id="overview"></p>
<p>名称先统一大小写、空格与标点，保留版本号；相似度 = 1 − 编辑距离 / 较长名称长度。超过 70% 与 30%–60% 分开筛选；其余区间跳过。每对独立比较，不传递归组。</p>
<p>分数沿用有效小数位规则，仅匹配同一模型及相同已记录配置；包含历史归档记录。数值通过且未检出字段冲突，仍需核对基准版本、子集与测试协议。此报告没有执行合并。</p></header>
<main><nav><select id="filter" aria-label="筛选范围"><option value="high">超过 70%：通过数值且无已检出冲突</option><option value="medium">30%–60%：通过数值且无已检出冲突</option><option value="high-all">超过 70%：全部数值通过</option><option value="medium-all">30%–60%：全部数值通过</option><option value="blocked">数值通过，但尺度或条件字段不同</option><option value="report">未达到数值规则的其他证据</option><option value="all">全部非忽略候选</option></select><input id="search" type="search" placeholder="搜索基准、条件、模型或编号" aria-label="搜索"><span id="count"></span></nav><div id="rows"></div><footer><button id="prev">上一页</button><span id="page"></span><button id="next">下一页</button></footer></main>
<script type="application/json" id="data">${embedded}</script><script>
const D=JSON.parse(document.getElementById('data').textContent),C=new Map(D.conditions.map(c=>[Number(c.ID),c])),F=new Map(D.fields.map(f=>[Number(f.ID),f])),O=new Map(D.options.map(o=>[Number(o.ID),o]));const $=id=>document.getElementById(id);let page=0;
function el(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n}
const s=D.summary;$('overview').textContent='快照 '+D.snapshotTime+' | '+s.benchmarks+' 个基准 | 高相似名称配对 '+s.highNamePairs+' 组 | 中相似名称配对 '+s.mediumNamePairs+' 组 | 数值通过 '+s.numericalPassPairs+' 组条件';
function config(x){return x.fields.length?x.fields.map(v=>{const f=F.get(v.fieldID);return f.name+' = '+(v.value===null?'存在 / 空值':f.type==='enum'?O.get(Number(v.value))?.label??String(v.value):String(v.value))}).join('; '):'未记录配置'}
function cell(x){const n=el('td');n.append(el('strong',x.score),el('small','条件 #'+x.conditionID+' / 分数 #'+x.resultIDs.join(', ')));for(const source of x.sources){try{const url=new URL(source);if(!['http:','https:'].includes(url.protocol))continue;const a=el('a','来源');a.href=url.href;a.target='_blank';a.rel='noopener noreferrer';n.append(a,document.createTextNode(' '))}catch{}}return n}
function evidence(tbody,a,b,reason){const x=D.samples[a],y=D.samples[b],tr=el('tr'),model=el('td');model.append(el('strong',x.modelName),el('small',config(x)));tr.append(model,cell(x),cell(y),el('td',reason));tbody.append(tr)}
function draw(){const mode=$('filter').value,q=$('search').value.trim().toLowerCase();const found=D.pairs.filter(p=>{const pass=p.precision.verdict==='merge';const match=mode==='all'||mode==='high'&&pass&&p.noDetectedConflict&&p.nameBand==='high'||mode==='medium'&&pass&&p.noDetectedConflict&&p.nameBand==='medium'||mode==='high-all'&&pass&&p.nameBand==='high'||mode==='medium-all'&&pass&&p.nameBand==='medium'||mode==='blocked'&&pass&&!p.noDetectedConflict||mode==='report'&&!pass;if(!match)return false;const models=[...p.exact.map(x=>D.samples[x[0]].modelName),...p.rounding.map(x=>D.samples[x.precise].modelName)];return !q||[...p.benchmarkNames,...p.benchmarkIDs,...p.conditionIDs.map(id=>id+' '+C.get(id).name),...models].join(' ').toLowerCase().includes(q)});const pages=Math.max(1,Math.ceil(found.length/40));page=Math.min(page,pages-1);$('count').textContent=found.length+' 组条件';$('rows').replaceChildren();
for(const p of found.slice(page*40,(page+1)*40)){const box=el('section');box.append(el('h2',p.benchmarkNames.join(' / ')+' ('+(p.nameSimilarity*100).toFixed(1)+'%)'));const names=el('div',undefined,'names');p.conditionIDs.forEach((id,i)=>{const c=C.get(id),n=el('div');n.append(el('strong',p.benchmarkNames[i]+' #'+p.benchmarkIDs[i]),el('div',c.name),el('small','条件 #'+id+' / '+p.counts[i]+' 条去重分数'+(c.deleted_at?' / 已删除历史条件':'')));names.append(n)});box.append(names,el('p','完全重复 '+p.exactMatchCount+' 对，涉及 '+p.exactModelCount+' 个模型；较小条件覆盖 '+(p.exactCoverage*100).toFixed(1)+'%；疑似取整 '+p.rounding.length+' 对；共同配置分数不重合 '+p.conflictingConfigs+' 组。','muted'));
if(p.nameNumbersDiffer)box.append(el('p','名称中的数字或版本号不同，需核对。','warning'));if(!p.sameScale)box.append(el('p','计分尺度不同。','warning'));if(p.semanticDifferences.length)box.append(el('p',p.semanticDifferences.map(d=>d.key+': '+d.left+' / '+d.right).join('; '),'warning'));
const details=el('details'),summary=el('summary','查看 '+(p.exact.length+p.rounding.length)+' 对分数及原始来源');details.append(summary);details.addEventListener('toggle',()=>{if(!details.open||details.dataset.loaded)return;details.dataset.loaded='1';const wrap=el('div',undefined,'table'),table=el('table'),thead=el('thead'),tr=el('tr');['模型 / 配置','分数 A（取整时为精细值）','分数 B（取整时为较粗值）','证据'].forEach(x=>tr.append(el('th',x)));thead.append(tr);table.append(thead);const tbody=el('tbody');for(const [a,b] of p.exact)evidence(tbody,a,b,'完全相同');for(const r of p.rounding)evidence(tbody,r.precise,r.rounded,'保留 '+r.precision+' 位：'+r.methods.map(x=>x==='round'?'四舍五入':'向下取整').join(' / '));table.append(tbody);wrap.append(table);details.append(wrap)});box.append(details);$('rows').append(box)}
$('page').textContent=(page+1)+' / '+pages;$('prev').disabled=page===0;$('next').disabled=page+1===pages}
$('search').oninput=()=>{page=0;draw()};$('filter').onchange=()=>{page=0;draw()};$('prev').onclick=()=>{page--;draw()};$('next').onclick=()=>{page++;draw()};draw();
</script></html>`;
}
