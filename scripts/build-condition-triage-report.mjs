#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';

const [input, output] = process.argv.slice(2);
if (!input || !output || process.argv.length !== 4) {
    throw new Error('Usage: node scripts/build-condition-triage-report.mjs <audit.json> <output.html>');
}
const audit = JSON.parse(await readFile(input, 'utf8'));
const conditions = new Map(audit.conditions.map(row => [Number(row.ID), row]));
const groups = new Map();
for (const pair of audit.pairs) {
    if (!pair.sameScale || pair.semanticDifferences.length) continue;
    const tags = [];
    if (pair.exactThresholdMet) tags.push('threshold');
    else if (pair.category === 'partial-exact' && pair.exactModelCount >= 2
        && !pair.conflictingConfigs) tags.push('partial');
    else if (pair.category === 'single-exact') tags.push('single');
    if (pair.roundingNeedsReview && pair.nonTrivialRoundingCount > 0) tags.push('rounding');
    if (!tags.length) continue;
    const [left, right] = pair.conditionIDs.map(id => conditions.get(Number(id)));
    if (!left || !right) throw new Error(`Missing condition in pair ${pair.conditionIDs}`);
    const item = { benchmark: pair.benchmarkName, ids: pair.conditionIDs,
        names: [left.name, right.name], tags, exact: pair.exactMatchCount,
        models: pair.exactModelCount, coverage: pair.exactCoverage,
        rounding: pair.nonTrivialRoundingCount, conflicts: pair.conflictingConfigs,
        exactEvidence: pair.exact.slice(0, 12).map(([a, b]) => [audit.samples[a], audit.samples[b]]),
        roundingEvidence: pair.rounding.slice(0, 12).map(row =>
            [audit.samples[row.precise], audit.samples[row.rounded], row.methods]) };
    if (!groups.has(item.benchmark)) groups.set(item.benchmark, []);
    groups.get(item.benchmark).push(item);
}
const entries = [...groups].sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([, pairs]) => pairs.sort((a, b) => b.exact - a.exact || b.rounding - a.rounding));
const totals = Object.fromEntries(['threshold', 'partial', 'single', 'rounding']
    .map(tag => [tag, entries.filter(item => item.tags.includes(tag)).length]));
const data = JSON.stringify(entries).replaceAll('<', '\\u003c');
const html = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>BenchPoll condition review</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f7f8fa;color:#172130;font:14px/1.5 system-ui,sans-serif;letter-spacing:0}header,main{max-width:1200px;margin:auto;padding:24px}h1{font-size:24px;margin:0 0 8px}p{color:#526174}a{color:#bd5400}nav{display:flex;gap:10px;align-items:center;flex-wrap:wrap;border-block:1px solid #d8dee6;padding:12px 0;margin-top:16px}input,select{font:inherit;padding:8px 10px;border:1px solid #bcc5d0;border-radius:4px;background:#fff}input{flex:1;min-width:200px}section{padding:16px 0;border-bottom:1px solid #d8dee6}h2{font-size:16px;margin:0 0 8px}small{color:#667388}.names{display:grid;grid-template-columns:1fr 1fr;gap:20px;overflow-wrap:anywhere}.tags{color:#ac4800}details{margin-top:8px}summary{cursor:pointer;color:#40556d}.sample{padding:8px 0;border-top:1px solid #e2e6ec;overflow-wrap:anywhere}code{font-size:12px}footer{padding:20px 0;color:#667388}@media(max-width:650px){.names{grid-template-columns:1fr}header,main{padding:16px}}
</style>
<header><h1>Condition overlap review</h1><p>Numeric overlap is evidence for review, not proof that two tasks or configurations are equivalent. No remaining pair is approved for automatic merge.</p><p>${entries.length} pairs across ${groups.size} benchmarks. Threshold ${totals.threshold}; partial ${totals.partial}; single exact ${totals.single}; nontrivial rounding ${totals.rounding}. <a href="./statusless-post-merge.html">Full audit</a></p><nav><input id="search" type="search" placeholder="Search benchmark or condition"><select id="filter"><option value="all">All evidence</option><option value="threshold">Threshold</option><option value="partial">Partial exact</option><option value="single">Single exact</option><option value="rounding">Rounding</option></select><span id="count"></span></nav></header>
<main id="results"></main><script type="application/json" id="data">${data}</script>
<script>
const rows=JSON.parse(document.getElementById('data').textContent),root=document.getElementById('results'),search=document.getElementById('search'),filter=document.getElementById('filter'),count=document.getElementById('count');
function item(parent,tag,value,cls){const node=document.createElement(tag);if(cls)node.className=cls;node.textContent=value;parent.append(node);return node}
function evidence(root,pairs,label){for(const row of pairs){const a=row[0],b=row[1];item(root,'div',label+': '+a.modelName+' / '+a.score+' vs '+b.score+'; '+JSON.stringify(a.fields)+'; '+a.sources.slice(0,2).join(', '),'sample')}}
function draw(){const term=search.value.trim().toLowerCase(),mode=filter.value,matched=rows.filter(row=>(mode==='all'||row.tags.includes(mode))&&(!term||[row.benchmark,...row.names,...row.ids].join(' ').toLowerCase().includes(term)));count.textContent=matched.length+' pairs';root.replaceChildren();for(const row of matched.slice(0,200)){const section=item(root,'section','');item(section,'h2',row.benchmark);const names=item(section,'div','','names');for(let i=0;i<2;i++)item(names,'div','#'+row.ids[i]+' '+row.names[i]+' ('+(i?'B':'A')+')');item(section,'div',row.tags.join(', ')+'; '+row.exact+' exact; '+row.models+' models; '+Math.round(row.coverage*100)+'% smaller-condition coverage; '+row.rounding+' rounding pairs','tags');const detail=item(section,'details',''),summary=item(detail,'summary','Show evidence');detail.addEventListener('toggle',()=>{if(!detail.open||detail.dataset.loaded)return;detail.dataset.loaded='1';evidence(detail,row.exactEvidence,'Exact');evidence(detail,row.roundingEvidence,'Rounding')})}if(matched.length>200)item(root,'footer','Showing first 200 matches. Narrow the search to inspect the rest.')}
search.addEventListener('input',draw);filter.addEventListener('change',draw);draw();
</script></html>`;
await writeFile(output, html);
console.log(JSON.stringify({ output, benchmarks: groups.size, pairs: entries.length, totals }));
