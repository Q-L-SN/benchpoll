#!/usr/bin/env node

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { filterConditionPairs } from '../condition-precision-filter.js';

const [inputPath, outputPrefix] = process.argv.slice(2);
if (!inputPath || !outputPrefix || process.argv.length !== 4) {
    throw new Error('Usage: node scripts/filter-condition-score-overlap.mjs <audit.json> <output-prefix>');
}

const audit = JSON.parse(await readFile(inputPath, 'utf8'));
const { summary, rows } = filterConditionPairs(audit);
const conditions = new Map(audit.conditions.map(row => [Number(row.ID), row]));
const pairByKey = new Map(audit.pairs.map(pair => [pair.conditionIDs.join(':'), pair]));
const detail = rows.filter(row => row.verdict !== 'ignore').map(row => {
    const pair = pairByKey.get(row.conditionIDs.join(':'));
    const names = row.conditionIDs.map(id => conditions.get(Number(id))?.name);
    if (!pair || names.some(name => !name)) throw new Error(`Missing pair ${row.conditionIDs}`);
    return { ...row, names, exactMatches: pair.exactMatchCount,
        exactModels: pair.exactModelCount, exactCoverage: pair.exactCoverage,
        roundingMatches: pair.rounding.length,
        semanticReview: row.verdict === 'report' ? 'not-applicable'
            : row.sameScale && !row.semanticDifferences.length ? 'needed' : 'blocked' };
});
const semanticReviewCount = detail.filter(row => row.semanticReview === 'needed').length;
const output = { version: 1, source: inputPath, snapshotTime: audit.snapshotTime,
    generatedAt: new Date().toISOString(),
    rule: 'Effective decimal places exclude trailing zeros. A pair merges on any matching or rounding score witness satisfying the specified precision and magnitude thresholds; numeric eligibility is not semantic equivalence.',
    summary: { ...summary, needsSemanticReview: semanticReviewCount },
    verdicts: rows.map(row => [row.conditionIDs[0], row.conditionIDs[1], row.verdict]),
    detail };
await mkdir(dirname(outputPrefix), { recursive: true });
await writeFile(`${outputPrefix}.json`, JSON.stringify(output));
await writeFile(`${outputPrefix}.html`, renderHTML(output));
console.log(JSON.stringify({ ...output.summary, json: `${outputPrefix}.json`,
    html: `${outputPrefix}.html` }, null, 2));

function renderHTML(report) {
    const data = JSON.stringify(report.detail).replaceAll('<', '\\u003c');
    return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>条件精度筛选报告</title><style>
*{box-sizing:border-box}body{margin:0;color:#1a2735;background:#fff;font:14px/1.5 system-ui,sans-serif}header,main{max-width:1280px;margin:auto;padding:20px}h1{font-size:23px;margin:0 0 8px}p{margin:6px 0;color:#536274}nav{position:sticky;top:0;background:#fff;z-index:1;display:flex;flex-wrap:wrap;gap:10px;padding:12px 0;border-block:1px solid #d9e0e6}input,select{font:inherit;padding:8px 10px;border:1px solid #c7d1d9;border-radius:4px;background:#fff}input{flex:1;min-width:220px}section{border-bottom:1px solid #d9e0e6;padding:14px 0}h2{font-size:16px;margin:0 0 6px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:14px;overflow-wrap:anywhere}.tag{color:#a54c00}.warning{color:#b53232}small{color:#637384}button{font:inherit;border:1px solid #c7d1d9;background:#fff;padding:7px 12px;cursor:pointer}@media(max-width:640px){header,main{padding:14px}.pair{grid-template-columns:1fr}}
</style><header><h1>条件精度筛选报告</h1><p>快照：${report.snapshotTime}。共 ${report.summary.total} 组配对；整数弱证据忽略 ${report.summary.ignore} 组；数值规则命中 ${report.summary.merge} 组；其余 ${report.summary.report} 组进入报告。</p>
<p>数值命中不代表同一测试：${report.summary.mergeWithExplicitSemanticDifference} 组明确有字段差异，${report.summary.mergeWithDifferentScale} 组计分尺度不同，${report.summary.needsSemanticReview} 组需逐项核对名称与协议。此报告本身不修改数据库。</p></header>
<main><nav><input type="search" id="search" placeholder="搜索基准、条件或编号"><select id="filter"><option value="all">全部未忽略配对</option><option value="report" selected>其余待报告</option><option value="needed">数值达标，待语义核对</option><option value="blocked">数值达标但有明显冲突</option></select><span id="count"></span></nav><div id="list"></div><p id="page"></p></main>
<script type="application/json" id="data">${data}</script><script>
const rows=JSON.parse(document.getElementById('data').textContent),list=document.getElementById('list'),search=document.getElementById('search'),filter=document.getElementById('filter'),count=document.getElementById('count'),page=document.getElementById('page');let current=0;
function add(parent,tag,value,cls){const node=document.createElement(tag);node.textContent=value;if(cls)node.className=cls;parent.append(node);return node}
function draw(){const text=search.value.trim().toLowerCase(),mode=filter.value;const found=rows.filter(row=>(mode==='all'||mode==='report'&&row.verdict==='report'||mode==='needed'&&row.semanticReview==='needed'||mode==='blocked'&&row.verdict==='merge'&&row.semanticReview==='blocked')&&(!text||[row.benchmarkName,...row.names,...row.conditionIDs].join(' ').toLowerCase().includes(text)));count.textContent=found.length+' 组';const max=Math.max(1,Math.ceil(found.length/100));current=Math.min(current,max-1);list.replaceChildren();for(const row of found.slice(current*100,(current+1)*100)){const section=add(list,'section','');add(section,'h2',row.benchmarkName);const pair=add(section,'div','','pair');for(let i=0;i<2;i++)add(pair,'div','#'+row.conditionIDs[i]+' '+row.names[i]);add(section,'p',row.verdict==='report'?'待报告':row.semanticReview==='needed'?'数值达标，尚未确认同一测试':'数值达标，但存在明显语义或尺度冲突',row.semanticReview==='blocked'?'warning':'tag');const witness=row.mergeEvidence??row.reportEvidence;if(witness)add(section,'small',witness.kind+' | 模型 #'+witness.modelID+' | '+witness.scores.join(' / ')+' | 完全重复 '+row.exactMatches+' | 疑似取整 '+row.roundingMatches);if(row.semanticDifferences.length)add(section,'p',row.semanticDifferences.map(x=>x.key+': '+x.left+' / '+x.right).join('; '),'warning')}page.replaceChildren();const prev=add(page,'button','上一页'),next=add(page,'button','下一页');prev.disabled=current===0;next.disabled=current+1===max;prev.onclick=()=>{current--;draw()};next.onclick=()=>{current++;draw()};add(page,'span','  '+(current+1)+' / '+max+'  ')}search.oninput=()=>{current=0;draw()};filter.onchange=()=>{current=0;draw()};draw();
</script></html>`;
}
